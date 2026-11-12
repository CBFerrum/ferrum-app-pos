//! What a till needs to price a basket while offline, as one signed, versioned snapshot (PS-16,
//! PS-17), and the server pricing an offline sale again with the snapshot its till used.
//!
//! The snapshot is ERP's pricing snapshot (`ferrum_erp_pricing::Snapshot`, schema in ERP's
//! `docs/pricing.md`: prices, units, pricing rules, taxes, rounding and the promotions that could
//! apply over the next days) built from the register's own price book, plus what the till shows and
//! holds a sale to: each item's code, name and barcode (`catalog`), pack barcodes, the items it cannot
//! sell offline, and the buyer rule. Its `version` is a digest of that content; the server keeps every
//! version it gave out (`pos_snapshot`) so a sale made with one is priced again with exactly it,
//! whatever changed since. The till prices with `ferrum_erp_pricing::price_basket` built for the
//! browser (`priceBasket`), the server with the same crate: the totals agree or somebody looks at why.
//!
//! Not offline: promotions that need a code or a customer's first order (the till cannot know either).

use crate::site::{book_sale, param};
use ferrum_domain::util::{d, id, rows, s};
use ferrum_erp_pricing::{Basket, BasketLine, Priced, Snapshot, price_basket};
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, SiteRequest};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Pages of the price book in one snapshot (250 items each): the till's own limit.
const MAX_PAGES: usize = 200;
/// Days ahead a snapshot prices for: a lease's worth of selling.
const DAYS_AHEAD: i64 = 14;
/// How long a version is kept after it was last given out; a sale priced with an older one is
/// recorded as one whose snapshot is gone.
const KEEP_DAYS: i64 = 45;

/// `GET /snapshot?profile=`: everything above, signed with the server's key when it has one, and kept
/// under its version.
pub async fn snapshot(k: &Kernel, ctx: &Ctx, req: &SiteRequest) -> Result<Value> {
    let profile: Uuid = param(req, "profile").and_then(|v| v.parse().ok()).ok_or_else(|| Error::field("profile", "is required"))?;
    let register = k.get(ctx, "PosProfile", profile, false).await?;
    let company_id = id(&register, "company").ok_or_else(|| Error::field("company", "the register has no company"))?;
    let (mut after, mut pages, mut sale) = (None, 0, None::<Doc>);
    let (mut catalog, mut barcodes, mut unpriced, mut lines): (Vec<Value>, Vec<Value>, Vec<Value>, Vec<Doc>) = Default::default();
    loop {
        let (page, priced) = book_sale(k, ctx, profile, after).await?;
        for i in page.get("items").and_then(Value::as_array).into_iter().flatten() {
            catalog
                .push(json!({"id": i.get("id"), "code": i.get("code"), "name": i.get("name"), "barcode": i.get("barcode"), "item_group": i.get("item_group")}));
        }
        for (into, key) in [(&mut barcodes, "barcodes"), (&mut unpriced, "unpriced")] {
            into.extend(page.get(key).and_then(Value::as_array).cloned().unwrap_or_default());
        }
        if let Some(p) = priced {
            lines.extend(rows(&p, "items"));
            sale.get_or_insert(p);
        }
        pages += 1;
        after = page.get("next").and_then(Value::as_str).and_then(|n| n.parse().ok());
        if after.is_none() || pages >= MAX_PAGES {
            break;
        }
    }
    let truncated = after.is_some();
    // No item sells: the register's own sale, with nothing on it, says the rest.
    let sale = match sale {
        Some(s) => s,
        None => json!({"company": company_id, "customer": register.get("customer"), "price_list": register.get("price_list"),
                       "set_warehouse": register.get("warehouse"), "channel": CHANNEL})
        .as_object()
        .cloned()
        .unwrap_or_default(),
    };
    let from = ctx.today();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let pricing = ferrum_app_erp::pricing::snapshot(k, ctx, &mut tx, &sale, &lines, from, from + chrono::Duration::days(DAYS_AHEAD)).await?;
    tx.commit().await?;
    let mut body = serde_json::to_value(&pricing).map_err(|e| Error::internal(e.to_string()))?;
    if let Value::Object(m) = &mut body {
        for (key, v) in [
            ("profile", json!(profile)),
            ("catalog", json!(catalog)),
            ("barcodes", json!(barcodes)),
            ("unpriced", json!(unpriced)),
            ("truncated", json!(truncated)),
            ("buyer", json!({"named_above": register.get("named_buyer_above").filter(|v| !v.is_null()), "walk_in": register.get("customer")})),
        ] {
            m.insert(key.into(), v);
        }
    }
    let version = hex::encode(Sha256::digest(ferrum_kernel::value::canonical_json(&body)));
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    sqlx::query(
        "insert into pos_snapshot (tenant_id, pos_profile, version, body) values ($1, $2, $3, $4) \
         on conflict (tenant_id, pos_profile, version) do update set given_at = now()",
    )
    .bind(ctx.tenant)
    .bind(profile)
    .bind(&version)
    .bind(&body)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let signature = k.settings.secret_key.as_ref().map(|key| key.fingerprint("pos snapshot", &format!("{}:{profile}:{version}", ctx.tenant)));
    if let Value::Object(m) = &mut body {
        m.insert("version".into(), json!(version));
        m.insert("signature".into(), json!(signature));
        m.insert("built_at".into(), json!(chrono::Utc::now().to_rfc3339()));
    }
    Ok(body)
}

/// What promotions call a sale at the till.
pub(crate) const CHANNEL: &str = "Point of Sale";

/// The snapshot `version` of a register as it was kept, if it still is.
pub(crate) async fn kept(tx: &mut ferrum_kernel::Tx, tenant: Uuid, profile: Uuid, version: &str) -> Result<Option<Value>> {
    Ok(sqlx::query_scalar("select body from pos_snapshot where tenant_id = $1 and pos_profile = $2 and version = $3")
        .bind(tenant)
        .bind(profile)
        .bind(version)
        .fetch_optional(&mut **tx)
        .await?)
}

/// Forgets versions nobody was given for a long while (the upkeep).
pub(crate) async fn forget(k: &Kernel) -> Result<()> {
    let mut tx = k.db.system_tx().await?;
    // The table is made when the server starts; an upkeep running first has nothing to forget.
    if sqlx::query_scalar::<_, bool>("select to_regclass('pos_snapshot') is not null").fetch_one(&mut *tx).await? {
        sqlx::query("delete from pos_snapshot where given_at < now() - make_interval(days => $1::int)").bind(KEEP_DAYS as i32).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// A sale made offline, priced again with the snapshot its till used, as the till priced it: its lines (a free item
/// a promotion added left out: the pricing adds its own), what the cashier typed (`typed`: discount and price of each
/// of those lines), its customer and moment. None when the snapshot is gone, cannot be read (one kept before 0.7.2) or
/// cannot price the basket (an item it never had): the difference says so.
pub(crate) async fn reprice(
    hc: &mut ferrum_kernel::HookCtx<'_>,
    doc: &Doc,
    profile: Uuid,
    typed: &[(Option<Decimal>, Option<Decimal>)],
    customer_group: Option<Uuid>,
) -> Result<Option<Priced>> {
    let Some(version) = s(doc, "price_snapshot") else { return Ok(None) };
    let Some(body) = kept(hc.tx, hc.ctx.tenant, profile, version).await? else { return Ok(None) };
    let Ok(snap) = serde_json::from_value::<Snapshot>(body) else { return Ok(None) };
    let lines = rows(doc, "items")
        .iter()
        .filter(|r| s(r, "added_by_promotion").is_none())
        .enumerate()
        .map(|(i, r)| {
            let (discount, price) = typed.get(i).copied().unwrap_or_default();
            BasketLine {
                item: id(r, "item").map(|u| u.to_string()).unwrap_or_default(),
                qty: d(r, "qty"),
                uom: id(r, "uom").map(|u| u.to_string()),
                price,
                discount_percent: discount,
            }
        })
        .collect();
    let time = s(doc, "posting_time").unwrap_or_default();
    let basket = Basket {
        lines,
        at: format!("{} {}", s(doc, "posting_date").unwrap_or_default(), time.get(..5).unwrap_or(time)),
        customer: id(doc, "customer").map(|c| c.to_string()),
        customer_group: customer_group.map(|g| g.to_string()),
        discount_percent: d(doc, "discount_percent"),
    };
    Ok(price_basket(&snap, &basket).ok())
}
