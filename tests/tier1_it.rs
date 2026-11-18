//! The till's rules a business varies, against a real PostgreSQL (the same database as `pos_it`,
//! reset first; cargo runs test binaries one after the other): limits by role, approval by another
//! person's PIN, voids with reasons, reprints, stored value, returns without a receipt and exchanges,
//! and the register's dates on the workspace's day rather than UTC's.

use chrono::Timelike;
use ferrum_kernel::capability::Invocation;
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
    /// An action of a record, as a person's request runs it.
    async fn act(&self, ctx: &Ctx, entity: &str, id: Uuid, action: &str, params: Value) -> Result<Value, Error> {
        self.k.run_action(ctx, entity, id, action, params).await
    }
    /// A person's PIN as it is kept: its hash and the wrong tries counted.
    async fn pin(&self, email: &str) -> Option<(String, i32)> {
        let mut tx = self.k.db.tenant_tx(self.tenant).await.unwrap();
        sqlx::query_as("select pin_hash, failures from pos_staff_pin where tenant_id = $1 and email = $2")
            .bind(self.tenant)
            .bind(email)
            .fetch_optional(&mut *tx)
            .await
            .unwrap()
    }
    /// The approvals made for one sale (by the id the till gave it).
    async fn approvals_for(&self, sale: &str) -> i64 {
        let mut tx = self.k.db.tenant_tx(self.tenant).await.unwrap();
        sqlx::query_scalar("select count(*) from e_pos_approval where tenant_id = $1 and sale = $2")
            .bind(self.tenant)
            .bind(sale)
            .fetch_one(&mut *tx)
            .await
            .unwrap()
    }
}

fn line(item: Uuid, qty: &str) -> Value {
    json!({"item": item.to_string(), "qty": qty})
}

fn pay(mode: &Doc, amount: &str) -> Value {
    json!({"mode_of_payment": mode["id"], "amount": amount})
}

/// What opens the test's vault: the database password of `url`, with Argon2id kept cheap for tests.
fn opener(url: &str) -> ferrum_kernel::vault::Opener {
    ferrum_kernel::vault::Opener {
        database_url: url.to_string(),
        file: "/nonexistent/root.key".into(),
        kdf: ferrum_kernel::vault::Kdf { m_kib: 64, t: 1, p: 1 },
        ..Default::default()
    }
}

#[test]
fn tier1() {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(16 << 20).build().unwrap();
    rt.block_on(async { tokio::spawn(scenario()).await.unwrap() });
}

async fn scenario() {
    let url = std::env::var("FERRUM_POS_TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://ferrum:ferrum@localhost:5432/ferrum_pos_test".into());
    let db = Db::connect(DbConfig { url: url.clone(), max_connections: 10, ..Default::default() }).await.expect("connect");
    sqlx::raw_sql("drop schema if exists vault cascade; drop schema if exists public cascade; create schema public;").execute(&db.pool).await.expect("reset");
    ferrum_kernel::vault::open(&db, opener(&url), false).await.expect("the vault");
    let mut packages = ferrum_domain::packages().expect("platform packages");
    packages.extend(ferrum_app_erp::packages().expect("ERP's packages"));
    packages.extend(ferrum_app_pos::packages().expect("app packages"));
    let catalog = Catalog::from_packages(packages).expect("catalog");
    let mut hooks = HookRegistry::default();
    ferrum_domain::register(&mut hooks);
    let erp_packages: Vec<String> = ferrum_app_erp::packages().unwrap().iter().map(|p| p.name().to_string()).collect();
    hooks.app("erp", &[], ferrum_app_erp::register);
    hooks.own("erp", &erp_packages);
    let pos_packages: Vec<String> = ferrum_app_pos::packages().unwrap().iter().map(|p| p.name().to_string()).collect();
    hooks.app("pos", &pos_packages, ferrum_app_pos::register);
    hooks.own("pos", &pos_packages);
    let k = Kernel::boot(db, catalog, hooks, KernelSettings::default(), None).await.expect("boot");
    ferrum_domain::maintenance(&k).await.expect("partitions");
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
    // The company comes with its current fiscal year; the sales dated a month back below can fall in the year before (in
    // a year's first month), which nothing posts into until it is made.
    let this_year = t.find_one("FiscalYear", json!({"company": cid.to_string()})).await;
    let year_start = chrono::NaiveDate::parse_from_str(this_year["start_date"].as_str().unwrap(), "%Y-%m-%d").unwrap();
    t.insert(
        &a,
        "FiscalYear",
        json!({"year_name": "The year before", "company": cid.to_string(), "start_date": (year_start - chrono::Months::new(12)).to_string(),
               "end_date": year_start.pred_opt().unwrap().to_string()}),
    )
    .await;
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
    // Two rows that would both apply are refused when saved, in plain words.
    let twice = t.k.insert(&a, "PosRoleLimit", obj(json!({"role": "cashier", "discount_percent": "50"}))).await.unwrap_err();
    assert!(messages(&twice).contains("cashier already has limits for every register"), "{twice:?}");
    let twice = t.k.insert(&a, "PosRoleLimit", obj(json!({"role": "Cashier", "pos_profile": counter.to_string()}))).await.unwrap_err();
    assert!(messages(&twice).contains("already has limits for register Counter"), "{twice:?}");
    let e = t.refused(&cashier, sale(off("10", "1"), json!([pay(&card, "99")]))).await;
    assert!(messages(&e).contains("exceeds the 5% allowed"), "{e:?}");
    // A return worth more than the refund limit.
    let back_id = Uuid::now_v7().to_string();
    let back = json!({"id": back_id, "pos_profile": counter.to_string(), "is_return": true, "return_against": fifteen["id"],
                      "items": [line(widget, "-1")], "payments": [pay(&card, "-93.50")]});
    let e = t.refused(&cashier, back.clone()).await;
    assert!(messages(&e).contains("more than the 50 you may give"), "{e:?}");

    // whole_sale_discount_within_the_limit: the sale's own discount counts with its lines' against the cashier's 5% here; within
    // it the sale is taken, and the discount is that share of the total.
    let whole = |pct: &str, pays: Value| {
        let mut v = sale(json!([line(widget, "1")]), pays);
        v["discount_percent"] = json!(pct);
        v
    };
    let within = t.sell(&cashier, whole("5", json!([pay(&card, "104.50")]))).await;
    assert_eq!(
        (dec(&within["total"]), dec(&within["discount_amount"]), dec(&within["rounded_total"])),
        (n("100"), n("5"), n("104.50")),
        "whole_sale_discount_within_the_limit: {within:?}"
    );
    // whole_sale_discount_beyond_the_limit_needs_an_approval: 8% is past it; another person's approval of that discount for that
    // sale lets it through.
    let past = Uuid::now_v7().to_string();
    let mut beyond = whole("8", json!([pay(&card, "101.20")]));
    beyond["id"] = json!(past);
    let e = t.refused(&cashier, beyond.clone()).await;
    assert!(messages(&e).contains("exceeds"), "whole_sale_discount_beyond_the_limit_needs_an_approval: {e:?}");
    t.act(&a, "PosProfile", counter, "set_pin", json!({"pin": "86420"})).await.expect("the administrator's PIN");
    let approval = json!({"approver": "admin@shop.test", "pin": "86420", "act": "Discount", "amount": "8", "reason": "a regular", "sale": past});
    let ok =
        t.act(&cashier, "PosOpeningEntry", uid(&open), "approve", approval).await.expect("whole_sale_discount_beyond_the_limit_needs_an_approval: approved");
    beyond["approvals"] = json!([{"approval": ok["approval"]}]);
    let approved = t.sell(&cashier, beyond).await;
    assert_eq!(dec(&approved["discount_amount"]), n("8"), "whole_sale_discount_beyond_the_limit_needs_an_approval: {approved:?}");
    // offline_sale_with_a_whole_sale_discount_agrees: sold offline with the register's snapshot and the sale's discount, the
    // server prices it again with the same discount and finds no difference.
    let snap = t.site(&cashier, "GET", "/snapshot", json!({"profile": counter.to_string()}), Value::Null).await.expect("the snapshot");
    let mut gone = whole("5", json!([pay(&card, "104.50")]));
    gone["sold_offline"] = json!(true);
    gone["price_snapshot"] = snap["version"].clone();
    gone["till_total"] = json!("104.50");
    let gone = t.sell(&cashier, gone).await;
    assert_eq!(dec(&gone["replay_total"]), n("104.50"), "offline_sale_with_a_whole_sale_discount_agrees: {gone:?}");
    let q = ListQuery { filters: ferrum_kernel::query::parse_filters(&json!({"pos_invoice": gone["id"]})).unwrap(), ..Default::default() };
    assert!(t.k.list(&a, "PosPriceDifference", &q).await.unwrap().rows.is_empty(), "offline_sale_with_a_whole_sale_discount_agrees: a difference was recorded");

    // ───────────── 2. approval by another person's PIN, voids with reasons ─────────────
    // Both are operations, as an agent or an API client asks them too: `set_pin` of a register, and `approve` of the
    // cashier's own open session. The register's site has no route for either.
    let session = uid(&open);
    let ask = |who: &str, pin: &str, act: &str, amount: Option<&str>, sale: &str| json!({"approver": who, "pin": pin, "act": act, "amount": amount, "reason": "regular customer", "sale": sale});
    let approve = |key: &str, params: Value| Invocation::new("pos.pos_opening_entry.approve", json!({"id": session, "params": params})).key(key);
    let new_id = || Uuid::now_v7().to_string();
    let (w1, w2, w3) = (new_id(), new_id(), new_id());
    let no_pin = t.act(&cashier, "PosOpeningEntry", session, "approve", ask("manager@shop.test", "4321", "Discount", Some("15"), &w1)).await;
    assert!(no_pin.is_err(), "no PIN set yet");

    // existing_actions_say_what_done_means: the three actions the till already had say what "done" is, and what they answer.
    for (id, done) in [
        ("pos.pos_invoice.void", "The sale is cancelled: its stock is back, it is out of the session's takings, and it keeps who voided it and why"),
        ("pos.pos_stock_shortfall.resolve", "The shortfall is Put Right, with how, by whom and when"),
        ("pos.pos_price_difference.review", "The price difference is Reviewed, with what was found, by whom and when"),
    ] {
        let cap = t.k.capability(&manager, id).unwrap_or_else(|e| panic!("existing_actions_say_what_done_means: {id}: {e:?}"));
        assert_eq!(cap.completion, done, "existing_actions_say_what_done_means: {id}");
        assert!(cap.output["properties"]["status"].is_object(), "existing_actions_say_what_done_means: {id} answers its status: {}", cap.output);
    }

    // set_pin_is_an_operation: in a cashier's catalog, changing something, run through the gate; the route is gone.
    let cap = t.k.capability(&cashier, "pos.pos_profile.set_pin").expect("set_pin_is_an_operation: in a cashier's catalog");
    assert!(cap.effect.changes(), "set_pin_is_an_operation: it changes something");
    t.act(&manager, "PosProfile", counter, "set_pin", json!({"pin": "12"})).await.expect_err("a PIN is four to twelve digits");
    let set =
        t.k.invoke(&manager, Invocation::new("pos.pos_profile.set_pin", json!({"id": counter, "params": {"pin": "4321"}})).key("pin-1"))
            .await
            .expect("set_pin_is_an_operation: set through the gate");
    assert_eq!(set.result, json!({"ok": true}), "set_pin_is_an_operation");
    let kept = t.pin("manager@shop.test").await.expect("set_pin_is_an_operation: the manager's PIN is kept");
    assert!(kept.0.starts_with("$argon2id$") && kept.1 == 0, "set_pin_is_an_operation: as a hash, no wrong tries: {kept:?}");
    let gone = t.site(&manager, "POST", "/pin", Value::Null, json!({"pin": "4321"})).await;
    assert!(matches!(gone, Err(Error::NotFound(_))), "set_pin_is_an_operation: no route sets a PIN: {gone:?}");

    // outside_person_sets_no_pin: a portal person or a guest, or someone with no e-mail, keeps no PIN in the workspace.
    let strips: [fn(&mut Ctx); 2] = [|c| c.outside = true, |c| c.email.clear()];
    for strip in strips {
        let mut outsider = cashier.clone();
        strip(&mut outsider);
        let refused = t.act(&outsider, "PosProfile", counter, "set_pin", json!({"pin": "5555"})).await;
        assert!(matches!(refused, Err(Error::Forbidden(ref m)) if m.contains("only a member")), "outside_person_sets_no_pin: {refused:?}");
    }
    assert_eq!(t.pin("cashier@shop.test").await, None, "outside_person_sets_no_pin: nothing kept");

    let own = t.act(&manager, "PosOpeningEntry", session, "approve", ask("manager@shop.test", "4321", "Discount", Some("15"), &w1)).await;
    assert!(own.as_ref().is_err_and(|e| messages(e).contains("someone else approves")), "nobody approves their own act: {own:?}");
    let unbound = t.act(&cashier, "PosOpeningEntry", session, "approve", ask("manager@shop.test", "4321", "Discount", Some("15"), "")).await;
    assert!(messages(&unbound.unwrap_err()).contains("name the sale"), "an approval is for one sale");

    // approve_is_an_operation_of_the_open_session: asked through the gate, it answers an approval that a sale then uses.
    let first = t.k.invoke(&cashier, approve("a-1", ask("manager@shop.test", "4321", "Discount", Some("15"), &w1))).await;
    let first = first.expect("approve_is_an_operation_of_the_open_session: approved");
    assert!(!first.repeated, "approve_is_an_operation_of_the_open_session: done, not repeated");
    assert_eq!(
        (first.result["approver"].clone(), first.result["action"].clone()),
        (json!("manager@shop.test"), json!("Discount")),
        "approve_is_an_operation_of_the_open_session: {first:?}"
    );
    let approval = first.result["approval"].as_str().expect("approve_is_an_operation_of_the_open_session: the approval's id").to_string();
    let gone = t
        .site(
            &cashier,
            "POST",
            "/approve",
            Value::Null,
            json!({"profile": counter, "approver": "manager@shop.test", "pin": "4321", "action": "Discount", "reason": "r", "sale": w1}),
        )
        .await;
    assert!(matches!(gone, Err(Error::NotFound(_))), "approve_is_an_operation_of_the_open_session: no route approves: {gone:?}");
    let mut with = sale(off("15", "1"), json!([pay(&card, "93.50")]));
    with["approvals"] = json!([{"approval": approval}]);
    // Bound to the sale it was given for: another sale naming it is refused.
    let mut other = with.clone();
    other["id"] = json!(w2);
    assert!(messages(&t.refused(&cashier, other.clone()).await).contains("exceeds the 5% allowed"), "for one sale");
    with["id"] = json!(w1);
    let approved = t.sell(&cashier, with.clone()).await;
    assert_eq!(approved["approvals"][0]["approver"], json!("manager@shop.test"), "the sale keeps who approved it");
    let used = t.find_one("PosApproval", json!({"id": approval})).await;
    assert_eq!(used["used_for"], approved["id"]);

    // approve_repeat_answers_the_same_approval: the same call under the same key is answered, and nothing is made again.
    let repeat = t.k.invoke(&cashier, approve("a-1", ask("manager@shop.test", "4321", "Discount", Some("15"), &w1))).await;
    let repeat = repeat.expect("approve_repeat_answers_the_same_approval: answered");
    assert!(repeat.repeated && repeat.result["approval"] == json!(approval), "approve_repeat_answers_the_same_approval: {repeat:?}");
    assert_eq!(t.approvals_for(&w1).await, 1, "approve_repeat_answers_the_same_approval: one row");

    // approve_wrong_pin_is_counted_and_leaves_nothing: refused and counted, whatever becomes of the action; no approval and no
    // receipt are kept, so the same key may try again, and with the right PIN it is done.
    let w6 = new_id();
    let wrong = t.k.invoke(&cashier, approve("a-2", ask("manager@shop.test", "1111", "Discount", Some("15"), &w6))).await;
    assert!(matches!(wrong, Err(Error::Invalid(ref m)) if m.contains("does not match")), "approve_wrong_pin_is_counted_and_leaves_nothing: {wrong:?}");
    assert_eq!(t.approvals_for(&w6).await, 0, "approve_wrong_pin_is_counted_and_leaves_nothing: no approval");
    assert_eq!(t.pin("manager@shop.test").await.map(|p| p.1), Some(1), "approve_wrong_pin_is_counted_and_leaves_nothing: the wrong try is counted");
    let receipts: i64 = {
        let mut tx = t.k.db.tenant_tx(tenant).await.unwrap();
        sqlx::query_scalar("select count(*) from logic_effect where tenant_id = $1 and effect_key = 'a-2'").bind(tenant).fetch_one(&mut *tx).await.unwrap()
    };
    assert_eq!(receipts, 0, "approve_wrong_pin_is_counted_and_leaves_nothing: no receipt");
    let right = t.k.invoke(&cashier, approve("a-2", ask("manager@shop.test", "4321", "Discount", Some("15"), &w6))).await;
    let right = right.expect("approve_wrong_pin_is_counted_and_leaves_nothing: the same key, the right PIN");
    assert!(!right.repeated && right.result["approval"].is_string(), "approve_wrong_pin_is_counted_and_leaves_nothing: {right:?}");
    assert_eq!(t.approvals_for(&w6).await, 1, "approve_wrong_pin_is_counted_and_leaves_nothing: made once");

    other["id"] = json!(new_id());
    let again = t.refused(&cashier, other).await;
    assert!(messages(&again).contains("exceeds the 5% allowed") || messages(&again).contains("already used"), "used once: {again:?}");
    let mut more = sale(off("20", "1"), json!([pay(&card, "88")]));
    more["id"] = json!(w3);
    let ok = t.act(&cashier, "PosOpeningEntry", session, "approve", ask("manager@shop.test", "4321", "Discount", Some("15"), &w3)).await.expect("approved");
    more["approvals"] = json!([{"approval": ok["approval"]}]);
    assert!(messages(&t.refused(&cashier, more.clone()).await).contains("exceeds"), "approved for 15%, not 20%: a sale changed beyond it needs a new one");
    // Lapsed: unused after the register's minutes, it covers nothing.
    let w4 = new_id();
    let ok = t.act(&cashier, "PosOpeningEntry", session, "approve", ask("manager@shop.test", "4321", "Discount", Some("15"), &w4)).await.expect("approved");
    let mut tx = t.k.db.tenant_tx(tenant).await.unwrap();
    sqlx::query("update e_pos_approval set expires_at = now() - interval '1 second' where tenant_id = $1 and id = $2")
        .bind(tenant)
        .bind(ok["approval"].as_str().unwrap().parse::<Uuid>().unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut late = sale(off("15", "1"), json!([pay(&card, "93.50")]));
    late["id"] = json!(w4);
    late["approvals"] = json!([{"approval": ok["approval"]}]);
    assert!(messages(&t.refused(&cashier, late).await).contains("exceeds the 5% allowed"), "lapsed");
    // Approved now for a sale made after the session closes: it lapses with the session.
    let w5 = new_id();
    let kept_for_later =
        t.act(&cashier, "PosOpeningEntry", session, "approve", ask("manager@shop.test", "4321", "Discount", Some("15"), &w5)).await.expect("approved");
    // The refund over the cashier's 50, approved for up to 100.
    let ok = t.act(&cashier, "PosOpeningEntry", session, "approve", ask("manager@shop.test", "4321", "Refund", Some("100"), &back_id)).await.expect("approved");
    let mut back = back;
    back["approvals"] = json!([{"approval": ok["approval"]}]);
    t.sell(&cashier, back).await;
    // Someone whose own limits do not reach cannot approve.
    let colleague = t.user("colleague@shop.test", &["Cashier"]).await;
    t.act(&colleague, "PosProfile", counter, "set_pin", json!({"pin": "2468"})).await.expect("PIN");
    let weak = t.act(&cashier, "PosOpeningEntry", session, "approve", ask("colleague@shop.test", "2468", "Void Sale", None, &w1)).await;
    assert!(matches!(weak, Err(Error::Forbidden(ref m)) if m.contains("may not approve")), "{weak:?}");

    // approve_only_in_your_own_session: another cashier does not find this session at all; a manager, who may write it, is
    // refused, although the administrator they name may approve anything.
    t.act(&a, "PosProfile", counter, "set_pin", json!({"pin": "86420"})).await.expect("the administrator's PIN");
    let theirs = t.act(&colleague, "PosOpeningEntry", session, "approve", ask("admin@shop.test", "86420", "Discount", Some("15"), &w1)).await;
    assert!(matches!(theirs, Err(Error::NotFound(_))), "approve_only_in_your_own_session: another cashier: {theirs:?}");
    let managed = t.act(&manager, "PosOpeningEntry", session, "approve", ask("admin@shop.test", "86420", "Discount", Some("15"), &w1)).await;
    assert!(
        matches!(managed, Err(Error::Forbidden(ref m)) if m.contains("in your own session")),
        "approve_only_in_your_own_session: a manager on the cashier's session: {managed:?}"
    );
    assert_eq!(t.approvals_for(&w1).await, 1, "approve_only_in_your_own_session: nothing made");
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
    let ok = t
        .act(&cashier, "PosOpeningEntry", session, "approve", ask("manager@shop.test", "4321", "Void Sale", None, kept["id"].as_str().unwrap()))
        .await
        .expect("approved");
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
        let _ = t.act(&cashier, "PosOpeningEntry", session, "approve", ask("manager@shop.test", "0000", "Discount", Some("15"), &w1)).await;
    }
    let locked = t.act(&cashier, "PosOpeningEntry", session, "approve", ask("manager@shop.test", "4321", "Discount", Some("15"), &w1)).await;
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

    // ───────────── 3. held sales, kept by the server for the holder and the managers ─────────────
    let counts = || {
        let t = &t;
        async move {
            let mut tx = t.k.db.tenant_tx(t.tenant).await.unwrap();
            let (moves, sales): (i64, i64) =
                sqlx::query_as("select (select count(*) from stock_move where tenant_id = $1), (select count(*) from e_pos_invoice where tenant_id = $1)")
                    .bind(t.tenant)
                    .fetch_one(&mut *tx)
                    .await
                    .unwrap();
            (moves, sales)
        }
    };
    let before = counts().await;
    let held = |key: &str, cart: Value| {
        json!({"id": key, "pos_profile": counter.to_string(), "cashier": "manager@shop.test", "customer_title": "Walk-in",
               "held_at": "2026-11-19T10:00:00Z", "total": "220", "cart": cart})
    };
    let basket = json!({"key": "k", "customer": {"id": null}, "lines": [{"key": "w", "item": widget.to_string(), "item_name": "widget", "qty": 2}]});
    // held_sale_is_its_holders: whatever `cashier` says, it is the caller's; a colleague neither reads nor deletes it; a manager does.
    let h1 = new_id();
    let h1u: Uuid = h1.parse().unwrap();
    let kept = t.insert(&cashier, "PosHeldSale", held(&h1, basket.clone())).await;
    assert_eq!((kept["cashier"].clone(), kept["line_count"].clone()), (json!("cashier@shop.test"), json!(1)), "held_sale_is_its_holders: {kept:?}");
    assert!(t.k.get(&colleague, "PosHeldSale", h1u, false).await.is_err(), "held_sale_is_its_holders: a colleague does not read it");
    assert!(t.k.delete(&colleague, "PosHeldSale", h1u, None).await.is_err(), "held_sale_is_its_holders: a colleague does not delete it");
    let q = ListQuery { filters: ferrum_kernel::query::parse_filters(&json!({"pos_profile": counter.to_string()})).unwrap(), ..Default::default() };
    assert!(t.k.list(&manager, "PosHeldSale", &q).await.unwrap().rows.iter().any(|r| r["id"] == json!(h1)), "held_sale_is_its_holders: a manager lists it");
    t.k.delete(&manager, "PosHeldSale", h1u, None).await.expect("held_sale_is_its_holders: a manager discards it");
    // held_sale_needs_the_register: someone a register does not admit holds nothing there.
    let back_room = uid(&t
        .insert(
            &a,
            "PosProfile",
            json!({"profile_name": "Back Room", "company": cid.to_string(), "warehouse": stores.to_string(), "price_list": selling["id"], "customer": walk_in.to_string(),
                   "invoice_prefix": "BR", "payments": [{"mode_of_payment": cash["id"], "is_default": true}], "users": [{"user": "cashier@shop.test"}]}),
        )
        .await);
    let mut there = held(&new_id(), basket.clone());
    there["pos_profile"] = json!(back_room.to_string());
    let e = t.k.insert(&colleague, "PosHeldSale", obj(there)).await.unwrap_err();
    assert!(matches!(e, Error::Forbidden(ref m) if m.contains("not allowed at register")), "held_sale_needs_the_register: {e:?}");
    // held_sale_never_keeps_a_card: a card's code or PIN on a line is refused.
    for f in ["stored_value_code", "stored_value_pin"] {
        let mut with_card = basket.clone();
        with_card["lines"][0][f] = json!("GIFT-0000-0000-0009");
        let e = t.k.insert(&cashier, "PosHeldSale", obj(held(&new_id(), with_card))).await.unwrap_err();
        assert!(messages(&e).contains("a card's code is never held"), "held_sale_never_keeps_a_card: {f}: {e:?}");
    }
    // held_sale_cart_is_bounded: a basket is 1 to 500 lines, each an item and a quantity above zero, and not too large.
    let many: Vec<Value> = (0..501).map(|i| json!({"key": format!("l{i}"), "item": widget.to_string(), "item_name": "widget", "qty": 1})).collect();
    let wrong_qty = json!({"lines": [{"key": "w", "item": widget.to_string(), "qty": 0}]});
    for (what, cart) in [
        ("no lines", json!({"lines": []})),
        ("501 lines", json!({"lines": many})),
        ("a string", json!("lines")),
        ("no quantity", wrong_qty),
        ("none", Value::Null),
    ] {
        let e = t.k.insert(&cashier, "PosHeldSale", obj(held(&new_id(), cart))).await;
        assert!(e.as_ref().is_err_and(|e| messages(e).contains("cart")), "held_sale_cart_is_bounded: {what}: {e:?}");
    }
    // held_sale_create_twice_is_one: the same create under its key is answered, and one row is kept.
    let h2 = new_id();
    let create = Invocation::new("pos.pos_held_sale.create", json!({"values": held(&h2, basket.clone())})).key(format!("held:{h2}"));
    let first = t.k.invoke(&cashier, create.clone()).await.expect("held_sale_create_twice_is_one: held");
    let again = t.k.invoke(&cashier, create).await.expect("held_sale_create_twice_is_one: held again");
    assert!(!first.repeated && again.repeated, "held_sale_create_twice_is_one: {again:?}");
    assert_eq!(t.k.list(&manager, "PosHeldSale", &q).await.unwrap().rows.iter().filter(|r| r["id"] == json!(h2)).count(), 1, "held_sale_create_twice_is_one");
    // held_sale_resumed_once: resuming deletes it; the second till to resume it finds nothing.
    let h2u: Uuid = h2.parse().unwrap();
    t.k.delete(&cashier, "PosHeldSale", h2u, None).await.expect("held_sale_resumed_once: resumed");
    let twice = t.k.delete(&cashier, "PosHeldSale", h2u, None).await;
    assert!(matches!(twice, Err(Error::NotFound(_))), "held_sale_resumed_once: {twice:?}");
    // held_sale_is_no_sale: nothing was sold and no stock moved.
    assert_eq!(counts().await, before, "held_sale_is_no_sale");
    // held_sale_is_erasable: an erasure by customer blanks its basket and the name on it.
    let pos = ferrum_app_pos::packages().unwrap().into_iter().find(|p| p.name() == "pos").expect("the package");
    assert!(
        pos.manifest.personal_data.iter().any(|d| d.entity == "PosHeldSale" && d.match_field == "customer" && d.erase.iter().any(|f| f == "cart")),
        "held_sale_is_erasable"
    );

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
    // The till kept what ERP answered for the new card's code (a handle and its last four characters), and so does the
    // invoice line it handed ERP; the submission that opened the card took what the handle named.
    let (kept, handed): (String, String) = {
        let mut tx = t.k.db.tenant_tx(t.tenant).await.unwrap();
        sqlx::query_as(
            "select p.stored_value_secret, s.stored_value_secret from e_pos_invoice__items p, e_sales_invoice__items s \
             where p.tenant_id = $1 and p.parent_id = $2 and s.tenant_id = $1 and s.parent_id = $3",
        )
        .bind(t.tenant)
        .bind(uid(&sold))
        .bind(sold["consolidated_invoice"].as_str().unwrap().parse::<Uuid>().unwrap())
        .fetch_one(&mut *tx)
        .await
        .unwrap()
    };
    assert_eq!(handed, kept, "the invoice line got what the till kept");
    assert!(kept.ends_with(":0001") && kept.len() == 69, "a handle and the last four characters: {kept}");
    let waiting = || {
        let t = &t;
        async move {
            let mut tx = t.k.db.tenant_tx(t.tenant).await.unwrap();
            let n: i64 = sqlx::query_scalar("select count(*) from stored_value_typed where tenant_id = $1").bind(t.tenant).fetch_one(&mut *tx).await.unwrap();
            n
        }
    };
    assert_eq!(waiting().await, 0, "nothing waits once the card is open");
    let told = t.site(&cashier, "POST", "/balance", Value::Null, json!({"mode": giftcard["id"], "code": "GIFT-0000-0000-0001"})).await.expect("balance");
    assert_eq!((dec(&told["balance"]), told["state"].clone()), (n("500"), json!("Active")), "{told}");
    // Taken as a tender, in part: the balance left is on the payment row.
    let mut by_card = pay(&giftcard, "110");
    by_card["stored_value_code"] = json!("gift 0000 0000 0001");
    let paid = t.sell(&cashier, sale(json!([line(widget, "1")]), json!([by_card.clone()]))).await;
    assert_eq!(dec(&paid["payments"][0]["stored_value_balance"]), n("390"), "{paid:?}");
    assert!(paid["payments"][0]["stored_value_payment"].is_string());
    // A card with a PIN: sold, its balance asked, taken; and never taken by naming its account alone.
    let pinned = t
        .sell(
            &cashier,
            sale(
                json!([{"item": card_item.to_string(), "qty": "1", "stored_value_code": "GIFT-PIN0-0000-0002", "stored_value_pin": "Pq-card-77"}]),
                json!([pay(&cash, "500")]),
            ),
        )
        .await;
    assert_eq!(pinned["items"][0]["stored_value_pin"], Value::Null);
    let told = t
        .site(&cashier, "POST", "/balance", Value::Null, json!({"mode": giftcard["id"], "code": "GIFT-PIN0-0000-0002", "pin": "Pq-card-77"}))
        .await
        .expect("balance");
    let pinned_acc = told["account"].clone();
    let mut with_pin = pay(&giftcard, "110");
    with_pin["stored_value_code"] = json!("GIFT-PIN0-0000-0002");
    with_pin["stored_value_pin"] = json!("Pq-card-77");
    t.sell(&cashier, sale(json!([line(widget, "1")]), json!([with_pin]))).await;
    let mut named = pay(&giftcard, "110");
    named["stored_value_account"] = pinned_acc.clone();
    let e = t.k.insert(&cashier, "PosInvoice", obj(sale(json!([line(widget, "1")]), json!([named])))).await.unwrap_err();
    assert!(messages(&e).contains("scan or type the card's code"), "{e:?}");
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
    // ───────────── 5. returns without a receipt and exchanges ─────────────
    let assets = uid(&t.find_one("Account", json!({"account_name": "Current Assets", "company": cid.to_string()})).await);
    let clearing = t
        .insert(
            &a,
            "Account",
            json!({"account_name": "Exchange Clearing", "company": cid.to_string(), "parent_account": assets.to_string(), "root_type": "Asset"}),
        )
        .await;
    let swap = t
        .insert(
            &a,
            "ModeOfPayment",
            json!({"mode_name": "Exchange", "mode_type": "General", "accounts": [{"company": cid.to_string(), "account": clearing["id"]}]}),
        )
        .await;
    let damaged = t.insert(&a, "Warehouse", json!({"warehouse_name": "Damaged", "company": cid.to_string()})).await;
    let policy = t
        .insert(
            &a,
            "PosReturnPolicy",
            json!({"policy_name": "Shop", "price_basis": "Lowest Price in Window", "store_credit": giftcard["id"],
                   "fees": [{"condition": "Damaged", "fee_percent": "20"}], "exchange_mode": swap["id"]}),
        )
        .await;
    assert_eq!((policy["window_days"].clone(), policy["refund_modes"].clone()), (json!(30), json!([])), "30 days, store credit only, by default");
    let unreceipted = |id: &str, pays: Value| {
        json!({"id": id, "pos_profile": counter.to_string(), "is_return": true, "without_receipt": true, "reason": faulty["id"],
               "items": [{"item": widget.to_string(), "qty": "-1", "condition": "Damaged"}], "payments": pays})
    };
    let mut onto_new = pay(&giftcard, "-74.80");
    onto_new["stored_value_code"] = json!("GIFT-CRED-0000-0003");
    let r1 = new_id();
    assert!(messages(&t.refused(&cashier, unreceipted(&r1, json!([onto_new.clone()]))).await).contains("no return policy"), "none without a policy");
    t.k.update(
        &a,
        "PosProfile",
        counter,
        obj(json!({"return_policy": policy["id"], "damaged_warehouse": damaged["id"],
                   "payments": [{"mode_of_payment": cash["id"], "is_default": true, "allow_in_returns": true}, {"mode_of_payment": card["id"], "allow_in_returns": true},
                                {"mode_of_payment": giftcard["id"], "allow_in_returns": true}, {"mode_of_payment": swap["id"], "allow_in_returns": true}]})),
        None,
    )
    .await
    .expect("the register's return policy");
    // At the lowest price sold over the window (85, a 15% sale), less the 20% fee for damaged goods, taxed: 74.80.
    let e = t.refused(&cashier, unreceipted(&r1, json!([onto_new.clone()]))).await;
    assert!(messages(&e).contains("may not take returns without a receipt"), "{e:?}");
    t.act(&manager, "PosProfile", counter, "set_pin", json!({"pin": "4321"})).await.expect("the manager's PIN again");
    let mut approvals = Vec::new();
    for (act, amount) in [("Return Without Receipt", None), ("Refund", Some("100"))] {
        let ok = t.act(&cashier, "PosOpeningEntry", session, "approve", ask("manager@shop.test", "4321", act, amount, &r1)).await.expect("approved");
        approvals.push(json!({"approval": ok["approval"]}));
    }
    let mut by_card = unreceipted(&r1, json!([pay(&card, "-74.80")]));
    by_card["approvals"] = json!(approvals);
    assert!(messages(&t.refused(&cashier, by_card.clone()).await).contains("not how the return policy refunds"), "store credit only");
    by_card["payments"] = json!([onto_new]);
    let mut offline = by_card.clone();
    offline["sold_offline"] = json!(true);
    assert!(messages(&t.refused(&cashier, offline).await).contains("online only"));
    let back_in = t.sell(&cashier, by_card).await;
    assert_eq!((dec(&back_in["rounded_total"]), back_in["items"][0]["warehouse"].clone()), (n("-74.80"), damaged["id"].clone()), "{back_in:?}");
    assert_eq!(back_in["invoiced_at_sale"], json!(true), "its own credit note at once");
    assert_eq!(balance("GIFT-CRED-0000-0003").await, n("74.80"), "refunded onto new store credit");
    // An exchange, the customer paying the difference: one widget back (with its receipt), two out. As the till does it: each
    // half a draft made under its own id, then the return's `exchange` action names the sale going out.
    let bought = t.sell(&cashier, sale(json!([line(widget, "1")]), json!([pay(&card, "110")]))).await;
    let exchange =
        |key: String, back: &Doc, out: &Doc| Invocation::new("pos.pos_invoice.exchange", json!({"id": back["id"], "params": {"out": out["id"]}})).key(key);
    let draft = |v: Value| t.insert(&cashier, "PosInvoice", v);
    let back =
        draft(json!({"pos_profile": counter.to_string(), "is_return": true, "return_against": bought["id"], "items": [line(widget, "-1")], "payments": []}))
            .await;
    let out = draft(json!({"pos_profile": counter.to_string(), "items": [line(widget, "2")], "payments": [pay(&cash, "50")]})).await;
    // exchange_is_all_or_nothing: a tender too small for what is still due: refused, and both halves stay drafts, unlinked.
    let short = t.k.invoke(&cashier, exchange("x-short".into(), &back, &out)).await;
    assert!(short.as_ref().is_err_and(|e| messages(e).contains("insufficient payment")), "exchange_is_all_or_nothing: {short:?}");
    for half in [&back, &out] {
        let now = t.find_one("PosInvoice", json!({"id": half["id"]})).await;
        assert!(now["status"] == json!("Draft") && now["exchange"].is_null(), "exchange_is_all_or_nothing: {now:?}");
    }
    t.k.update(&cashier, "PosInvoice", uid(&out), obj(json!({"payments": [pay(&cash, "110")]})), None).await.expect("the tender");
    let key = format!("exchange:{}", uid(&back));
    let done = t.k.invoke(&cashier, exchange(key.clone(), &back, &out)).await.expect("exchanged").result;
    assert_eq!((dec(&done["carried"]), dec(&done["due"]), dec(&done["refund"])), (n("110"), n("110"), Decimal::ZERO), "{done}");
    let (ret, sold) = (t.find_one("PosInvoice", json!({"id": done["return"]})).await, t.find_one("PosInvoice", json!({"id": done["sale"]})).await);
    assert_eq!(
        (ret["exchange"].clone(), sold["exchange"].clone(), done["sale_number"].clone()),
        (done["sale"].clone(), done["return"].clone(), sold["number"].clone())
    );
    assert_eq!((dec(&ret["rounded_total"]), dec(&sold["rounded_total"]), dec(&sold["total_taxes"])), (n("-110"), n("220"), n("20")));
    // exchange_repeat_is_answered_not_made_again: its answer lost, the till sends the same exchange under the same key: it is
    // answered (until 0.12.0 it was refused), and nothing is made twice.
    let again = t.k.invoke(&cashier, exchange(key, &back, &out)).await.expect("exchange_repeat_is_answered_not_made_again");
    assert!(again.repeated && again.result["sale"] == done["sale"], "exchange_repeat_is_answered_not_made_again: {again:?}");
    t.find_one("PosInvoice", json!({"exchange": done["sale"]})).await;
    t.find_one("PosInvoice", json!({"exchange": done["return"]})).await;
    // And refunded the difference as the sale was paid: two back, one out.
    let bought = t.sell(&cashier, sale(json!([line(widget, "2")]), json!([pay(&card, "220")]))).await;
    let r2 = new_id();
    let ok = t.act(&cashier, "PosOpeningEntry", session, "approve", ask("manager@shop.test", "4321", "Refund", Some("110"), &r2)).await.expect("approved");
    let back = draft(json!({"id": r2, "pos_profile": counter.to_string(), "is_return": true, "return_against": bought["id"], "items": [line(widget, "-2")],
                            "payments": [pay(&card, "-110")], "approvals": [{"approval": ok["approval"]}]}))
    .await;
    let out = draft(json!({"pos_profile": counter.to_string(), "items": [line(widget, "1")], "payments": []})).await;
    let done = t.act(&cashier, "PosInvoice", uid(&back), "exchange", json!({"out": out["id"]})).await.expect("exchanged");
    assert_eq!((dec(&done["carried"]), dec(&done["due"]), dec(&done["refund"])), (n("110"), Decimal::ZERO, n("110")), "{done}");
    // exchange_refund_onto_a_new_card: two back without a receipt (85 each, the lowest in the window, taxed: 187), one out
    // (110); the 77 left goes onto new store credit, which the card's saved row still opens after the action updates it.
    let r3 = new_id();
    let mut asked = Vec::new();
    for (act, amount) in [("Return Without Receipt", None), ("Refund", Some("100"))] {
        let ok = t.act(&cashier, "PosOpeningEntry", session, "approve", ask("manager@shop.test", "4321", act, amount, &r3)).await.expect("approved");
        asked.push(json!({"approval": ok["approval"]}));
    }
    let mut onto_card = pay(&giftcard, "-77");
    onto_card["stored_value_code"] = json!("GIFT-CRED-0000-0004");
    let back = draft(json!({"id": r3, "pos_profile": counter.to_string(), "is_return": true, "without_receipt": true, "reason": faulty["id"],
                            "items": [line(widget, "-2")], "payments": [onto_card], "approvals": asked}))
    .await;
    assert_eq!(dec(&back["rounded_total"]), n("-187"), "exchange_refund_onto_a_new_card: {back:?}");
    let out = draft(json!({"pos_profile": counter.to_string(), "items": [line(widget, "1")], "payments": []})).await;
    let done = t.act(&cashier, "PosInvoice", r3.parse().unwrap(), "exchange", json!({"out": out["id"]})).await.expect("exchange_refund_onto_a_new_card");
    assert_eq!((dec(&done["carried"]), dec(&done["refund"])), (n("110"), n("77")), "exchange_refund_onto_a_new_card: {done}");
    assert_eq!(balance("GIFT-CRED-0000-0004").await, n("77"), "exchange_refund_onto_a_new_card: the new card holds the refund");

    // A sale invoiced when the cashier asks (a customer's tax invoice now), not again at closing.
    let mut now = sale(json!([line(widget, "1")]), json!([pay(&card, "110")]));
    now["invoice_now"] = json!(true);
    let now = t.sell(&cashier, now).await;
    assert_eq!(now["invoiced_at_sale"], json!(true));
    let si = now["consolidated_invoice"].clone();
    // The day closes: invoiced sales are only settled, and the cards agree with the books.
    let close = t.insert(&cashier, "PosClosingEntry", json!({"pos_opening_entry": open["id"]})).await;
    t.k.submit(&manager, "PosClosingEntry", uid(&close), None).await.expect("close the day");
    // approve_not_on_a_closed_session: the session's own condition refuses it, in its words, before any PIN is checked.
    let closed = t.act(&cashier, "PosOpeningEntry", session, "approve", ask("manager@shop.test", "4321", "Discount", Some("15"), &new_id())).await;
    assert!(
        matches!(closed, Err(Error::Invalid(ref m)) if m == "This session is not open: an approval is for an open session"),
        "approve_not_on_a_closed_session: {closed:?}"
    );
    let mut tx = t.k.db.tenant_tx(tenant).await.unwrap();
    assert_eq!(ferrum_app_erp::stored_value::check(&a, &mut tx).await.unwrap(), Vec::<String>::new());
    drop(tx);
    let settled = t.find_one("PosInvoice", json!({"id": now["id"]})).await;
    assert_eq!((settled["consolidated_invoice"].clone(), settled["status"].clone()), (si.clone(), json!("Consolidated")), "settled, not invoiced twice");
    let inv = t.find_one("SalesInvoice", json!({"id": si})).await;
    assert_eq!(dec(&inv["outstanding_amount"]), Decimal::ZERO, "the closing paid it");
    // A closing run again issues no card again: each card sold or refunded onto at the till is one account, loaded once.
    let twice = async {
        let again = t.k.insert(&cashier, "PosClosingEntry", obj(json!({"pos_opening_entry": open["id"]}))).await?;
        t.k.submit(&manager, "PosClosingEntry", uid(&again), None).await
    };
    assert!(twice.await.is_err(), "a session closes once");
    let mut tx = t.k.db.tenant_tx(tenant).await.unwrap();
    let opened = [
        ("GIFT-0000-0000-0001", None, "issue"),
        ("GIFT-PIN0-0000-0002", Some("Pq-card-77"), "issue"),
        ("GIFT-CRED-0000-0003", None, "refund"),
        ("GIFT-CRED-0000-0004", None, "refund"),
    ];
    for (code, pin, how) in opened {
        let sec = ferrum_app_erp::stored_value::secret(tenant, code, pin).unwrap();
        let (accounts, loads): (i64, i64) = sqlx::query_as(
            "select count(distinct a.id), count(e.id) from e_stored_value_account a \
             left join stored_value_entry e on e.tenant_id = a.tenant_id and e.account_id = a.id and e.entry_type = $4 \
             where a.tenant_id = $1 and a.code_hash = $2 and a.pin_hash is not distinct from $3",
        )
        .bind(tenant)
        .bind(&sec.hash)
        .bind(&sec.pin_hash)
        .bind(how)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!((accounts, loads), (1, 1), "{code}: one card, opened once ({how}), with the PIN typed at the till");
    }
    drop(tx);
    assert_eq!(waiting().await, 0, "nothing waits for a card");
    // The approval given in the closed session covers nothing in the next one.
    let reopen = t.insert(&cashier, "PosOpeningEntry", json!({"pos_profile": counter.to_string()})).await;
    t.k.submit(&cashier, "PosOpeningEntry", uid(&reopen), None).await.expect("a new session");
    let mut after = sale(off("15", "1"), json!([pay(&card, "93.50")]));
    after["id"] = json!(w5);
    after["approvals"] = json!([{"approval": kept_for_later["approval"]}]);
    assert!(messages(&t.refused(&cashier, after).await).contains("exceeds the 5% allowed"), "lapsed with its session");

    // ───────────── neither a staff PIN nor a card's code or PIN comes to rest ─────────────
    t.act(&manager, "PosProfile", counter, "set_pin", json!({"pin": "93718264055"})).await.expect("a new PIN");
    // pin_is_never_kept: approved through the gate, the PIN is in no audit entry of an approval and not in the kept receipt.
    let reopened = json!({"id": uid(&reopen), "params": ask("manager@shop.test", "93718264055", "Discount", Some("15"), &new_id())});
    t.k.invoke(&cashier, Invocation::new("pos.pos_opening_entry.approve", reopened).key("a-3")).await.expect("pin_is_never_kept: approved");
    {
        let mut tx = t.k.db.pool.begin().await.unwrap();
        sqlx::query("select set_config('ferrum.system', 'on', true)").execute(&mut *tx).await.unwrap();
        let audited: Vec<Value> = sqlx::query_scalar("select diff from audit_event where tenant_id = $1 and action = 'action:approve'")
            .bind(tenant)
            .fetch_all(&mut *tx)
            .await
            .unwrap();
        assert!(!audited.is_empty(), "pin_is_never_kept: each approval is audited");
        for diff in &audited {
            assert!(diff["pin"] == json!("[redacted]") && !diff.to_string().contains("93718264055"), "pin_is_never_kept: audited as {diff}");
        }
        let kept: Value =
            sqlx::query_scalar("select result from logic_effect where tenant_id = $1 and capability = 'pos.pos_opening_entry.approve' and effect_key = 'a-3'")
                .bind(tenant)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        assert!(kept["approval"].is_string() && !kept.to_string().contains("93718264055"), "pin_is_never_kept: the receipt keeps {kept}");
    }
    let secrets = ["93718264055", "GIFT-0000-0000-0001", "GIFT000000000001", "GIFT-PIN0-0000-0002", "GIFTPIN000000002", "Pq-card-77"];
    let like: Vec<String> = secrets.iter().map(|s| format!("%{s}%")).collect();
    // Nor a card's code or PIN as hashes (the form ERP keeps on the card itself, and the till once kept on its lines):
    // anywhere but the card (its record, and the platform's audit entry and event of its creation), a reader finds a
    // handle and the last four characters at most.
    let mut hashes = Vec::new();
    for (code, pin) in [("GIFT-0000-0000-0001", None), ("GIFT-PIN0-0000-0002", Some("Pq-card-77")), ("GIFT-CRED-0000-0003", None)] {
        let sec = ferrum_app_erp::stored_value::secret(tenant, code, pin).unwrap();
        hashes.push(format!("%{}%", sec.hash));
        hashes.extend(sec.pin_hash.map(|p| format!("%{p}%")));
    }
    let mut tx = t.k.db.pool.begin().await.unwrap();
    sqlx::query("select set_config('ferrum.system', 'on', true)").execute(&mut *tx).await.unwrap();
    let tables: Vec<String> =
        sqlx::query_scalar("select table_name::text from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1")
            .fetch_all(&mut *tx)
            .await
            .unwrap();
    let mut rests = Vec::new();
    for table in tables {
        let hits: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select count(*) from \"{table}\" x where x::text ilike any($1) or ($3 <> 'e_stored_value_account' and x::text not like '%StoredValueAccount%' and x::text like any($2))"
        )))
        .bind(&like)
        .bind(&hashes)
        .bind(&table)
        .fetch_one(&mut *tx)
            .await
            .unwrap();
        if hits > 0 {
            rests.push(format!("{table}: {hits}"));
        }
    }
    assert_eq!(rests, Vec::<String>::new(), "a staff PIN or a card's code or PIN rests in these tables");

    // ───────────── the workspace's day and time, not UTC's ─────────────
    // A test cannot set the clock: as the platform's own suites do, the workspace moves to a zone whose day is not UTC's
    // now (UTC-11 before 10:00 UTC, UTC+14 after), and what the register dates and counts is held to the workspace's day.
    let zone = if chrono::Utc::now().hour() < 10 { "Pacific/Pago_Pago" } else { "Pacific/Kiritimati" };
    t.k.update_tenant_settings(&a, json!({"timezone": zone}).as_object().unwrap()).await.expect("the zone");
    let again = |who: &Ctx| t.k.load_ctx(tenant, who.user, None, "it".into());
    let (a, manager, colleague) = (again(&a).await.unwrap(), again(&manager).await.unwrap(), again(&colleague).await.unwrap());
    let today = a.today();
    assert_ne!(today, chrono::Utc::now().date_naive(), "the workspace's day is not UTC's");
    let day = |n: i64| (today + chrono::Duration::days(n)).to_string();
    let ago = t.insert(&colleague, "PosOpeningEntry", json!({"pos_profile": counter.to_string(), "posting_date": day(-31)})).await;
    let ago = uid(&t.k.submit(&colleague, "PosOpeningEntry", uid(&ago), None).await.expect("a session opened a month ago"));
    let at = |n: i64, items: Value| json!({"pos_profile": counter.to_string(), "pos_opening_entry": ago.to_string(), "posting_date": day(n), "items": items});
    // A till's own date may run a day ahead of the workspace's, not two; a sale it did not time is timed on the
    // workspace's clock, as it is dated.
    let ahead = t.k.insert(&colleague, "PosInvoice", obj(at(1, json!([line(widget, "1")])))).await;
    assert!(ahead.is_ok(), "a day ahead of the workspace ({}): {:?}", day(1), ahead.as_ref().err());
    let beyond = t.k.insert(&colleague, "PosInvoice", obj(at(2, json!([line(widget, "1")])))).await;
    assert!(
        matches!(beyond, Err(Error::Validation(ref e)) if e.iter().any(|f| f.field == "posting_date")),
        "two days ahead ({}): {:?}",
        day(2),
        beyond.map(|d| d["posting_date"].clone())
    );
    let ahead = ahead.unwrap();
    let timed = chrono::NaiveTime::parse_from_str(ahead["posting_time"].as_str().unwrap(), "%H:%M:%S").unwrap();
    let behind = (a.now_local().time() - timed).num_minutes().rem_euclid(24 * 60);
    assert!(behind < 5, "timed {timed}; the workspace's time is {}", a.now_local().time());
    t.k.delete(&a, "PosInvoice", uid(&ahead), None).await.expect("drop the draft");
    // The lowest the register sold a widget for over the policy's 30 days, in the workspace's days: 80 thirty days ago is
    // in, 70 the day before is out.
    let expense = uid(&t.find_one("Account", json!({"account_name": "Administrative Expenses", "company": cid.to_string()})).await);
    t.insert(
        &a,
        "LoyaltyProgram",
        json!({"program_name": "Points", "company": cid.to_string(), "conversion_factor": "1", "expiry_days": 365, "expense_account": expense.to_string(),
               "tiers": [{"tier_name": "All", "min_spent": "0", "collection_factor": "10"}]}),
    )
    .await;
    let regular = uid(&t.insert(&a, "Customer", json!({"customer_name": "Regular"})).await);
    let sold = |n: i64, off: &str, paid: &str| {
        let mut v = at(n, json!([{"item": widget.to_string(), "qty": "1", "discount_percent": off}]));
        v["customer"] = json!(regular.to_string());
        v["payments"] = json!([pay(&card, paid)]);
        v
    };
    let outside = t.sell(&manager, sold(-31, "30", "77")).await;
    let inside = t.sell(&manager, sold(-30, "20", "88")).await;
    let unreceipted = json!({"pos_profile": counter.to_string(), "pos_opening_entry": ago.to_string(), "is_return": true, "without_receipt": true,
                             "items": [line(widget, "-1")]});
    let back = t.insert(&manager, "PosInvoice", unreceipted).await;
    assert_eq!(dec(&back["items"][0]["price_list_rate"]), n("80"), "the lowest over the workspace's last 30 days");
    t.k.delete(&a, "PosInvoice", uid(&back), None).await.expect("drop the draft");
    // Points that ran out yesterday where the workspace is go; points good until today stay.
    let mut tx = t.k.db.tenant_tx(tenant).await.unwrap();
    for (sale, until) in [(&outside, day(-1)), (&inside, day(0))] {
        sqlx::query("update e_loyalty_point_entry set expiry_date = $3::date where tenant_id = $1 and pos_invoice = $2 and entry_type = 'Earn'")
            .bind(tenant)
            .bind(uid(sale))
            .bind(until)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    ferrum_app_pos::maintenance(&t.k, t.tenant).await.expect("expiry");
    let mut tx = t.k.db.tenant_tx(tenant).await.unwrap();
    let left: Vec<i64> = sqlx::query_scalar(
        "select remaining from e_loyalty_point_entry where tenant_id = $1 and pos_invoice = any($2) and entry_type = 'Earn' order by posting_date",
    )
    .bind(tenant)
    .bind(vec![uid(&outside), uid(&inside)])
    .fetch_all(&mut *tx)
    .await
    .unwrap();
    drop(tx);
    assert_eq!(left, vec![0, 8], "expired yesterday, good until today");
    // A scan shows the price in force on the workspace's day.
    let gum = uid(&t.insert(&a, "Item", item("GUM")).await);
    for (from, upto, rate) in [(day(0), Value::String(day(0)), "7"), (day(1), Value::Null, "8")] {
        t.insert(&a, "ItemPrice", json!({"item": gum.to_string(), "price_list": selling["id"], "rate": rate, "valid_from": from, "valid_upto": upto})).await;
    }
    let ask: std::collections::HashMap<String, String> = [("pos_profile".to_string(), counter.to_string()), ("code".to_string(), "GUM".to_string())].into();
    let found = ferrum_app_pos::reports()[0].run(&t.k, &colleague, "pos_item_lookup", &ask).await.expect("the lookup");
    assert_eq!(dec(&found["rows"][0]["rate"]), n("7"), "the price in force on the workspace's day");
}
