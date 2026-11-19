//! A template's variants in the register's snapshot, where ERP's Stock Operations add-on is installed (pos-8): each
//! catalog item says the template it is a variant of, and the snapshot names those templates once. Against a real
//! PostgreSQL (the same database as `pos_it`, reset first; cargo runs test binaries one after the other).

use ferrum_kernel::tenant::NewTenant;
use ferrum_kernel::{Ctx, Db, DbConfig, Doc, HookRegistry, Kernel, KernelSettings, ListQuery, SiteRequest};
use ferrum_meta::Catalog;
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

fn obj(v: Value) -> Doc {
    v.as_object().cloned().unwrap()
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
    async fn insert(&self, entity: &str, v: Value) -> Doc {
        self.k.insert(&self.admin, entity, obj(v)).await.unwrap_or_else(|e| panic!("insert {entity}: {e:?}"))
    }
    async fn find_one(&self, entity: &str, filters: Value) -> Doc {
        let q = ListQuery { filters: ferrum_kernel::query::parse_filters(&filters).unwrap(), ..Default::default() };
        let page = self.k.list(&self.admin, entity, &q).await.unwrap();
        assert_eq!(page.rows.len(), 1, "{entity} {filters}");
        page.rows[0].clone()
    }
    async fn snapshot(&self, profile: Uuid) -> Value {
        let req = SiteRequest {
            tenant: self.tenant,
            user: Some(self.admin.clone()),
            method: "GET".into(),
            path: "/snapshot".into(),
            query: json!({"profile": profile.to_string()}).as_object().cloned().unwrap(),
            headers: Default::default(),
            body: vec![],
            client_ip: "it".into(),
        };
        let res = ferrum_kernel::Site::handle(&ferrum_app_pos::site::PosSite, &self.k, req).await.expect("snapshot");
        serde_json::from_slice(&res.body).expect("a JSON snapshot")
    }
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
fn variants() {
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
    // The add-on: its packages and its hooks, as ERP's own tests load it.
    packages.extend(ferrum_stock_ops::packages().expect("Stock Operations' packages"));
    packages.extend(ferrum_app_pos::packages().expect("app packages"));
    let catalog = Catalog::from_packages(packages).expect("catalog");
    let mut hooks = HookRegistry::default();
    ferrum_domain::register(&mut hooks);
    let erp_packages: Vec<String> = ferrum_app_erp::packages().unwrap().iter().map(|p| p.name().to_string()).collect();
    hooks.app("erp", &[], ferrum_app_erp::register);
    hooks.own("erp", &erp_packages);
    ferrum_stock_ops::register(&mut hooks);
    let pos_packages: Vec<String> = ferrum_app_pos::packages().unwrap().iter().map(|p| p.name().to_string()).collect();
    hooks.app("pos", &pos_packages, ferrum_app_pos::register);
    hooks.own("pos", &pos_packages);
    let k = Kernel::boot(db, catalog, hooks, KernelSettings::default(), None).await.expect("boot");
    ferrum_domain::maintenance(&k).await.expect("partitions");
    let tenant = k
        .create_tenant(NewTenant {
            slug: "tees".into(),
            name: "Tee Shop".into(),
            admin_email: "admin@tees.test".into(),
            admin_password: "Correct-Horse-9".into(),
            admin_name: None,
            packages: vec!["pos".into(), "stock_ops".into()],
            settings: Some(json!({"fiscal_year_start_month": 4})),
        })
        .await
        .expect("tenant");
    let session = k.login("tees", "admin@tees.test", "Correct-Horse-9").await.expect("login");
    let admin = k.load_ctx(tenant, session.user, Some(session.token_version), "it".into()).await.expect("ctx");
    let t = T { k: k.clone(), tenant, admin };

    // ───────────── the shop: a tee in two sizes, and a mug ─────────────
    let inr = t.find_one("Currency", json!({"code": "INR"})).await;
    let company = t.insert("Company", json!({"company_name": "Tee Shop", "abbr": "TS", "default_currency": inr["id"]})).await;
    let cid = uid(&company);
    let stores = uid(&t.find_one("Warehouse", json!({"warehouse_name": "Stores", "company": cid.to_string()})).await);
    let products = t.find_one("ItemGroup", json!({"group_name": "Products"})).await;
    let nos = t.find_one("Uom", json!({"uom_name": "Nos"})).await;
    let selling = t.find_one("PriceList", json!({"price_list_name": "Standard Selling"})).await;
    let size = t
        .insert(
            "ItemAttribute",
            json!({"attribute_name": "Size", "values": [{"attribute_value": "Small", "abbr": "S"}, {"attribute_value": "Medium", "abbr": "M"}]}),
        )
        .await;
    let tee = uid(&t
        .insert(
            "Item",
            json!({"item_code": "TEE", "item_name": "Tee", "item_group": products["id"], "stock_uom": nos["id"], "stk_has_variants": true,
                   "stk_attributes": [{"attribute": uid(&size).to_string()}]}),
        )
        .await);
    let made = t.k.run_action(&t.admin, "Item", tee, "make_variants", json!({})).await.expect("the variants");
    let mut sizes: Vec<Uuid> = made["created"].as_array().unwrap().iter().map(|v| v["id"].as_str().unwrap().parse().unwrap()).collect();
    sizes.sort();
    assert_eq!(sizes.len(), 2, "{made:?}");
    let mug = uid(&t.insert("Item", json!({"item_code": "MUG", "item_name": "Mug", "item_group": products["id"], "stock_uom": nos["id"]})).await);
    for i in [sizes[0], sizes[1], mug] {
        t.insert("ItemPrice", json!({"item": i.to_string(), "price_list": selling["id"], "rate": "250", "valid_from": "2020-01-01"})).await;
    }
    let cash = t.find_one("ModeOfPayment", json!({"mode_name": "Cash"})).await;
    let walk_in = uid(&t.find_one("Customer", json!({"customer_name": "Walk-in Customer"})).await);
    let counter = uid(&t
        .insert(
            "PosProfile",
            json!({"profile_name": "Counter", "company": cid.to_string(), "warehouse": stores.to_string(), "price_list": selling["id"],
                   "customer": walk_in.to_string(), "invoice_prefix": "TS", "payments": [{"mode_of_payment": cash["id"], "is_default": true}]}),
        )
        .await);

    // snapshot_names_each_variants_template: the two sizes carry the tee's id, the mug none, and the tee is named once.
    let snap = t.snapshot(counter).await;
    let catalog = snap["catalog"].as_array().expect("a catalog");
    let of = |item: Uuid| catalog.iter().find(|i| i["id"] == json!(item.to_string())).map(|i| i.get("variant_of").cloned());
    assert_eq!(
        (of(sizes[0]), of(sizes[1]), of(mug)),
        (Some(Some(json!(tee.to_string()))), Some(Some(json!(tee.to_string()))), Some(Some(Value::Null))),
        "{catalog:?}"
    );
    assert_eq!(snap["templates"], json!([{"id": tee.to_string(), "name": "Tee"}]), "{snap:?}");
}
