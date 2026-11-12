//! The till's rules a business varies, against a real PostgreSQL (the same database as `pos_it`,
//! reset first; cargo runs test binaries one after the other): limits by role, approval by another
//! person's PIN, voids with reasons, reprints, stored value, returns without a receipt and exchanges.

use ferrum_kernel::tenant::NewTenant;
use ferrum_kernel::{Ctx, Db, DbConfig, Doc, Error, HookRegistry, Kernel, KernelSettings, ListQuery, SiteRequest};
use ferrum_meta::Catalog;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use std::str::FromStr;
use std::sync::Arc;
use uuid::Uuid;

fn obj(v: Value) -> Doc {
    v.as_object().cloned().unwrap()
}

fn n(s: &str) -> Decimal {
    Decimal::from_str(s).unwrap()
}

fn dec(v: &Value) -> Decimal {
    match v {
        Value::String(s) => n(s),
        Value::Number(x) => n(&x.to_string()),
        _ => Decimal::ZERO,
    }
}

fn uid(doc: &Doc) -> Uuid {
    doc["id"].as_str().unwrap().parse().unwrap()
}

fn messages(e: &Error) -> String {
    match e {
        Error::Validation(v) => v.iter().map(|f| format!("{}: {}", f.field, f.message)).collect::<Vec<_>>().join("; "),
        other => format!("{other:?}"),
    }
}

struct T {
    k: Arc<Kernel>,
    tenant: Uuid,
    admin: Ctx,
}

impl T {
    async fn insert(&self, ctx: &Ctx, entity: &str, v: Value) -> Doc {
        self.k.insert(ctx, entity, obj(v)).await.unwrap_or_else(|e| panic!("insert {entity}: {e:?}"))
    }
    async fn sell(&self, ctx: &Ctx, v: Value) -> Doc {
        let d = self.insert(ctx, "PosInvoice", v).await;
        self.k.submit(ctx, "PosInvoice", uid(&d), None).await.unwrap_or_else(|e| panic!("submit: {e:?}"))
    }
    /// The error a sale meets, saving or submitting (a refused draft is dropped).
    async fn refused(&self, ctx: &Ctx, v: Value) -> Error {
        let d = match self.k.insert(ctx, "PosInvoice", obj(v)).await {
            Ok(d) => d,
            Err(e) => return e,
        };
        let e = self.k.submit(ctx, "PosInvoice", uid(&d), None).await.expect_err("the sale should be refused");
        self.k.delete(&self.admin, "PosInvoice", uid(&d), None).await.expect("drop the draft");
        e
    }
    async fn find_one(&self, entity: &str, filters: Value) -> Doc {
        let q = ListQuery { filters: ferrum_kernel::query::parse_filters(&filters).unwrap(), ..Default::default() };
        let page = self.k.list(&self.admin, entity, &q).await.unwrap();
        assert_eq!(page.rows.len(), 1, "{entity} {filters}");
        page.rows[0].clone()
    }
    async fn user(&self, email: &str, roles: &[&str]) -> Ctx {
        let roles: Vec<String> = roles.iter().map(|r| r.to_string()).collect();
        let id = self.k.create_user(&self.admin, email, email, Some("Correct-Horse-9"), &roles, false).await.expect("user");
        self.k.load_ctx(self.tenant, id, None, "it".into()).await.expect("ctx")
    }
    /// A request to the register's own endpoints.
    async fn site(&self, ctx: &Ctx, method: &str, path: &str, query: Value, body: Value) -> Result<Value, Error> {
        let req = SiteRequest {
            tenant: self.tenant,
            user: Some(ctx.clone()),
            method: method.into(),
            path: path.into(),
            query: query.as_object().cloned().unwrap_or_default(),
            headers: Default::default(),
            body: if body.is_null() { vec![] } else { serde_json::to_vec(&body).unwrap() },
            client_ip: "it".into(),
        };
        let res = ferrum_kernel::Site::handle(&ferrum_app_pos::site::PosSite, &self.k, req).await?;
        Ok(serde_json::from_slice(&res.body).unwrap_or(Value::Null))
    }
}

fn line(item: Uuid, qty: &str) -> Value {
    json!({"item": item.to_string(), "qty": qty})
}

fn pay(mode: &Doc, amount: &str) -> Value {
    json!({"mode_of_payment": mode["id"], "amount": amount})
}

#[test]
fn tier1() {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(16 << 20).build().unwrap();
    rt.block_on(async { tokio::spawn(scenario()).await.unwrap() });
}

async fn scenario() {
    let url = std::env::var("FERRUM_POS_TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://ferrum:ferrum@localhost:5432/ferrum_pos_test".into());
    let db = Db::connect(DbConfig { url, max_connections: 10, ..Default::default() }).await.expect("connect");
    sqlx::raw_sql("drop schema if exists public cascade; create schema public;").execute(&db.pool).await.expect("reset");
    let mut packages = ferrum_domain::packages().expect("platform packages");
    packages.extend(ferrum_app_erp::packages().expect("ERP's packages"));
    packages.extend(ferrum_app_pos::packages().expect("app packages"));
    let catalog = Catalog::from_packages(packages).expect("catalog");
    let mut hooks = HookRegistry::default();
    ferrum_domain::register(&mut hooks);
    ferrum_app_erp::register(&mut hooks);
    ferrum_app_pos::register(&mut hooks);
    let k = Kernel::boot(db, catalog, hooks, KernelSettings::default(), None).await.expect("boot");
    ferrum_domain::maintenance(&k).await.expect("partitions");
    ferrum_app_erp::maintenance(&k).await.expect("partitions");
    let tenant = k
        .create_tenant(NewTenant {
            slug: "shop".into(),
            name: "Corner Shop".into(),
            admin_email: "admin@shop.test".into(),
            admin_password: "Correct-Horse-9".into(),
            admin_name: None,
            packages: vec!["pos".into()],
            settings: Some(json!({"fiscal_year_start_month": 4})),
        })
        .await
        .expect("tenant");
    let session = k.login("shop", "admin@shop.test", "Correct-Horse-9").await.expect("login");
    let admin = k.load_ctx(tenant, session.user, Some(session.token_version), "it".into()).await.expect("ctx");
    let t = T { k: k.clone(), tenant, admin };
    let a = t.admin.clone();

    // ───────────── the shop ─────────────
    let inr = t.find_one("Currency", json!({"code": "INR"})).await;
    let company = t.insert(&a, "Company", json!({"company_name": "Corner Shop", "abbr": "CS", "default_currency": inr["id"]})).await;
    let cid = uid(&company);
    let output_tax = uid(&t.find_one("Account", json!({"account_name": "Output Tax", "company": cid.to_string()})).await);
    t.insert(
        &a,
        "TaxTemplate",
        json!({"title": "VAT 10%", "company": cid.to_string(), "kind": "Sales", "is_default": true,
               "rows": [{"charge_type": "On Net Total", "account": output_tax.to_string(), "description": "VAT 10%", "rate": "10"}]}),
    )
    .await;
    let stores = uid(&t.find_one("Warehouse", json!({"warehouse_name": "Stores", "company": cid.to_string()})).await);
    let products = t.find_one("ItemGroup", json!({"group_name": "Products"})).await;
    let nos = t.find_one("Uom", json!({"uom_name": "Nos"})).await;
    let selling = t.find_one("PriceList", json!({"price_list_name": "Standard Selling"})).await;
    let item = |code: &str| json!({"item_code": code, "item_name": code.to_lowercase(), "item_group": products["id"], "stock_uom": nos["id"]});
    let widget = uid(&t.insert(&a, "Item", item("WIDGET")).await);
    t.insert(&a, "ItemPrice", json!({"item": widget.to_string(), "price_list": selling["id"], "rate": "100", "valid_from": "2020-01-01"})).await;
    let opening = t
        .insert(
            &a,
            "StockEntry",
            json!({"company": cid.to_string(), "purpose": "Opening Stock",
                   "items": [{"item": widget.to_string(), "qty": "50", "basic_rate": "60", "target_warehouse": stores.to_string()}]}),
        )
        .await;
    t.k.submit(&a, "StockEntry", uid(&opening), None).await.expect("opening stock");
    let mode = |name: &'static str| {
        let t = &t;
        async move { t.find_one("ModeOfPayment", json!({"mode_name": name})).await }
    };
    let (cash, card) = (mode("Cash").await, mode("Card").await);
    let walk_in = uid(&t.find_one("Customer", json!({"customer_name": "Walk-in Customer"})).await);
    let counter = uid(&t
        .insert(
            &a,
            "PosProfile",
            json!({"profile_name": "Counter", "company": cid.to_string(), "warehouse": stores.to_string(), "price_list": selling["id"],
                   "customer": walk_in.to_string(), "invoice_prefix": "CT",
                   "payments": [{"mode_of_payment": cash["id"], "is_default": true, "allow_in_returns": true}, {"mode_of_payment": card["id"], "allow_in_returns": true}],
                   "allow_discount_change": true, "max_discount": "10"}),
        )
        .await);
    let cashier = t.user("cashier@shop.test", &["Cashier"]).await;
    let manager = t.user("manager@shop.test", &["POS Manager"]).await;
    let open = t.insert(&cashier, "PosOpeningEntry", json!({"pos_profile": counter.to_string()})).await;
    t.k.submit(&cashier, "PosOpeningEntry", uid(&open), None).await.expect("open the till");
    let sale = |items: Value, pays: Value| json!({"pos_profile": counter.to_string(), "items": items, "payments": pays});
    let off = |pct: &str, qty: &str| json!([{"item": widget.to_string(), "qty": qty, "discount_percent": pct}]);

    // ───────────── 1. limits by role ─────────────
    // No limits rows: the register's own 10% still holds, as before the upgrade.
    t.sell(&cashier, sale(off("10", "1"), json!([pay(&card, "99")]))).await;
    let e = t.refused(&cashier, sale(off("15", "1"), json!([pay(&card, "93.50")]))).await;
    assert!(messages(&e).contains("exceeds the 10% allowed"), "{e:?}");
    let limits = t.site(&cashier, "GET", "/limits", json!({"profile": counter.to_string()}), Value::Null).await.expect("limits");
    assert_eq!((dec(&limits["discount_percent"]), limits["void_sale"].clone()), (n("10"), json!(false)), "{limits}");
    let mine = t.site(&manager, "GET", "/limits", json!({"profile": counter.to_string()}), Value::Null).await.expect("limits");
    assert_eq!(mine["void_sale"], json!(true), "a manager without a row has no limit: {mine}");
    // A row for the role: up to 20% a line and 30 a sale, refunds up to 50.
    t.insert(&a, "PosRoleLimit", json!({"role": "Cashier", "discount_percent": "20", "discount_amount": "30", "refund_limit": "50"})).await;
    let fifteen = t.sell(&cashier, sale(off("15", "1"), json!([pay(&card, "93.50")]))).await;
    assert_eq!(dec(&fifteen["rounded_total"]), n("93.50"));
    let e = t.refused(&cashier, sale(off("15", "3"), json!([pay(&card, "280.50")]))).await;
    assert!(messages(&e).contains("discounts of 45 on this sale exceed the 30 allowed"), "{e:?}");
    // The register's own row wins over the row for every register.
    t.insert(&a, "PosRoleLimit", json!({"role": "Cashier", "pos_profile": counter.to_string(), "discount_percent": "5", "refund_limit": "50"})).await;
    let e = t.refused(&cashier, sale(off("10", "1"), json!([pay(&card, "99")]))).await;
    assert!(messages(&e).contains("exceeds the 5% allowed"), "{e:?}");
    // A return worth more than the refund limit.
    let back = json!({"pos_profile": counter.to_string(), "is_return": true, "return_against": fifteen["id"],
                      "items": [line(widget, "-1")], "payments": [pay(&card, "-93.50")]});
    let e = t.refused(&cashier, back.clone()).await;
    assert!(messages(&e).contains("more than the 50 you may give"), "{e:?}");

    // ───────────── 2. approval by another person's PIN, voids with reasons ─────────────
    let profile = counter.to_string();
    let ask = |who: &str, pin: &str, action: &str, amount: Option<&str>| json!({"profile": profile, "approver": who, "pin": pin, "action": action, "amount": amount, "reason": "regular customer"});
    let no_pin = t.site(&cashier, "POST", "/approve", Value::Null, ask("manager@shop.test", "4321", "Discount", Some("15"))).await;
    assert!(no_pin.is_err(), "no PIN set yet");
    t.site(&manager, "POST", "/pin", Value::Null, json!({"pin": "12"})).await.expect_err("a PIN is four to twelve digits");
    t.site(&manager, "POST", "/pin", Value::Null, json!({"pin": "4321"})).await.expect("set a PIN");
    let wrong = t.site(&cashier, "POST", "/approve", Value::Null, ask("manager@shop.test", "1111", "Discount", Some("15"))).await;
    assert!(matches!(wrong, Err(Error::Invalid(ref m)) if m.contains("does not match")), "{wrong:?}");
    let own = t.site(&manager, "POST", "/approve", Value::Null, ask("manager@shop.test", "4321", "Discount", Some("15"))).await;
    assert!(own.is_err(), "nobody approves their own act");
    let ok = t.site(&cashier, "POST", "/approve", Value::Null, ask("manager@shop.test", "4321", "Discount", Some("15"))).await.expect("approved");
    let approval = ok["approval"].as_str().unwrap().to_string();
    let mut with = sale(off("15", "1"), json!([pay(&card, "93.50")]));
    with["approvals"] = json!([{"approval": approval}]);
    let approved = t.sell(&cashier, with.clone()).await;
    assert_eq!(approved["approvals"][0]["approver"], json!("manager@shop.test"), "the sale keeps who approved it");
    let used = t.find_one("PosApproval", json!({"id": approval})).await;
    assert_eq!(used["used_for"], approved["id"]);
    let again = t.refused(&cashier, with).await;
    assert!(messages(&again).contains("exceeds the 5% allowed") || messages(&again).contains("already used"), "used once: {again:?}");
    let mut more = sale(off("20", "1"), json!([pay(&card, "88")]));
    let ok = t.site(&cashier, "POST", "/approve", Value::Null, ask("manager@shop.test", "4321", "Discount", Some("15"))).await.expect("approved");
    more["approvals"] = json!([{"approval": ok["approval"]}]);
    assert!(messages(&t.refused(&cashier, more).await).contains("exceeds"), "approved for 15%, not 20%");
    // The refund over the cashier's 50, approved for up to 100.
    let ok = t.site(&cashier, "POST", "/approve", Value::Null, ask("manager@shop.test", "4321", "Refund", Some("100"))).await.expect("approved");
    let mut back = back;
    back["approvals"] = json!([{"approval": ok["approval"]}]);
    t.sell(&cashier, back).await;
    // Someone whose own limits do not reach cannot approve.
    let colleague = t.user("colleague@shop.test", &["Cashier"]).await;
    t.site(&colleague, "POST", "/pin", Value::Null, json!({"pin": "2468"})).await.expect("PIN");
    let weak = t.site(&cashier, "POST", "/approve", Value::Null, ask("colleague@shop.test", "2468", "Void Sale", None)).await;
    assert!(matches!(weak, Err(Error::Forbidden(ref m)) if m.contains("may not approve")), "{weak:?}");
    // Voided lines carry one of the business's reasons.
    let scanned = t.find_one("PosReason", json!({"reason": "Scanned in error"})).await;
    let faulty = t.find_one("PosReason", json!({"reason": "Faulty"})).await;
    let mut voids = sale(json!([line(widget, "1")]), json!([pay(&card, "110")]));
    voids["voided_lines"] = json!([{"item": widget.to_string(), "qty": "1", "amount": "110", "reason": faulty["id"]}]);
    let e = messages(&t.refused(&cashier, voids.clone()).await);
    assert!(e.contains("reason"), "{e}");
    voids["voided_lines"][0]["reason"] = scanned["id"].clone();
    let kept = t.sell(&cashier, voids).await;
    // Voiding a whole sale is beyond a cashier: refused alone, done with an approval, with why.
    let params = json!({"reason": scanned["id"]});
    let alone = t.k.run_action(&cashier, "PosInvoice", uid(&kept), "void", params.clone()).await;
    assert!(matches!(alone, Err(Error::Forbidden(_))), "{alone:?}");
    let ok = t.site(&cashier, "POST", "/approve", Value::Null, ask("manager@shop.test", "4321", "Void Sale", None)).await.expect("approved");
    let mut params = params;
    params["approval"] = ok["approval"].clone();
    t.k.run_action(&cashier, "PosInvoice", uid(&kept), "void", params).await.expect("voided");
    let voided = t.find_one("PosInvoice", json!({"id": kept["id"]})).await;
    assert_eq!(
        (voided["status"].clone(), voided["void_reason"].clone(), voided["voided_by"].clone()),
        (json!("Cancelled"), scanned["id"].clone(), json!("cashier@shop.test"))
    );
    // Five wrong tries lock the PIN, the right one included, for a while; nothing keeps the PIN itself.
    for _ in 0..5 {
        let _ = t.site(&cashier, "POST", "/approve", Value::Null, ask("manager@shop.test", "0000", "Discount", Some("15"))).await;
    }
    let locked = t.site(&cashier, "POST", "/approve", Value::Null, ask("manager@shop.test", "4321", "Discount", Some("15"))).await;
    assert!(matches!(locked, Err(Error::TooManyRequests(_))), "{locked:?}");
    let mut tx = t.k.db.tenant_tx(tenant).await.unwrap();
    let (hash, leaked): (String, bool) = sqlx::query_as(
        "select pin_hash, exists(select 1 from e_pos_approval a where a.tenant_id = $1 and to_jsonb(a)::text like '%4321%') from pos_staff_pin where tenant_id = $1 and email = 'manager@shop.test'",
    )
    .bind(tenant)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert!(hash.starts_with("$argon2id$") && !leaked, "{hash}");
    drop(tx);

    // ───────────── 4. stored value at the till ─────────────
    let current = uid(&t.find_one("Account", json!({"account_name": "Current Liabilities", "company": cid.to_string()})).await);
    let owed = t
        .insert(
            &a,
            "Account",
            json!({"account_name": "Gift Cards", "company": cid.to_string(), "parent_account": current.to_string(), "root_type": "Liability"}),
        )
        .await;
    let gift = t
        .insert(
            &a,
            "StoredValueKind",
            json!({"kind_name": "Gift Card", "company": cid.to_string(), "liability_account": owed["id"], "tax_charged": "When Redeemed"}),
        )
        .await;
    let mut card_item = item("GIFT");
    card_item["is_stock_item"] = json!(false);
    card_item["stored_value_kind"] = gift["id"].clone();
    let card_item = uid(&t.insert(&a, "Item", card_item).await);
    t.insert(&a, "ItemPrice", json!({"item": card_item.to_string(), "price_list": selling["id"], "rate": "500", "valid_from": "2020-01-01"})).await;
    let giftcard = t
        .insert(&a, "ModeOfPayment", json!({"mode_name": "Gift Card", "mode_type": "Stored Value", "stored_value_kind": gift["id"], "offline_limit": "20"}))
        .await;
    t.k.update(
        &a,
        "PosProfile",
        counter,
        obj(json!({"payments": [{"mode_of_payment": cash["id"], "is_default": true, "allow_in_returns": true}, {"mode_of_payment": card["id"], "allow_in_returns": true},
                                {"mode_of_payment": giftcard["id"], "allow_in_returns": true}]})),
        None,
    )
    .await
    .expect("the register takes gift cards");
    let balance = |code: &'static str| {
        let t = &t;
        async move {
            let mut tx = t.k.db.tenant_tx(t.tenant).await.unwrap();
            let sec = ferrum_app_erp::stored_value::secret(t.tenant, code, None).unwrap();
            let b: Decimal = sqlx::query_scalar("select coalesce(balance, 0) from e_stored_value_account where tenant_id = $1 and code_hash = $2")
                .bind(t.tenant)
                .bind(sec.hash)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            b
        }
    };
    // Sold at the till: the card is loaded when the sale is submitted, through its own invoice.
    let sold = t
        .sell(&cashier, sale(json!([{"item": card_item.to_string(), "qty": "1", "stored_value_code": "GIFT-0000-0000-0001"}]), json!([pay(&cash, "500")])))
        .await;
    assert_eq!((sold["invoiced_at_sale"].clone(), sold["items"][0]["stored_value_code"].clone()), (json!(true), json!("••••0001")), "{sold:?}");
    assert!(sold["consolidated_invoice"].is_string());
    assert_eq!(balance("GIFT-0000-0000-0001").await, n("500"), "spendable at once");
    let told = t.site(&cashier, "POST", "/balance", Value::Null, json!({"mode": giftcard["id"], "code": "GIFT-0000-0000-0001"})).await.expect("balance");
    assert_eq!((dec(&told["balance"]), told["state"].clone()), (n("500"), json!("Active")), "{told}");
    // Taken as a tender, in part: the balance left is on the payment row.
    let mut by_card = pay(&giftcard, "110");
    by_card["stored_value_code"] = json!("gift 0000 0000 0001");
    let paid = t.sell(&cashier, sale(json!([line(widget, "1")]), json!([by_card.clone()]))).await;
    assert_eq!(dec(&paid["payments"][0]["stored_value_balance"]), n("390"), "{paid:?}");
    assert!(paid["payments"][0]["stored_value_payment"].is_string());
    let mut wrong = by_card.clone();
    wrong["stored_value_code"] = json!("GIFT-0000-0000-0009");
    assert!(t.k.insert(&cashier, "PosInvoice", obj(sale(json!([line(widget, "1")]), json!([wrong])))).await.is_err(), "an unknown code");
    // The rest of it, then an offline sale it no longer covers: written off and recorded.
    let mut rest = by_card.clone();
    rest["amount"] = json!("390");
    t.sell(&cashier, sale(json!([line(widget, "4")]), json!([rest, pay(&cash, "50")]))).await;
    assert_eq!(balance("GIFT-0000-0000-0001").await, Decimal::ZERO);
    let mut offline_card = by_card.clone();
    offline_card["amount"] = json!("30");
    let mut late = sale(json!([line(widget, "1")]), json!([offline_card, pay(&cash, "80")]));
    late["sold_offline"] = json!(true);
    assert!(messages(&t.refused(&cashier, late.clone()).await).contains("offline up to 20"));
    late["payments"][0]["amount"] = json!("20");
    late["payments"][1]["amount"] = json!("90");
    let late = t.sell(&cashier, late).await;
    assert_eq!(dec(&late["write_off_amount"]), n("20"), "{late:?}");
    let short = t.find_one("PosStockShortfall", json!({"pos_invoice": late["id"]})).await;
    assert_eq!(dec(&short["amount_short"]), n("20"));
    // Refunded onto the card it was paid with (a manager, in their own session; the sale is invoiced).
    let mopen = t.insert(&manager, "PosOpeningEntry", json!({"pos_profile": counter.to_string()})).await;
    t.k.submit(&manager, "PosOpeningEntry", uid(&mopen), None).await.expect("manager's session");
    let mut onto = pay(&giftcard, "-110");
    onto["stored_value_code"] = json!("GIFT-0000-0000-0001");
    let cash_back = json!({"pos_profile": counter.to_string(), "is_return": true, "return_against": paid["id"], "items": [line(widget, "-1")], "payments": [pay(&cash, "-110")]});
    assert!(messages(&t.refused(&manager, cash_back).await).contains("cash or to cards"), "a card's money never comes back as cash");
    let back = t
        .sell(
            &manager,
            json!({"pos_profile": counter.to_string(), "is_return": true, "return_against": paid["id"], "items": [line(widget, "-1")], "payments": [onto]}),
        )
        .await;
    assert_eq!(back["invoiced_at_sale"], json!(true));
    assert_eq!(balance("GIFT-0000-0000-0001").await, n("110"));
    // A sale invoiced when the cashier asks (a customer's tax invoice now), not again at closing.
    let mut now = sale(json!([line(widget, "1")]), json!([pay(&card, "110")]));
    now["invoice_now"] = json!(true);
    let now = t.sell(&cashier, now).await;
    assert_eq!(now["invoiced_at_sale"], json!(true));
    let si = now["consolidated_invoice"].clone();
    // The day closes: invoiced sales are only settled, and the cards agree with the books.
    let close = t.insert(&cashier, "PosClosingEntry", json!({"pos_opening_entry": open["id"]})).await;
    t.k.submit(&manager, "PosClosingEntry", uid(&close), None).await.expect("close the day");
    let mut tx = t.k.db.tenant_tx(tenant).await.unwrap();
    assert_eq!(ferrum_app_erp::stored_value::check(&a, &mut tx).await.unwrap(), Vec::<String>::new());
    drop(tx);
    let settled = t.find_one("PosInvoice", json!({"id": now["id"]})).await;
    assert_eq!((settled["consolidated_invoice"].clone(), settled["status"].clone()), (si.clone(), json!("Consolidated")), "settled, not invoiced twice");
    let inv = t.find_one("SalesInvoice", json!({"id": si})).await;
    assert_eq!(dec(&inv["outstanding_amount"]), Decimal::ZERO, "the closing paid it");
}
