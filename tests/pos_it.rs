//! End-to-end POS test against a real PostgreSQL (`FERRUM_POS_TEST_DATABASE_URL`, default
//! `postgres://ferrum:ferrum@localhost:5432/ferrum_pos_test`). The database is reset first.
//!
//! A shop with two registers runs a day the way a POS client would drive the API: a cashier opens
//! a session, scans items, rings up split payments with change, offline replays, refused sales,
//! discounts, loyalty, a sale on account, a return, cash movements; a manager closes the session
//! with a cash shortage, the closing consolidates into sales invoices whose postings must equal the
//! register's totals exactly, is cancelled and redone, and a later return is consolidated against
//! the earlier invoice.

use ferrum_kernel::tenant::NewTenant;
use ferrum_kernel::{Ctx, Db, DbConfig, Doc, Error, HookRegistry, Kernel, KernelSettings, ListQuery};
use ferrum_meta::Catalog;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use uuid::Uuid;

fn obj(v: Value) -> Doc {
    v.as_object().cloned().unwrap()
}

fn dec(v: &Value) -> Decimal {
    match v {
        Value::String(s) => Decimal::from_str(s).unwrap_or_else(|_| panic!("not a decimal: {s}")),
        Value::Number(n) => Decimal::from_str(&n.to_string()).unwrap(),
        Value::Null => Decimal::ZERO,
        other => panic!("not a decimal: {other}"),
    }
}

fn n(s: &str) -> Decimal {
    Decimal::from_str(s).unwrap()
}

fn uid(doc: &Doc) -> Uuid {
    doc["id"].as_str().unwrap().parse().unwrap()
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
    async fn submit(&self, ctx: &Ctx, entity: &str, id: Uuid) -> Doc {
        self.k.submit(ctx, entity, id, None).await.unwrap_or_else(|e| panic!("submit {entity}: {e:?}"))
    }
    /// Create and submit, as a register does for every sale.
    async fn sell(&self, ctx: &Ctx, v: Value) -> Doc {
        let d = self.insert(ctx, "PosInvoice", v).await;
        self.submit(ctx, "PosInvoice", uid(&d)).await
    }
    /// Create, then submit; returns the submit error (the draft is deleted).
    async fn refused(&self, ctx: &Ctx, v: Value) -> Error {
        let d = match self.k.insert(ctx, "PosInvoice", obj(v)).await {
            Ok(d) => d,
            Err(e) => return e,
        };
        let e = self.k.submit(ctx, "PosInvoice", uid(&d), None).await.expect_err("the sale should be refused");
        self.k.delete(&self.admin, "PosInvoice", uid(&d), None).await.expect("drop the refused draft");
        e
    }
    async fn get(&self, entity: &str, id: Uuid) -> Doc {
        self.k.get(&self.admin, entity, id, false).await.unwrap_or_else(|e| panic!("get {entity}: {e:?}"))
    }
    async fn find_one(&self, entity: &str, filters: Value) -> Doc {
        let page = self
            .k
            .list(&self.admin, entity, &ListQuery { filters: ferrum_kernel::query::parse_filters(&filters).unwrap(), ..Default::default() })
            .await
            .unwrap();
        assert_eq!(page.rows.len(), 1, "{entity} {filters}");
        page.rows[0].clone()
    }
    async fn count(&self, sql: &str, id: Option<Uuid>) -> i64 {
        let mut tx = self.k.db.tenant_tx(self.tenant).await.unwrap();
        sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string())).bind(self.tenant).bind(id).fetch_one(&mut *tx).await.unwrap()
    }
    /// Debit minus credit on an account (by name) across all postings.
    async fn gl(&self, account: &str) -> Decimal {
        let mut tx = self.k.db.tenant_tx(self.tenant).await.unwrap();
        sqlx::query_scalar(
            "select coalesce(sum(l.debit - l.credit), 0) from journal_line l join e_account a on a.tenant_id = l.tenant_id and a.id = l.account_id \
             where l.tenant_id = $1 and a.account_name = $2",
        )
        .bind(self.tenant)
        .bind(account)
        .fetch_one(&mut *tx)
        .await
        .unwrap()
    }
    async fn stock(&self, item: Uuid, wh: Uuid) -> (Decimal, Decimal) {
        let mut tx = self.k.db.tenant_tx(self.tenant).await.unwrap();
        sqlx::query_as::<_, (Decimal, Decimal)>("select qty, value from stock_balance where tenant_id = $1 and item_id = $2 and warehouse_id = $3")
            .bind(self.tenant)
            .bind(item)
            .bind(wh)
            .fetch_optional(&mut *tx)
            .await
            .unwrap()
            .unwrap_or_default()
    }
    async fn report(&self, ctx: &Ctx, name: &str, params: &[(&str, String)]) -> Value {
        let p: HashMap<String, String> = params.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
        ferrum_domain::reports::run(&self.k, ctx, name, &p).await.unwrap_or_else(|e| panic!("report {name}: {e:?}"))
    }
    async fn user(&self, email: &str, role: &str) -> Ctx {
        let id = self.k.create_user(&self.admin, email, email, Some("Correct-Horse-9"), &[role.into()], false).await.expect("user");
        self.k.load_ctx(self.tenant, id, None, "it".into()).await.expect("ctx")
    }
    /// Every journal entry balances, the trial balance balances, stock equals its accounts.
    async fn books_balance(&self, company: Uuid) {
        let tb = self.report(&self.admin, "trial_balance", &[("company", company.to_string())]).await;
        assert_eq!(tb["meta"]["balanced"], json!(true), "{}", tb["totals"]);
        let unbalanced = self
            .count("select count(*) from (select entry_id from journal_line where tenant_id = $1 and $2::uuid is null group by entry_id having sum(debit) <> sum(credit)) x", None)
            .await;
        assert_eq!(unbalanced, 0);
        let sb = self.report(&self.admin, "stock_balance", &[("company", company.to_string())]).await;
        assert_eq!(dec(&sb["totals"]["value"]), self.gl("Stock In Hand").await, "perpetual inventory: stock value equals the stock account");
    }
}

fn line(item: Uuid, qty: &str) -> Value {
    json!({"item": item.to_string(), "qty": qty})
}

fn pay(mode: &Doc, amount: &str) -> Value {
    json!({"mode_of_payment": mode["id"], "amount": amount})
}

#[test]
fn pos_end_to_end() {
    // Same runtime shape as the server: unoptimized async hook chains need more than 2 MiB.
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
    for source in ferrum_app_erp::reports() {
        ferrum_domain::reports::add_source(source);
    }
    ferrum_app_pos::register(&mut hooks);
    for source in ferrum_app_pos::reports() {
        ferrum_domain::reports::add_source(source);
    }
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

    // ───────────── the shop: company, tax, items with stock, registers ─────────────
    let inr = t.find_one("Currency", json!({"code": "INR"})).await;
    let company = t.insert(&a, "Company", json!({"company_name": "Corner Shop", "abbr": "CS", "default_currency": inr["id"], "round_total_to": "0.05"})).await;
    let cid = uid(&company);
    let account = |name: &'static str| {
        let t = &t;
        async move { uid(&t.find_one("Account", json!({"account_name": name, "company": cid.to_string()})).await) }
    };
    let output_tax = account("Output Tax").await;
    let indirect = account("Indirect Expenses").await;
    let admin_expenses = account("Administrative Expenses").await;
    let bank = account("Primary Bank").await;
    let loyalty_account = uid(&t
        .insert(&a, "Account", json!({"account_name": "Loyalty Redemptions", "company": cid.to_string(), "parent_account": indirect.to_string(), "root_type": "Expense", "account_type": "Expense"}))
        .await);
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
    let item = |code: &str, extra: Value| {
        let mut v = json!({"item_code": code, "item_name": code.to_lowercase(), "item_group": products["id"], "stock_uom": nos["id"]});
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    };
    let widget = uid(&t.insert(&a, "Item", item("WIDGET", json!({}))).await);
    let pen = uid(&t.insert(&a, "Item", item("PEN", json!({"barcode": "8901234567890"}))).await);
    let gum = uid(&t.insert(&a, "Item", item("GUM", json!({}))).await);
    let phone = uid(&t.insert(&a, "Item", item("PHONE", json!({"has_serial_no": true}))).await);
    for (it, rate) in [(widget, "100"), (pen, "9.99"), (gum, "2"), (phone, "500")] {
        t.insert(&a, "ItemPrice", json!({"item": it.to_string(), "price_list": selling["id"], "rate": rate, "valid_from": "2020-01-01"})).await;
    }
    let opening = t
        .insert(
            &a,
            "StockEntry",
            json!({"company": cid.to_string(), "purpose": "Opening Stock", "items": [
                {"item": widget.to_string(), "qty": "50", "basic_rate": "60", "target_warehouse": stores.to_string()},
                {"item": pen.to_string(), "qty": "100", "basic_rate": "4", "target_warehouse": stores.to_string()},
                {"item": gum.to_string(), "qty": "5", "basic_rate": "1", "target_warehouse": stores.to_string()},
                {"item": phone.to_string(), "qty": "2", "basic_rate": "300", "serial_no": "SN-1\nSN-2", "target_warehouse": stores.to_string()}]}),
        )
        .await;
    t.submit(&a, "StockEntry", uid(&opening)).await;

    let mode = |name: &'static str| {
        let t = &t;
        async move { t.find_one("ModeOfPayment", json!({"mode_name": name})).await }
    };
    let (cash, card, credit, points) = (mode("Cash").await, mode("Card").await, mode("Credit").await, mode("Loyalty Points").await);
    let walk_in = uid(&t.find_one("Customer", json!({"customer_name": "Walk-in Customer"})).await);
    let payments = json!([
        {"mode_of_payment": cash["id"], "is_default": true, "allow_in_returns": true},
        {"mode_of_payment": card["id"], "allow_in_returns": true},
        {"mode_of_payment": credit["id"], "allow_in_returns": true},
        {"mode_of_payment": points["id"], "allow_in_returns": true}]);
    let counter1 = uid(&t
        .insert(
            &a,
            "PosProfile",
            json!({"profile_name": "Counter 1", "company": cid.to_string(), "warehouse": stores.to_string(), "price_list": selling["id"],
                   "customer": walk_in.to_string(), "invoice_prefix": "c1", "payments": payments, "write_off_limit": "0.10",
                   "allow_discount_change": true, "max_discount": "10"}),
        )
        .await);
    let counter2 = uid(&t
        .insert(
            &a,
            "PosProfile",
            json!({"profile_name": "Counter 2", "company": cid.to_string(), "warehouse": stores.to_string(), "customer": walk_in.to_string(),
                   "invoice_prefix": "C2", "payments": payments, "allow_negative_stock": true}),
        )
        .await);
    t.insert(&a, "ItemBarcode", json!({"barcode": "BOX-WIDGET", "item": widget.to_string(), "qty": "2"})).await;

    // ───────────── the price book: what a till prices offline with ─────────────
    let req = ferrum_kernel::SiteRequest {
        tenant,
        user: Some(a.clone()),
        method: "GET".into(),
        path: "/pricebook".into(),
        query: json!({"profile": counter1.to_string()}).as_object().cloned().unwrap(),
        headers: Default::default(),
        body: vec![],
        client_ip: "it".into(),
    };
    let book = ferrum_app_pos::site::price_book(&t.k, &a, &req).await.expect("price book");
    let line_of = |item: Uuid| book["items"].as_array().unwrap().iter().find(|i| i["id"] == json!(item.to_string())).cloned().expect("in the book");
    assert_eq!(book["items"].as_array().unwrap().len(), 4, "{book}");
    assert_eq!((line_of(pen)["line"]["price"].clone(), line_of(pen)["barcode"].clone()), (json!("9.99"), json!("8901234567890")));
    assert!(book["barcodes"].as_array().unwrap().iter().any(|b| b["barcode"] == json!("BOX-WIDGET")), "{book}");
    assert_eq!(book["next"], Value::Null);
    // The same engine, from the book, totals a cart exactly as the server does.
    let mut engine = book["engine"].clone();
    engine["lines"] = json!([
        {"key": "a", "qty": "3", "price": line_of(pen)["line"]["price"], "tax_rates": line_of(pen)["line"]["tax_rates"]},
        {"key": "b", "qty": "2", "price": line_of(widget)["line"]["price"], "tax_rates": line_of(widget)["line"]["tax_rates"]},
    ]);
    let offline = ferrum_calc::compute(&serde_json::from_value(engine).expect("engine input")).expect("offline totals");
    let online =
        t.k.preview(
            &a,
            "PosInvoice",
            obj(json!({"pos_profile": counter1.to_string(), "items": [{"item": pen.to_string(), "qty": "3"}, {"item": widget.to_string(), "qty": "2"}]})),
        )
        .await
        .expect("server totals");
    let dec = |v: &Value| v.as_str().unwrap().parse::<rust_decimal::Decimal>().unwrap();
    assert_eq!((offline.grand_total, offline.rounded_total), (dec(&online["grand_total"]), dec(&online["rounded_total"])), "{online:?}");
    assert_eq!(offline.rounded_total, rust_decimal::Decimal::new(25295, 2), "3 × 9.99 + 2 × 100 = 229.97, VAT 10% 23.00, 252.97 → 252.95");
    // An item without a price in the register's price list is left out (sold online only), and named.
    let unpriced = uid(&t.insert(&a, "Item", item("NOPRICE", json!({}))).await);
    let again = ferrum_app_pos::site::price_book(&t.k, &a, &req).await.expect("price book");
    assert_eq!(again["items"].as_array().unwrap().len(), 4, "{again}");
    assert_eq!(again["unpriced"][0]["id"], json!(unpriced.to_string()), "{again}");
    t.k.update(&a, "Item", unpriced, obj(json!({"disabled": true})), None).await.expect("disable it again");
    let refused = ferrum_kernel::SiteRequest { query: json!({"profile": "nonsense"}).as_object().cloned().unwrap(), ..req.clone() };
    assert!(ferrum_app_pos::site::price_book(&t.k, &a, &refused).await.is_err(), "a register is required");
    let clash = t.k.insert(&a, "ItemBarcode", obj(json!({"barcode": "8901234567890", "item": widget.to_string()}))).await;
    assert!(matches!(clash, Err(Error::Validation(ref e)) if e.iter().any(|f| f.field == "barcode")), "a scan must find one item: {clash:?}");
    t.insert(
        &a,
        "LoyaltyProgram",
        json!({"program_name": "Rewards", "company": cid.to_string(), "conversion_factor": "0.5", "expiry_days": 365, "expense_account": loyalty_account.to_string(),
               "tiers": [{"tier_name": "Base", "min_spent": "0", "collection_factor": "10"}, {"tier_name": "Silver", "min_spent": "100", "collection_factor": "5"}]}),
    )
    .await;
    let alice = uid(&t.insert(&a, "Customer", json!({"customer_name": "Alice"})).await);
    let bob = uid(&t.insert(&a, "Customer", json!({"customer_name": "Bob"})).await);
    let carol = uid(&t.insert(&a, "Customer", json!({"customer_name": "Carol", "credit_limit": "5"})).await);

    let cashier = t.user("cashier@shop.test", "Cashier").await;
    let manager = t.user("manager@shop.test", "POS Manager").await;
    let other = t.user("other@shop.test", "Cashier").await;

    // ───────────── opening the session ─────────────
    let open = t
        .insert(
            &cashier,
            "PosOpeningEntry",
            json!({"pos_profile": counter1.to_string(), "balance_details": [{"mode_of_payment": cash["id"], "opening_amount": "500"}]}),
        )
        .await;
    assert_eq!(open["user"], json!("cashier@shop.test"));
    let s1 = uid(&t.submit(&cashier, "PosOpeningEntry", uid(&open)).await);
    assert_eq!(t.get("PosOpeningEntry", s1).await["status"], json!("Open"));
    let twice = t.insert(&cashier, "PosOpeningEntry", json!({"pos_profile": counter1.to_string()})).await;
    let twice = t.k.submit(&cashier, "PosOpeningEntry", uid(&twice), None).await;
    assert!(matches!(twice, Err(Error::Invalid(ref m)) if m.contains("already has an open session")), "{twice:?}");
    let for_someone = t.k.insert(&cashier, "PosOpeningEntry", obj(json!({"pos_profile": counter2.to_string(), "user": "other@shop.test"}))).await;
    assert!(for_someone.is_err(), "only a manager opens sessions for others");

    // ───────────── scanning ─────────────
    let scan = |code: &'static str| {
        let (t, cashier) = (&t, &cashier);
        async move { t.report(cashier, "pos_item_lookup", &[("pos_profile", counter1.to_string()), ("code", code.to_string())]).await["rows"].clone() }
    };
    let box_scan = scan("BOX-WIDGET").await;
    assert_eq!(box_scan[0]["item"], json!(widget.to_string()));
    assert_eq!((dec(&box_scan[0]["qty"]), dec(&box_scan[0]["rate"]), dec(&box_scan[0]["actual_qty"])), (n("2"), n("100"), n("50")));
    let pen_scan = scan("8901234567890").await;
    assert_eq!((pen_scan[0]["item_code"].clone(), dec(&pen_scan[0]["qty"]), dec(&pen_scan[0]["rate"])), (json!("PEN"), n("1"), n("9.99")));
    assert_eq!(scan("GUM").await[0]["item"], json!(gum.to_string()), "item codes scan too");
    assert_eq!(scan("NOPE").await.as_array().unwrap().len(), 0);
    let search = t.report(&cashier, "pos_item_lookup", &[("pos_profile", counter1.to_string()), ("search", "pe".into())]).await;
    assert!(search["rows"].as_array().unwrap().iter().any(|r| r["item_code"] == json!("PEN")));

    // ───────────── a split payment with change, created offline-safe ─────────────
    let sale_id = Uuid::now_v7();
    let sale_a = json!({"id": sale_id.to_string(), "pos_profile": counter1.to_string(), "posting_time": "10:15:00",
        "items": [line(widget, "2"), line(pen, "1")], "payments": [pay(&card, "100"), pay(&cash, "150")]});
    let key = sale_id.to_string();
    let (draft, replayed) = t.k.insert_idempotent(&cashier, "PosInvoice", obj(sale_a.clone()), &key, "h-sale-a").await.expect("create");
    assert!(!replayed);
    let (again, replayed) = t.k.insert_idempotent(&cashier, "PosInvoice", obj(sale_a.clone()), &key, "h-sale-a").await.expect("replay");
    assert!(replayed, "an offline replay returns the original");
    assert_eq!(again["id"], draft["id"]);
    // After the idempotency window the client-generated id still refuses a second sale.
    let late = t.k.insert(&cashier, "PosInvoice", obj(sale_a.clone())).await;
    assert!(matches!(late, Err(Error::Conflict(_))), "{late:?}");
    assert_eq!(t.count("select count(*) from e_pos_invoice where tenant_id = $1 and id = $2", Some(sale_id)).await, 1);
    assert_eq!(dec(&draft["net_total"]), n("209.99"));
    assert_eq!(dec(&draft["total_taxes"]), n("21.00"));
    assert_eq!((dec(&draft["grand_total"]), dec(&draft["rounded_total"])), (n("230.99"), n("231.00")), "cash rounding to 0.05");
    assert_eq!((dec(&draft["paid_amount"]), dec(&draft["change_amount"])), (n("250"), n("19")));
    assert_eq!(draft["cashier"], json!("cashier@shop.test"));
    assert_eq!(draft["pos_opening_entry"], json!(s1.to_string()), "the cashier's open session is found");
    let cogs_before = t.gl("Cost of Goods Sold").await;
    let sale_a = t.submit(&cashier, "PosInvoice", sale_id).await;
    assert_eq!(sale_a["status"], json!("Paid"));
    assert!(sale_a["number"].as_str().unwrap().starts_with("C1-"), "numbered per register: {}", sale_a["number"]);
    assert_eq!(t.stock(widget, stores).await.0, n("48"), "stock leaves at once");
    assert_eq!(t.stock(pen, stores).await.0, n("99"));
    assert_eq!(t.gl("Cost of Goods Sold").await - cogs_before, n("124"), "valued like a delivery: 2 × 60 + 4");
    assert_eq!(t.gl("Sales").await, Decimal::ZERO, "revenue waits for the closing");
    let resubmit = t.k.submit(&cashier, "PosInvoice", sale_id, None).await;
    assert!(resubmit.is_err(), "a replayed submit cannot sell twice");

    // ───────────── refusals ─────────────
    let simple = |items: Value, pays: Value| json!({"pos_profile": counter1.to_string(), "items": items, "payments": pays});
    let short = t.refused(&cashier, simple(json!([line(widget, "1")]), json!([pay(&cash, "50")]))).await;
    assert!(matches!(short, Error::Validation(ref e) if e.iter().any(|f| f.message.contains("insufficient"))), "{short:?}");
    let over = t.refused(&cashier, simple(json!([line(widget, "1")]), json!([pay(&card, "120")]))).await;
    assert!(matches!(over, Error::Validation(ref e) if e.iter().any(|f| f.message.contains("only cash can be overpaid"))), "{over:?}");
    let too_many =
        t.refused(&cashier, simple(json!([{"item": phone.to_string(), "qty": "3", "serial_no": "SN-1\nSN-2\nSN-3"}]), json!([pay(&card, "1650")]))).await;
    assert!(matches!(too_many, Error::Invalid(ref m) if m.contains("not enough stock")), "{too_many:?}");
    let early =
        t.k.insert(&cashier, "PosInvoice", obj(json!({"pos_profile": counter1.to_string(), "posting_date": "2020-01-01", "items": [line(pen, "1")]}))).await;
    assert!(matches!(early, Err(Error::Validation(ref e)) if e.iter().any(|f| f.field == "posting_date")), "outside the session: {early:?}");
    let not_mine =
        t.k.insert(&other, "PosInvoice", obj(json!({"pos_profile": counter1.to_string(), "pos_opening_entry": s1.to_string(), "items": [line(pen, "1")]})))
            .await;
    assert!(matches!(not_mine, Err(Error::Forbidden(_))), "{not_mine:?}");
    let walk_in_credit = t.k.insert(&cashier, "PosInvoice", obj(simple(json!([line(pen, "1")]), json!([pay(&credit, "11")])))).await;
    assert!(walk_in_credit.is_err(), "the walk-in customer cannot buy on account");
    let carol_sale = json!({"pos_profile": counter1.to_string(), "customer": carol.to_string(), "items": [line(pen, "1")], "payments": [pay(&credit, "11")]});
    let limit = t.refused(&cashier, carol_sale).await;
    assert!(matches!(limit, Error::Invalid(ref m) if m.contains("credit limit")), "{limit:?}");

    // ───────────── discounts and prices ─────────────
    let mut fifteen = simple(json!([{"item": widget.to_string(), "qty": "1", "discount_percent": "15"}]), json!([pay(&cash, "93.50")]));
    let refused = t.k.insert(&cashier, "PosInvoice", obj(fifteen.clone())).await;
    assert!(matches!(refused, Err(Error::Validation(ref e)) if e.iter().any(|f| f.message.contains("exceeds the 10% allowed"))), "{refused:?}");
    let repriced = t.k.insert(&cashier, "PosInvoice", obj(simple(json!([{"item": widget.to_string(), "qty": "1", "manual_rate": "80"}]), json!([])))).await;
    assert!(matches!(repriced, Err(Error::Validation(ref e)) if e.iter().any(|f| f.field == "manual_rate")), "{repriced:?}");
    let ten = t.sell(&cashier, simple(json!([{"item": widget.to_string(), "qty": "1", "discount_percent": "10"}]), json!([pay(&card, "99")]))).await;
    assert_eq!(dec(&ten["rounded_total"]), n("99"));
    fifteen["pos_opening_entry"] = json!(s1.to_string());
    let by_manager = t.sell(&manager, fifteen).await;
    assert_eq!(dec(&by_manager["rounded_total"]), n("93.50"), "a POS manager may give more");
    assert_eq!(by_manager["cashier"], json!("cashier@shop.test"));

    // ───────────── write-off, loyalty, a sale on account ─────────────
    let small = t.sell(&cashier, simple(json!([line(pen, "1")]), json!([pay(&cash, "10.95")]))).await;
    assert_eq!((dec(&small["rounded_total"]), dec(&small["write_off_amount"])), (n("11.00"), n("0.05")));
    let alice_1 = t
        .sell(
            &cashier,
            json!({"pos_profile": counter1.to_string(), "customer": alice.to_string(), "items": [line(widget, "1")], "payments": [pay(&cash, "110")]}),
        )
        .await;
    assert_eq!(alice_1["loyalty_points_earned"], json!(11), "110 at one point per 10");
    let greedy =
        t.k.insert(
            &cashier,
            "PosInvoice",
            obj(json!({"pos_profile": counter1.to_string(), "customer": alice.to_string(), "items": [line(pen, "1")],
                       "payments": [{"mode_of_payment": points["id"], "loyalty_points": 30}]})),
        )
        .await
        .unwrap();
    let greedy = t.k.submit(&cashier, "PosInvoice", uid(&greedy), None).await;
    assert!(greedy.is_err(), "30 points are not available: {greedy:?}");
    let drafts: Vec<Uuid> =
        t.k.list(&t.admin, "PosInvoice", &ListQuery { filters: ferrum_kernel::query::parse_filters(&json!({"docstatus": 0})).unwrap(), ..Default::default() })
            .await
            .unwrap()
            .rows
            .iter()
            .map(uid)
            .collect();
    for d in drafts {
        t.k.delete(&t.admin, "PosInvoice", d, None).await.unwrap();
    }
    let alice_2 = t
        .sell(
            &cashier,
            json!({"pos_profile": counter1.to_string(), "customer": alice.to_string(), "items": [line(pen, "1")],
                   "payments": [{"mode_of_payment": points["id"], "loyalty_points": 4}, pay(&cash, "9")]}),
        )
        .await;
    assert_eq!(dec(&alice_2["payments"][0]["amount"]), n("2"), "4 points at 0.5");
    assert_eq!(alice_2["loyalty_points_earned"], json!(1), "9 paid at the silver rate of one point per 5");
    let alice_points = t.count("select coalesce(sum(points), 0)::bigint from e_loyalty_point_entry where tenant_id = $1 and customer = $2", Some(alice)).await;
    assert_eq!(alice_points, 11 - 4 + 1);
    let on_account = t
        .sell(&cashier, json!({"pos_profile": counter1.to_string(), "customer": bob.to_string(), "items": [line(pen, "1")], "payments": [pay(&credit, "11")]}))
        .await;
    assert_eq!(on_account["status"], json!("Unpaid"));

    // ───────────── negative stock where the register allows it ─────────────
    let s2 = t.insert(&cashier, "PosOpeningEntry", json!({"pos_profile": counter2.to_string()})).await;
    let s2 = uid(&t.submit(&cashier, "PosOpeningEntry", uid(&s2)).await);
    let gum_sale = t.sell(&cashier, json!({"pos_profile": counter2.to_string(), "items": [line(gum, "8")], "payments": [pay(&cash, "17.60")]})).await;
    assert_eq!(gum_sale["number"].as_str().unwrap().split('-').next(), Some("C2"));
    assert_eq!(t.stock(gum, stores).await.0, n("-3"));

    // ───────────── a return ─────────────
    let ret = |qty: &str, refund: Value| {
        json!({"pos_profile": counter1.to_string(), "is_return": true, "return_against": sale_id.to_string(),
               "items": [{"item": widget.to_string(), "qty": qty}], "payments": refund})
    };
    let excess = t.refused(&cashier, ret("-3", json!([pay(&cash, "-330")]))).await;
    assert!(matches!(excess, Error::Validation(ref e) if e.iter().any(|f| f.message.contains("can still come back"))), "{excess:?}");
    let as_credit = t
        .refused(
            &cashier,
            json!({"pos_profile": counter1.to_string(), "is_return": true, "return_against": alice_1["id"], "items": [line(widget, "-1")],
                   "payments": [pay(&credit, "-110")]}),
        )
        .await;
    assert!(
        matches!(as_credit, Error::Validation(ref e) if e.iter().any(|f| f.message.contains("paid in full"))),
        "cash paid, so no refund on account: {as_credit:?}"
    );
    let widget_value = t.stock(widget, stores).await.1;
    let returned = t.sell(&cashier, ret("-1", json!([pay(&cash, "-110")]))).await;
    assert_eq!((returned["status"].clone(), dec(&returned["rounded_total"])), (json!("Return"), n("-110")));
    assert_eq!(t.stock(widget, stores).await.1 - widget_value, n("60"), "back at the cost it left at");
    assert_eq!(dec(&returned["items"][0]["price_list_rate"]), n("100"), "priced from the sale");
    let still = t.refused(&cashier, ret("-2", json!([pay(&cash, "-220")]))).await;
    assert!(matches!(still, Error::Validation(_)), "one widget of two already came back: {still:?}");

    // ───────────── a void before closing ─────────────
    let void = t.sell(&cashier, simple(json!([line(pen, "2")]), json!([pay(&cash, "22")]))).await;
    let denied = t.k.cancel(&cashier, "PosInvoice", uid(&void), None).await;
    assert!(matches!(denied, Err(Error::Forbidden(_))), "cashiers cannot void: {denied:?}");
    let pen_before = t.stock(pen, stores).await.0;
    t.k.cancel(&manager, "PosInvoice", uid(&void), None).await.expect("manager voids");
    assert_eq!(t.stock(pen, stores).await.0 - pen_before, n("2"));

    // ───────────── cash in and out of the drawer ─────────────
    let float = t
        .insert(
            &cashier,
            "PosCashMovement",
            json!({"pos_opening_entry": s1.to_string(), "movement_type": "Cash In", "amount": "50", "account": bank.to_string(), "reason": "Float top-up"}),
        )
        .await;
    t.submit(&cashier, "PosCashMovement", uid(&float)).await;
    let petty = t
        .insert(&cashier, "PosCashMovement", json!({"pos_opening_entry": s1.to_string(), "movement_type": "Cash Out", "amount": "20", "account": admin_expenses.to_string(), "reason": "Milk for the staff room"}))
        .await;
    t.submit(&cashier, "PosCashMovement", uid(&petty)).await;

    // ───────────── X report, then closing with a shortage ─────────────
    let x = t.report(&cashier, "pos_sales_summary", &[("company", cid.to_string()), ("pos_opening_entry", s1.to_string())]).await;
    assert_eq!(x["meta"]["session"]["report"], json!("X"));
    let recon = x["meta"]["session"]["reconciliation"].as_array().unwrap().clone();
    let expected_cash = dec(&recon.iter().find(|r| r["mode_of_payment"] == json!("Cash")).unwrap()["expected"]);
    // 500 float + 131 + 93.50 + 10.95 + 110 + 9 - 110 refund + 50 - 20 (the void gave its cash back).
    assert_eq!(expected_cash, n("774.45"));
    let sales = [&sale_a, &ten, &by_manager, &small, &alice_1, &alice_2, &on_account, &returned];
    let net: Decimal = sales.iter().map(|s| dec(&s["net_total"])).sum();
    let taxes: Decimal = sales.iter().map(|s| dec(&s["total_taxes"])).sum();
    let rounding: Decimal = sales.iter().map(|s| dec(&s["rounding_adjustment"])).sum();

    let closing = t
        .insert(
            &cashier,
            "PosClosingEntry",
            json!({"pos_opening_entry": s1.to_string(), "payments": [{"mode_of_payment": card["id"], "closing_amount": "199"}],
                   "denominations": [{"denomination": "500", "count": 1}, {"denomination": "100", "count": 2}, {"denomination": "50", "count": 1},
                                     {"denomination": "20", "count": 1}, {"denomination": "2", "count": 1}, {"denomination": "0.05", "count": 9}]}),
        )
        .await;
    let cash_row = closing["payments"].as_array().unwrap().iter().find(|r| r["mode_of_payment"] == cash["id"]).unwrap().clone();
    assert_eq!((dec(&cash_row["expected_amount"]), dec(&cash_row["closing_amount"]), dec(&cash_row["difference"])), (n("774.45"), n("772.45"), n("-2")));
    let refused = t.k.submit(&cashier, "PosClosingEntry", uid(&closing), None).await;
    assert!(matches!(refused, Err(Error::Forbidden(_))), "a manager closes: {refused:?}");
    let draft_left = t.insert(&cashier, "PosInvoice", simple(json!([line(pen, "1")]), json!([pay(&cash, "11")]))).await;
    let blocked = t.k.submit(&manager, "PosClosingEntry", uid(&closing), None).await;
    assert!(matches!(blocked, Err(Error::Invalid(ref m)) if m.contains("unfinished")), "{blocked:?}");
    t.k.delete(&cashier, "PosInvoice", uid(&draft_left), None).await.expect("drop the held sale");

    let moves_before = t.count("select count(*) from stock_move where tenant_id = $1 and $2::uuid is null", None).await;
    let closed = t.submit(&manager, "PosClosingEntry", uid(&closing)).await;
    let c1 = uid(&closed);
    let check_consolidation = |closing: Uuid| {
        let t = &t;
        async move {
            let made =
                t.count("select count(distinct consolidated_invoice) from e_pos_invoice where tenant_id = $1 and pos_closing_entry = $2", Some(closing)).await;
            assert_eq!(made, 4, "walk-in sales, Alice's sales, Bob's sale on account, the walk-in credit note");
            assert_eq!(t.gl("Sales").await, -net, "revenue equals the register's net sales");
            assert_eq!(t.gl("Output Tax").await, -taxes, "tax equals the register's taxes");
            assert_eq!(t.gl("Debtors").await, n("11"), "only Bob's sale on account stays receivable");
            assert_eq!(t.gl("Loyalty Redemptions").await, n("2"), "redeemed points");
            // Cash: takings net of change and refunds, float in, petty cash out, the shortage.
            assert_eq!(t.gl("Cash").await, n("774.45") - n("500") - n("2"));
            assert_eq!(t.gl("Primary Bank").await, n("100") + n("99") - n("50"), "card takings less the float taken from the bank");
            assert_eq!(t.gl("Round Off").await, -rounding + n("0.05") + n("2"), "cash rounding, the write-off and the shortage");
            assert_eq!(t.count("select count(*) from stock_move where tenant_id = $1 and $2::uuid is null", None).await, moves_before, "no stock moved twice");
            t.books_balance(cid).await;
        }
    };
    check_consolidation(c1).await;
    assert_eq!(t.get("PosOpeningEntry", s1).await["status"], json!("Closed"));
    let sale_a_now = t.get("PosInvoice", sale_id).await;
    assert_eq!(sale_a_now["status"], json!("Consolidated"));
    let si = t.get("SalesInvoice", sale_a_now["consolidated_invoice"].as_str().unwrap().parse().unwrap()).await;
    assert_eq!(si["status"], json!("Paid"));
    assert_eq!(
        dec(&si["rounded_total"]),
        dec(&sale_a["rounded_total"]) + dec(&ten["rounded_total"]) + dec(&by_manager["rounded_total"]) + dec(&small["rounded_total"])
    );
    let bob_si = t.get("SalesInvoice", t.get("PosInvoice", uid(&on_account)).await["consolidated_invoice"].as_str().unwrap().parse().unwrap()).await;
    assert_eq!((bob_si["status"].clone(), dec(&bob_si["outstanding_amount"])), (json!("Unpaid"), n("11")));

    let after =
        t.k.insert(&cashier, "PosInvoice", obj(json!({"pos_profile": counter1.to_string(), "pos_opening_entry": s1.to_string(), "items": [line(pen, "1")]})))
            .await;
    assert!(matches!(after, Err(Error::Validation(ref e)) if e.iter().any(|f| f.message.contains("closed"))), "{after:?}");
    let void_late = t.k.cancel(&manager, "PosInvoice", uid(&ten), None).await;
    assert!(matches!(void_late, Err(Error::Invalid(ref m)) if m.contains("consolidated")), "{void_late:?}");
    let z = t.report(&manager, "pos_sales_summary", &[("company", cid.to_string()), ("pos_opening_entry", s1.to_string())]).await;
    assert_eq!(z["meta"]["session"]["report"], json!("Z"));
    let rec = t.report(&manager, "pos_payment_reconciliation", &[("company", cid.to_string())]).await;
    assert_eq!(dec(&rec["totals"]["difference"]), n("-2"));

    // ───────────── undo the closing and close again ─────────────
    t.k.cancel(&manager, "PosClosingEntry", c1, None).await.expect("cancel the closing");
    assert_eq!(t.gl("Sales").await, Decimal::ZERO, "consolidation reversed");
    assert_eq!(t.gl("Debtors").await, Decimal::ZERO);
    assert_eq!(t.gl("Cash").await, n("30"), "only the cash movements stay booked: 50 in, 20 out");
    assert_eq!(t.get("PosOpeningEntry", s1).await["status"], json!("Open"));
    assert_eq!(t.get("PosInvoice", sale_id).await["status"], json!("Paid"));
    assert_eq!(t.get("PosInvoice", uid(&on_account)).await["status"], json!("Unpaid"));
    t.books_balance(cid).await;
    let again = t
        .insert(
            &manager,
            "PosClosingEntry",
            json!({"pos_opening_entry": s1.to_string(), "payments": [{"mode_of_payment": cash["id"], "closing_amount": "772.45"}]}),
        )
        .await;
    let c2 = uid(&t.submit(&manager, "PosClosingEntry", uid(&again)).await);
    check_consolidation(c2).await;

    // ───────────── next day's session: a return of an already consolidated sale ─────────────
    let s3 = t.insert(&cashier, "PosOpeningEntry", json!({"pos_profile": counter1.to_string()})).await;
    let s3 = uid(&t.submit(&cashier, "PosOpeningEntry", uid(&s3)).await);
    let late_return = t
        .sell(
            &cashier,
            json!({"pos_profile": counter1.to_string(), "is_return": true, "return_against": sale_id.to_string(),
                   "items": [{"item": pen.to_string(), "qty": "-1"}], "payments": [pay(&cash, "-11")]}),
        )
        .await;
    assert_eq!(dec(&late_return["rounded_total"]), n("-11.00"), "9.99 + 1.00 tax, rounded like the sale");
    // Loyalty through returns and voids: earn 4 at silver, a return takes 2 back, voiding the
    // return gives them back, voiding the sale takes its 4.
    let alice_points = || t.count("select coalesce(sum(points), 0)::bigint from e_loyalty_point_entry where tenant_id = $1 and customer = $2", Some(alice));
    let x = t
        .sell(&cashier, json!({"pos_profile": counter1.to_string(), "customer": alice.to_string(), "items": [line(pen, "2")], "payments": [pay(&cash, "22")]}))
        .await;
    assert_eq!((x["loyalty_points_earned"].clone(), alice_points().await), (json!(4), 12));
    let r1 = t
        .sell(
            &cashier,
            json!({"pos_profile": counter1.to_string(), "is_return": true, "return_against": x["id"], "items": [line(pen, "-1")], "payments": [pay(&cash, "-11")]}),
        )
        .await;
    assert_eq!(alice_points().await, 10, "half the sale came back, half its points go");
    let blocked_void = t.k.cancel(&manager, "PosInvoice", uid(&x), None).await;
    assert!(matches!(blocked_void, Err(Error::Invalid(ref m)) if m.contains("return")), "{blocked_void:?}");
    t.k.cancel(&manager, "PosInvoice", uid(&r1), None).await.expect("void the return");
    assert_eq!(alice_points().await, 12);
    t.k.cancel(&manager, "PosInvoice", uid(&x), None).await.expect("void the sale");
    assert_eq!(alice_points().await, 8);
    // A return of a sale paid partly with points refunds the points as points, the rest in cash.
    let points_back = json!({"pos_profile": counter1.to_string(), "is_return": true, "return_against": alice_2["id"], "items": [line(pen, "-1")]});
    let mut all_cash = points_back.clone();
    all_cash["payments"] = json!([pay(&cash, "-11")]);
    let cashed = t.refused(&cashier, all_cash).await;
    assert!(matches!(cashed, Error::Validation(ref e) if e.iter().any(|f| f.message.contains("at most 9"))), "points never come back as cash: {cashed:?}");
    let mut split = points_back;
    split["payments"] = json!([{"mode_of_payment": points["id"], "loyalty_points": 4}, pay(&cash, "-9")]);
    let r2 = t.sell(&cashier, split).await;
    assert_eq!(dec(&r2["payments"][0]["amount"]), n("-2"));
    assert_eq!(alice_points().await, 8 - 1 + 4, "the point earned on the sale goes, the 4 redeemed come back");
    let close3 = t.insert(&manager, "PosClosingEntry", json!({"pos_opening_entry": s3.to_string()})).await;
    t.submit(&manager, "PosClosingEntry", uid(&close3)).await;
    let cn = t.get("SalesInvoice", t.get("PosInvoice", uid(&late_return)).await["consolidated_invoice"].as_str().unwrap().parse().unwrap()).await;
    assert_eq!(cn["is_return"], json!(true));
    assert_eq!(cn["return_against"], t.get("PosInvoice", sale_id).await["consolidated_invoice"], "against the invoice that consolidated the sale");
    assert_eq!(dec(&cn["rounded_total"]), n("-11"));
    let blocked = t.k.cancel(&manager, "PosClosingEntry", c2, None).await;
    assert!(matches!(blocked, Err(Error::Invalid(ref m)) if m.contains("cancel it first")), "a later credit note depends on it: {blocked:?}");
    assert_eq!(t.gl("Loyalty Redemptions").await, Decimal::ZERO, "the refunded points undo the redemption");
    let bob_now: Uuid = t.get("PosInvoice", uid(&on_account)).await["consolidated_invoice"].as_str().unwrap().parse().unwrap();
    assert_ne!(bob_now, uid(&bob_si), "the redone closing made a new invoice");
    let alone = t.k.cancel(&t.admin, "SalesInvoice", bob_now, None).await;
    assert!(matches!(alone, Err(Error::Invalid(ref m)) if m.contains("POS closing")), "consolidated invoices go with their closing: {alone:?}");
    t.books_balance(cid).await;

    // ───────────── counter 2 closes with its negative-stock sale ─────────────
    let close2 = t.insert(&cashier, "PosClosingEntry", json!({"pos_opening_entry": s2.to_string()})).await;
    t.submit(&manager, "PosClosingEntry", uid(&close2)).await;
    assert_eq!(t.get("PosInvoice", uid(&gum_sale)).await["status"], json!("Consolidated"));
    t.books_balance(cid).await;

    // ───────────── reports ─────────────
    let p = [("company", cid.to_string())];
    let daily = t.report(&manager, "pos_daily_sales", &p).await;
    assert_eq!(dec(&daily["totals"]["net_amount"]), net - n("9.99") - n("9.99") + n("16"), "all sales less returns, gum included");
    let top = t.report(&manager, "pos_top_items", &p).await;
    assert_eq!(top["rows"][0]["item_code"], json!("WIDGET"));
    let hourly = t.report(&manager, "pos_hourly_sales", &p).await;
    assert!(hourly["rows"].as_array().unwrap().iter().any(|r| r["hour"] == json!("10:00")));
    let rets = t.report(&manager, "pos_returns", &p).await;
    assert_eq!(rets["totals"]["count"], json!(3), "the voided return does not count");
    let mine = t.report(&other, "pos_sales_summary", &p).await;
    assert_eq!(mine["rows"].as_array().unwrap().len(), 0, "a cashier sees only their own takings");

    // ───────────── loyalty expiry ─────────────
    let before = t.count("select coalesce(sum(points), 0)::bigint from e_loyalty_point_entry where tenant_id = $1 and customer = $2", Some(alice)).await;
    let mut tx = t.k.db.tenant_tx(tenant).await.unwrap();
    sqlx::query("update e_loyalty_point_entry set expiry_date = current_date - 1 where tenant_id = $1 and customer = $2 and remaining > 0")
        .bind(tenant)
        .bind(alice)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    ferrum_app_pos::maintenance(&t.k).await.expect("expiry");
    ferrum_app_pos::maintenance(&t.k).await.expect("expiry is idempotent");
    let after = t.count("select coalesce(sum(points), 0)::bigint from e_loyalty_point_entry where tenant_id = $1 and customer = $2", Some(alice)).await;
    assert_eq!((before, after), (11, 0), "every unused point expires");
    let program = t.find_one("LoyaltyProgram", json!({"program_name": "Rewards"})).await;
    let typed = json!({"loyalty_program": program["id"], "customer": alice.to_string(), "company": cid.to_string(), "entry_type": "Earn", "points": 1000,
                       "posting_date": chrono::Utc::now().date_naive().to_string()});
    let edit = t.k.insert(&t.admin, "LoyaltyPointEntry", obj(typed)).await;
    assert!(matches!(edit, Err(Error::Forbidden(_))), "points are never typed in, not even by an administrator: {edit:?}");
}
