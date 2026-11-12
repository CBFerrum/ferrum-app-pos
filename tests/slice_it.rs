//! The till's tier-1 gaps (0.7.0), against a real PostgreSQL (the same database as `pos_it`, reset first; cargo runs
//! test binaries one after the other): a buyer's tax registration, the receipt and its copies, promotions and the
//! offline snapshot, returns and cash management.

use ferrum_app_erp::localization::{Localization, TaxId, field_tax_ids};
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

impl T {
    /// A request answered with a page (a receipt), as its text.
    async fn page(&self, ctx: &Ctx, method: &str, path: &str, query: Value, body: Value) -> Result<(String, Vec<(String, String)>), Error> {
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
        Ok((String::from_utf8_lossy(&res.body).to_string(), res.headers))
    }
}

fn pay(mode: &Doc, amount: &str) -> Value {
    json!({"mode_of_payment": mode["id"], "amount": amount})
}

/// A made-up country (installed with the till's own package): its registrations are the customer's tax id, and one
/// starting `TL` is a registered business.
struct Testland;

impl Localization for Testland {
    fn package(&self) -> &'static str {
        "pos"
    }
    fn tax_ids(&self, ctx: &Ctx, entity: &str, record: &Doc) -> Vec<TaxId> {
        field_tax_ids(ctx, entity, record, &["tax_id"])
    }
    fn registered(&self, _ctx: &Ctx, entity: &str, record: &Doc) -> Option<bool> {
        (entity == "Customer").then(|| record.get("tax_id").and_then(Value::as_str).is_some_and(|t| t.starts_with("TL")))
    }
}

#[test]
fn slice() {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(16 << 20).build().unwrap();
    rt.block_on(async { tokio::spawn(scenario()).await.unwrap() });
}

async fn scenario() {
    ferrum_app_erp::localization::add(Arc::new(Testland));
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
    let settings = KernelSettings { secret_key: Some(ferrum_kernel::secret::SecretKey::new([7u8; 32])), ..Default::default() };
    let k = Kernel::boot(db, catalog, hooks, settings, None).await.expect("boot");
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
    let company = t.insert(&a, "Company", json!({"company_name": "Corner Shop", "abbr": "CS", "default_currency": inr["id"], "tax_id": "TL-SELLER-1"})).await;
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
    let gadget = uid(&t.insert(&a, "Item", item("GADGET")).await);
    for (i, rate) in [(widget, "100"), (gadget, "40")] {
        t.insert(&a, "ItemPrice", json!({"item": i.to_string(), "price_list": selling["id"], "rate": rate, "valid_from": "2020-01-01"})).await;
    }
    let opening = t
        .insert(
            &a,
            "StockEntry",
            json!({"company": cid.to_string(), "purpose": "Opening Stock",
                   "items": [{"item": widget.to_string(), "qty": "100", "basic_rate": "60", "target_warehouse": stores.to_string()},
                             {"item": gadget.to_string(), "qty": "100", "basic_rate": "20", "target_warehouse": stores.to_string()}]}),
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
    let widgets = |qty: &str| json!([{"item": widget.to_string(), "qty": qty}]);

    // ───────────── 1. the buyer's tax registration ─────────────
    // A number the countries do not take for a business is refused, in words.
    let mut s0 = sale(widgets("1"), json!([pay(&card, "110")]));
    s0["buyer_tax_id"] = json!("XX-9");
    let e = t.refused(&cashier, s0).await;
    assert!(messages(&e).contains("not a registration the country rules accept"), "{e:?}");
    // A registered buyer: the customer is made (the register's default is to find or create), and the sale is a tax invoice of its own.
    let mut s1 = sale(widgets("1"), json!([pay(&card, "110")]));
    s1["buyer_tax_id"] = json!(" TL-555 ");
    s1["buyer_name"] = json!("Acme Ltd");
    let one = t.sell(&cashier, s1).await;
    let acme = t.find_one("Customer", json!({"tax_id": "TL-555"})).await;
    assert_eq!((acme["customer_name"].clone(), one["customer"].clone()), (json!("Acme Ltd"), acme["id"].clone()), "found or made: {one:?}");
    assert_eq!(
        (one["tax_invoice"].clone(), one["invoiced_at_sale"].clone(), one["buyer_tax_id"].clone()),
        (json!(true), json!(true), json!("TL-555")),
        "{one:?}"
    );
    let invoice = t.k.get(&a, "SalesInvoice", one["consolidated_invoice"].as_str().unwrap().parse().unwrap(), false).await.expect("its sales invoice");
    assert_eq!(invoice["customer"], acme["id"], "the buyer's own invoice, made when it was sold");
    let regs = &invoice["tax_registrations"];
    assert!(regs["seller"].to_string().contains("TL-SELLER-1") && regs["buyer"].to_string().contains("TL-555"), "both registrations on it: {regs}");
    assert_eq!(regs["buyer_registered"], json!(true));
    // Again with the same number (spaced and in lower case): the same customer, none made twice.
    let mut s2 = sale(widgets("1"), json!([pay(&card, "110")]));
    s2["buyer_tax_id"] = json!("tl-555");
    let two = t.sell(&cashier, s2).await;
    assert_eq!(two["customer"], acme["id"]);
    // Two tills at once with a number nobody holds: one customer.
    let both = |n: &str| {
        let mut v = sale(widgets("1"), json!([pay(&card, "110")]));
        v["buyer_tax_id"] = json!("TL-777");
        v["buyer_name"] = json!(n.to_string());
        v
    };
    let (x, y) = tokio::join!(t.k.insert(&cashier, "PosInvoice", obj(both("First"))), t.k.insert(&cashier, "PosInvoice", obj(both("Second"))));
    let (x, y) = (x.expect("first"), y.expect("second"));
    let q = ListQuery { filters: ferrum_kernel::query::parse_filters(&json!({"tax_id": "TL-777"})).unwrap(), ..Default::default() };
    assert_eq!(t.k.list(&a, "Customer", &q).await.unwrap().rows.len(), 1, "two drafts naming a new number made one customer");
    for d in [&x, &y] {
        let _ = t.k.delete(&cashier, "PosInvoice", uid(d), None).await;
    }
    // Find Only: a number nobody holds is refused, one somebody holds still sells.
    t.k.update(&a, "PosProfile", counter, obj(json!({"buyer_customer": "Find Only"})), None).await.expect("register setting");
    let mut s3 = sale(widgets("1"), json!([pay(&card, "110")]));
    s3["buyer_tax_id"] = json!("TL-888");
    assert!(messages(&t.refused(&cashier, s3).await).contains("no customer holds TL-888"));
    let mut s4 = sale(widgets("1"), json!([pay(&card, "110")]));
    s4["buyer_tax_id"] = json!("TL-555");
    t.sell(&cashier, s4).await;
    // A register that does not invoice at once: the buyer is the customer, the invoice waits for closing.
    t.k.update(&a, "PosProfile", counter, obj(json!({"buyer_customer": "Find or Create", "registered_buyer": "Simplified Receipt"})), None)
        .await
        .expect("setting");
    let mut s5 = sale(widgets("1"), json!([pay(&card, "110")]));
    s5["buyer_tax_id"] = json!("TL-555");
    let five = t.sell(&cashier, s5).await;
    assert_eq!((five["tax_invoice"].clone(), five["invoiced_at_sale"].clone()), (json!(false), json!(false)), "{five:?}");
    // A workspace upgraded from a build that had none of these settings: absent means the defaults.
    let mut tx = t.k.db.tenant_tx(tenant).await.unwrap();
    sqlx::query("update e_pos_profile set buyer_customer = null, registered_buyer = null where tenant_id = $1").bind(tenant).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let mut s6 = sale(widgets("1"), json!([pay(&card, "110")]));
    s6["buyer_tax_id"] = json!("TL-999");
    let six = t.sell(&cashier, s6).await;
    assert_eq!((six["tax_invoice"].clone(), six["invoiced_at_sale"].clone()), (json!(true), json!(true)), "defaults: find or create, tax invoice: {six:?}");
    // The threshold: off by default; above it a named buyer is needed (a customer other than the walk-in, or a registration).
    t.sell(&cashier, sale(widgets("10"), json!([pay(&card, "1100")]))).await;
    t.k.update(&a, "PosProfile", counter, obj(json!({"named_buyer_above": "150"})), None).await.expect("threshold");
    let e = t.refused(&cashier, sale(widgets("2"), json!([pay(&card, "220")]))).await;
    assert!(messages(&e).contains("without a named buyer"), "{e:?}");
    t.sell(&cashier, sale(widgets("1"), json!([pay(&card, "110")]))).await;
    let mut named = sale(widgets("2"), json!([pay(&card, "220")]));
    named["customer"] = json!(acme["id"]);
    t.sell(&cashier, named).await;
    let mut regd = sale(widgets("2"), json!([pay(&card, "220")]));
    regd["buyer_tax_id"] = json!("TL-555");
    t.sell(&cashier, regd).await;
    println!("item 1 ok");

    // ───────────── 2. the receipt shows the tax breakdown ─────────────
    t.k.update(&a, "PosProfile", counter, obj(json!({"named_buyer_above": null, "registered_buyer": "Tax Invoice"})), None).await.expect("setting");
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
    let giftcard = t.insert(&a, "ModeOfPayment", json!({"mode_name": "Gift Card", "mode_type": "Stored Value", "stored_value_kind": gift["id"]})).await;
    t.k.update(
        &a,
        "PosProfile",
        counter,
        obj(json!({"receipt_header": "Welcome to the corner shop", "receipt_footer": "Goods can be returned within 30 days",
                   "payments": [{"mode_of_payment": cash["id"], "is_default": true, "allow_in_returns": true}, {"mode_of_payment": card["id"], "allow_in_returns": true},
                                {"mode_of_payment": giftcard["id"], "allow_in_returns": true}]})),
        None,
    )
    .await
    .expect("the register takes gift cards");
    t.sell(&cashier, sale(json!([{"item": card_item.to_string(), "qty": "1", "stored_value_code": "GIFT-0000-0000-0001"}]), json!([pay(&cash, "500")]))).await;
    let mut by_card = pay(&giftcard, "110");
    by_card["stored_value_code"] = json!("GIFT-0000-0000-0001");
    let mut mixed = sale(
        json!([{"item": widget.to_string(), "qty": "2", "discount_percent": "5"}, {"item": gadget.to_string(), "qty": "1"}]),
        json!([by_card, pay(&cash, "200")]),
    );
    mixed["buyer_tax_id"] = json!("TL-555");
    let paid = t.sell(&cashier, mixed).await;
    let sid = uid(&paid);
    let (html, _) = t.page(&cashier, "GET", &format!("/receipt/{sid}"), json!({"profile": counter.to_string()}), Value::Null).await.expect("the first receipt");
    for must in [
        "TAX INVOICE",
        "Welcome to the corner shop",
        "TL-SELLER-1",
        "TL-555",
        "Acme Ltd",
        "VAT 10%",
        "Left on the card",
        "Change",
        "Goods can be returned within 30 days",
        "<svg",
    ] {
        assert!(html.contains(must), "the receipt says {must}: {html}");
    }
    assert!(!html.contains("0000-0000") && !html.contains("0000 0000"), "never the card's code: {html}");
    assert!(!html.contains("COPY"), "the first one is not a copy");
    let again = t.page(&cashier, "GET", &format!("/receipt/{sid}"), json!({"profile": counter.to_string()}), Value::Null).await;
    assert!(format!("{again:?}").contains("printed already"), "a second first receipt is a copy: {again:?}");
    // The workspace's own wording: a copy of the template it edits.
    let mut mine = t.k.document_template(&a, "pos.receipt").await.expect("the template")["template"].clone();
    mine["languages"]["en"]["body"] = json!(mine["languages"]["en"]["body"].as_str().unwrap().replace("RECEIPT", "SALES SLIP"));
    t.k.save_document_template(&a, &serde_json::from_value(mine).unwrap()).await.expect("edit it");
    let plain = t.sell(&cashier, sale(widgets("1"), json!([pay(&cash, "110")]))).await;
    let (slip, _) = t.page(&cashier, "GET", &format!("/receipt/{}", uid(&plain)), json!({"profile": counter.to_string()}), Value::Null).await.unwrap();
    assert!(slip.contains("SALES SLIP") && !slip.contains(">RECEIPT"), "a simplified receipt, in the workspace's words: {slip}");
    println!("item 2 ok");

    // ───────────── 3. reprints, gift receipts, receipts by message ─────────────
    let at = |extra: Value| {
        let mut v = json!({"profile": counter.to_string(), "sale": sid.to_string()});
        v.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap());
        v
    };
    // The business's own reasons for a copy (seeded): one must be given.
    let e = t.page(&cashier, "POST", "/reprint", Value::Null, at(json!({"kind": "copy"}))).await.unwrap_err();
    assert!(messages(&e).contains("choose one of the business's reasons"), "{e:?}");
    let (copy, headers) =
        t.page(&cashier, "POST", "/reprint", Value::Null, at(json!({"kind": "copy", "reason": "Customer asked for a copy"}))).await.expect("a copy");
    assert!(copy.contains("COPY 1") && copy.contains("TAX INVOICE"), "marked as a copy: {copy}");
    assert!(headers.iter().any(|(k, v)| k == "x-pos-copy" && v == "1"));
    let (copy2, _) =
        t.page(&cashier, "POST", "/reprint", Value::Null, at(json!({"kind": "copy", "reason": "Customer asked for a copy"}))).await.expect("another");
    assert!(copy2.contains("COPY 2"), "counted: {copy2}");
    let sold = t.k.get(&a, "PosInvoice", sid, false).await.unwrap();
    assert_eq!(sold["reprints"], json!(2));
    let events =
        t.k.list(
            &a,
            "PosReceiptEvent",
            &ListQuery {
                filters: ferrum_kernel::query::parse_filters(&json!({"pos_invoice": sid.to_string(), "kind": "Copy"})).unwrap(),
                sort: Some("copy_no asc".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .rows;
    assert_eq!(
        events.iter().map(|e| (e["copy_no"].clone(), e["cashier"].clone())).collect::<Vec<_>>(),
        vec![(json!(1), json!("cashier@shop.test")), (json!(2), json!("cashier@shop.test"))]
    );
    assert!(events[0]["printed_at"].is_string(), "when: {:?}", events[0]);
    // A gift receipt has no prices, and is not a copy of the receipt.
    let (gift_receipt, _) =
        t.page(&cashier, "POST", "/reprint", Value::Null, at(json!({"kind": "gift", "reason": "Customer asked for a copy"}))).await.expect("gift");
    assert!(
        gift_receipt.contains("GIFT RECEIPT") && gift_receipt.contains("widget") && !gift_receipt.contains("253") && !gift_receipt.contains("₹"),
        "no prices: {gift_receipt}"
    );
    assert_eq!(t.k.get(&a, "PosInvoice", sid, false).await.unwrap()["reprints"], json!(2));
    // Without the right to reprint a person needs another's approval, once.
    t.insert(&a, "PosRoleLimit", json!({"role": "Cashier", "discount_percent": "10", "reprint": false})).await;
    let e = t.page(&cashier, "POST", "/reprint", Value::Null, at(json!({"kind": "copy", "reason": "Customer asked for a copy"}))).await.unwrap_err();
    assert!(format!("{e:?}").contains("may not reprint"), "{e:?}");
    t.site(&manager, "POST", "/pin", Value::Null, json!({"pin": "4321"})).await.expect("a pin");
    let approved = t
        .site(&cashier, "POST", "/approve", Value::Null, json!({"profile": counter.to_string(), "approver": "manager@shop.test", "pin": "4321", "action": "Reprint", "reason": "Asked", "sale": sid.to_string()}))
        .await
        .expect("approved");
    let with = at(json!({"kind": "copy", "reason": "Customer asked for a copy", "approval": approved["approval"]}));
    let (third, _) = t.page(&cashier, "POST", "/reprint", Value::Null, with.clone()).await.expect("with the approval");
    assert!(third.contains("COPY 3"));
    let e = t.page(&cashier, "POST", "/reprint", Value::Null, with).await.unwrap_err();
    assert!(format!("{e:?}").contains("may not reprint"), "an approval is for one copy: {e:?}");
    let limit = t.find_one("PosRoleLimit", json!({"role": "Cashier"})).await;
    t.k.delete(&a, "PosRoleLimit", uid(&limit), None).await.unwrap();
    // By message: to an address the buyer gives, for this receipt only; the address is not on the sale or its events.
    let sent = t.site(&cashier, "POST", "/send", Value::Null, at(json!({"to": "buyer@example.test", "consent": "once"}))).await.expect("sent");
    assert!(sent["sent"].as_array().is_some_and(|x| !x.is_empty()), "{sent}");
    let log = t.k.message_log(&a, Some(("PosInvoice", sid)), None, 10).await.unwrap();
    assert!(log.iter().any(|m| m["template"] == "pos.receipt_sent"), "in the message log: {log:?}");
    let msg = t.find_one("PosReceiptEvent", json!({"kind": "Message"})).await;
    assert_eq!(msg["consent"], json!("This Receipt Only"));
    assert!(!format!("{msg:?}").contains("buyer@example"), "the address is in the log, not in the event: {msg:?}");
    // A buyer who opts in, a customer of the shop's own: the address goes on their record.
    let email = t.k.get(&a, "Customer", acme_id(&acme), false).await.unwrap();
    assert!(email.get("email").is_none_or(|v| v.is_null()));
    t.site(&cashier, "POST", "/send", Value::Null, at(json!({"to": "acme@buyer.test", "consent": "opt_in"}))).await.expect("sent");
    assert_eq!(t.k.get(&a, "Customer", acme_id(&acme), false).await.unwrap()["email"], json!("acme@buyer.test"));
    println!("item 3 ok");

    // ───────────── 4. promotions offline in the till ─────────────
    let p10 = uid(&t.insert(&a, "Promotion", json!({"title": "10 off over 150", "gives": "Percent Off the Document", "percent": "10", "min_amount": "150", "priority": 1, "channels": "Point of Sale"})).await);
    t.insert(&a, "Promotion", json!({"title": "3 gadgets for 2", "gives": "Buy and Get", "buy_qty": "2", "get_qty": "1", "get_at": "Free", "qualifying_items": [{"item": gadget.to_string()}], "priority": 5})).await;
    let used = |id: Uuid| {
        let t = &t;
        async move { t.k.get(&t.admin, "Promotion", id, false).await.unwrap()["used_count"].as_i64().unwrap_or(0) }
    };
    // Online the server's engine takes the promotions off the sale, and counts their use once.
    let two = t.sell(&cashier, sale(widgets("2"), json!([pay(&card, "198")]))).await;
    assert_eq!((dec(&two["rounded_total"]), two["applied_promotions"][0]["title"].clone()), (n("198"), json!("10 off over 150")), "{two:?}");
    assert_eq!(used(p10).await, 1);
    let free = t.sell(&cashier, sale(json!([{"item": gadget.to_string(), "qty": "3"}]), json!([pay(&card, "88")]))).await;
    assert_eq!(dec(&free["rounded_total"]), n("88"), "three for two: {free:?}");
    // What the till is given: one signed, versioned snapshot of prices, taxes and promotions.
    let snap = t.site(&cashier, "GET", "/snapshot", json!({"profile": counter.to_string()}), Value::Null).await.expect("snapshot");
    let version = snap["version"].as_str().unwrap().to_string();
    assert!(version.len() == 64 && snap["signature"].as_str().is_some_and(|s| s.len() == 64), "versioned and signed: {version} {}", snap["signature"]);
    assert_eq!(snap["promotions"].as_array().map(Vec::len), Some(2), "{snap}");
    let wid = snap["items"].as_array().unwrap().iter().find(|i| i["id"] == json!(widget.to_string())).expect("the widget");
    assert_eq!(
        (dec(&wid["line"]["price"]), dec(&wid["line"]["discount_percent"])),
        (n("100"), n("0")),
        "an item as a sale of one prices it, promotions apart: {wid}"
    );
    assert!(wid["item_group"].is_string() && snap["engine"]["taxes"].is_array());
    let again = t.site(&cashier, "GET", "/snapshot", json!({"profile": counter.to_string()}), Value::Null).await.unwrap();
    assert_eq!(again["version"], json!(version), "the same content is the same version");
    let offline = |items: Value, pays: Value, total: &str, snapshot: &str| {
        let mut v = sale(items, pays);
        v["sold_offline"] = json!(true);
        v["price_snapshot"] = json!(snapshot);
        v["till_total"] = json!(total);
        v
    };
    let diff_of = |sale_id: Uuid| {
        let t = &t;
        async move {
            let q = ListQuery { filters: ferrum_kernel::query::parse_filters(&json!({"pos_invoice": sale_id.to_string()})).unwrap(), ..Default::default() };
            t.k.list(&t.admin, "PosPriceDifference", &q).await.unwrap().rows
        }
    };
    // Sold offline and priced the same by the till, the snapshot and the server: nothing to look at.
    let ok = t.sell(&cashier, offline(widgets("2"), json!([pay(&card, "198")]), "198", &version)).await;
    assert_eq!(dec(&ok["replay_total"]), n("198"), "the snapshot's engine and the server's agree: {ok:?}");
    assert!(diff_of(uid(&ok)).await.is_empty());
    // The till's total is not what its snapshot gives: the sale stands as paid, a difference waits for a person.
    let wrong = t.sell(&cashier, offline(widgets("2"), json!([pay(&card, "198")]), "190", &version)).await;
    let d = diff_of(uid(&wrong)).await;
    assert_eq!(d.len(), 1, "{d:?}");
    assert_eq!(
        (dec(&d[0]["till_total"]), dec(&d[0]["replay_total"]), dec(&d[0]["sale_total"]), d[0]["status"].clone()),
        (n("190"), n("198"), n("198"), json!("Open"))
    );
    t.k.run_action(&manager, "PosPriceDifference", uid(&d[0]), "review", json!({"resolution": "till was out of date"})).await.expect("reviewed");
    assert_eq!(diff_of(uid(&wrong)).await[0]["status"], json!("Reviewed"));
    // A free item and a basket the promotions treat differently still agree: three gadgets and a widget.
    let mix = json!([{"item": gadget.to_string(), "qty": "3"}, {"item": widget.to_string(), "qty": "1"}]);
    let combined = t.sell(&cashier, offline(mix, json!([pay(&card, "178.2")]), "178.2", &version)).await;
    assert_eq!((dec(&combined["rounded_total"]), dec(&combined["replay_total"])), (n("178.2"), n("178.2")), "{combined:?}");
    assert!(diff_of(uid(&combined)).await.is_empty());
    // A price changed after the snapshot: the server prices with what it holds now and says so; payments that
    // cover it are enough, nothing is changed on the quiet.
    let price = t.find_one("ItemPrice", json!({"item": widget.to_string()})).await;
    t.k.update(&a, "ItemPrice", uid(&price), obj(json!({"rate": "120"})), None).await.expect("a new price");
    let dearer = t.sell(&cashier, offline(widgets("1"), json!([pay(&cash, "150")]), "110", &version)).await;
    let d = diff_of(uid(&dearer)).await;
    assert_eq!(d.len(), 1, "{d:?}");
    assert_eq!((dec(&d[0]["till_total"]), dec(&d[0]["replay_total"]), dec(&d[0]["sale_total"])), (n("110"), n("110"), n("132")));
    // Paid what the till said and no more: the sale cannot be recorded at the new price, and waits as before.
    let e = t.refused(&cashier, offline(widgets("1"), json!([pay(&card, "110")]), "110", &version)).await;
    assert!(messages(&e).contains("insufficient payment"), "{e:?}");
    // A snapshot nobody kept: a difference that says so.
    let lost = t.sell(&cashier, offline(widgets("1"), json!([pay(&cash, "150")]), "132", &"f".repeat(64))).await;
    let d = diff_of(uid(&lost)).await;
    assert_eq!((d.len(), d[0]["snapshot_kept"].clone()), (1, json!(false)), "{d:?}");
    // A promotion that ran out since the snapshot: the sale is still taken, with a difference.
    t.k.update(&a, "Promotion", p10, obj(json!({"max_uses": "1"})), None).await.expect("used up");
    let ran_out = t.sell(&cashier, offline(widgets("2"), json!([pay(&cash, "300")]), "216", &version)).await;
    assert_eq!(diff_of(uid(&ran_out)).await.len(), 1);
    // The upkeep forgets what is old, and copes with a workspace that has none yet.
    ferrum_app_pos::maintenance(&t.k).await.expect("upkeep");
    println!("item 4 ok");
}

fn acme_id(c: &Doc) -> Uuid {
    uid(c)
}
