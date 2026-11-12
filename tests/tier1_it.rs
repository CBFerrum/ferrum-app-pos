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
}
