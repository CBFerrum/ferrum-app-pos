//! What a till needs to price a basket while offline, as one signed, versioned snapshot (PS-16,
//! PS-17), and the server pricing an offline sale again with the snapshot its till used.
//!
//! The snapshot is the register's price book (every page of `/pricebook`), the promotions that
//! could apply over the next days in the form ERP's pure engine (`ferrum-erp-promotions`) takes, and
//! the buyer rules the till holds a sale to. Its `version` is a digest of that content; the server
//! keeps every version it gave out (`pos_snapshot`) so a sale made with one can be priced again with
//! exactly it, whatever changed since. [`replay`] prices a basket from a snapshot with the same
//! engines the server prices a draft with (`ferrum-calc`, then the promotions, then `ferrum-calc`
//! again) and the till's browser build runs: the totals agree or somebody looks at why.
//!
//! Not offline: promotions that need a code or a customer's first order (the till cannot know either);
//! they apply when the server prices the sale.

use crate::site::{book_page, param};
use ferrum_app_erp::promotion::candidates;
use ferrum_calc::{CalcInput, DocDiscount, LineIn, compute};
use ferrum_domain::util::{b, company, d, id, rows, s};
use ferrum_erp_promotions as engine;
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, SiteRequest};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

/// Pages of the price book in one snapshot (250 items each): the till's own limit.
const MAX_PAGES: usize = 200;
/// Days ahead whose promotions are in a snapshot: it is good for a lease's worth of selling.
const DAYS_AHEAD: i64 = 14;
/// How long a version is kept after it was last given out; a sale priced with an older one is
/// recorded as one whose snapshot is gone.
const KEEP_DAYS: i64 = 45;

fn list(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or_default().split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

fn set_of(rows: &[Doc]) -> engine::Set {
    engine::Set {
        items: rows.iter().filter_map(|r| id(r, "item")).map(|u| u.to_string()).collect(),
        item_groups: rows.iter().filter_map(|r| id(r, "item_group")).map(|u| u.to_string()).collect(),
    }
}

/// A promotion record as the engine takes it, in the company's currency (the register sells in it).
/// ERP keeps this mapping to itself; this is its twin, held to it by a test that prices one basket
/// through both and compares.
pub(crate) fn to_engine(p: &Doc) -> Option<engine::Promotion> {
    let (percent, amount) = (d(p, "percent"), d(p, "amount"));
    let int = |k: &str| p.get(k).and_then(Value::as_i64).unwrap_or(0);
    let gives = match s(p, "gives")? {
        "Percent Off the Document" => engine::Gives::PercentOffDocument { percent },
        "Amount Off the Document" => engine::Gives::AmountOffDocument { amount },
        "Percent Off Qualifying Lines" => engine::Gives::PercentOffLines { percent },
        "Amount Off Qualifying Lines" => engine::Gives::AmountOffLines { amount },
        "Buy and Get" => engine::Gives::BuyGet {
            buy: d(p, "buy_qty"),
            get: d(p, "get_qty"),
            get_set: set_of(&rows(p, "get_items")),
            at: match s(p, "get_at") {
                Some("Percent Off") => engine::GetAt::PercentOff { percent },
                Some("Price") => engine::GetAt::Price { price: amount },
                _ => engine::GetAt::Free,
            },
            cheapest_first: p.get("cheapest_first").and_then(Value::as_bool).unwrap_or(true),
        },
        "Bundle Price" => engine::Gives::Bundle {
            parts: rows(p, "bundle_items").iter().filter_map(|r| Some((id(r, "item")?.to_string(), d(r, "qty")))).collect(),
            price: amount,
        },
        "Free Delivery" => engine::Gives::FreeDelivery,
        "Free Item" => engine::Gives::FreeItem { item: id(p, "free_item")?.to_string(), qty: d(p, "free_qty").max(Decimal::ONE) },
        _ => return None,
    };
    let (parties, places) = (rows(p, "customers"), rows(p, "places"));
    Some(engine::Promotion {
        id: s(p, "id")?.to_string(),
        title: s(p, "title").unwrap_or_default().to_string(),
        priority: int("priority"),
        valid_from: s(p, "valid_from").map(str::to_string),
        valid_upto: s(p, "valid_upto").map(str::to_string),
        weekdays: list(s(p, "weekdays")).iter().filter_map(|w| w.parse().ok()).collect(),
        from_time: s(p, "from_time").map(str::to_string),
        to_time: s(p, "to_time").map(str::to_string),
        customers: parties.iter().filter_map(|r| id(r, "customer")).map(|u| u.to_string()).collect(),
        customer_groups: parties.iter().filter_map(|r| id(r, "customer_group")).map(|u| u.to_string()).collect(),
        channels: list(s(p, "channels")),
        places: places.iter().filter_map(|r| s(r, "warehouse").or(s(r, "place"))).map(str::to_string).collect(),
        requires_code: b(p, "requires_code"),
        first_order_only: b(p, "first_order_only"),
        min_amount: d(p, "min_amount"),
        min_qty: d(p, "min_qty"),
        qualifying: set_of(&rows(p, "qualifying_items")),
        gives,
        combinable: p.get("combinable").and_then(Value::as_bool).unwrap_or(true),
        with_line_discounts: p.get("with_line_discounts").and_then(Value::as_bool).unwrap_or(true),
        max_discount: p.get("max_discount").filter(|v| !v.is_null()).map(|_| d(p, "max_discount")),
    })
}

/// The snapshot's promotions: those that could apply on some day of the coming ones, each once, and
/// leaving out what the till cannot judge (a code, a first order).
async fn promotions(k: &Kernel, ctx: &Ctx, company_id: Uuid) -> Result<Vec<Value>> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let mut seen: BTreeMap<String, Doc> = BTreeMap::new();
    for day in 0..=DAYS_AHEAD {
        let on = (ctx.today() + chrono::Duration::days(day)).format("%Y-%m-%d").to_string();
        for p in candidates(k, ctx, &mut tx, company_id, &on).await? {
            if let Some(i) = s(&p, "id") {
                seen.entry(i.to_string()).or_insert(p);
            }
        }
    }
    tx.commit().await?;
    Ok(seen.values().filter_map(to_engine).filter(|p| !p.requires_code && !p.first_order_only).filter_map(|p| serde_json::to_value(p).ok()).collect())
}

/// `GET /snapshot?profile=`: everything above, signed with the server's key when it has one, and kept
/// under its version.
pub async fn snapshot(k: &Kernel, ctx: &Ctx, req: &SiteRequest) -> Result<Value> {
    let profile: Uuid = param(req, "profile").and_then(|v| v.parse().ok()).ok_or_else(|| Error::field("profile", "is required"))?;
    let register = k.get(ctx, "PosProfile", profile, false).await?;
    let company_id = id(&register, "company").ok_or_else(|| Error::field("company", "the register has no company"))?;
    let (mut after, mut first, mut pages) = (None, Value::Null, 0);
    let (mut items, mut barcodes, mut unpriced): (Vec<Value>, Vec<Value>, Vec<Value>) = Default::default();
    loop {
        let page = book_page(k, ctx, profile, after).await?;
        if pages == 0 {
            first = page.clone();
        }
        for (into, key) in [(&mut items, "items"), (&mut barcodes, "barcodes"), (&mut unpriced, "unpriced")] {
            into.extend(page.get(key).and_then(Value::as_array).cloned().unwrap_or_default());
        }
        pages += 1;
        after = page.get("next").and_then(Value::as_str).and_then(|n| n.parse().ok());
        if after.is_none() || pages >= MAX_PAGES {
            break;
        }
    }
    let truncated = after.is_some();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let co = company(k, ctx, &mut tx, company_id).await?;
    tx.commit().await?;
    let body = json!({
        "profile": profile,
        "currency": first.get("currency"),
        "customer": first.get("customer"),
        "customer_group": customer_group(k, ctx, first.get("customer")).await?,
        "warehouse": register.get("warehouse"),
        "time_zone": s(&co.doc, "time_zone"),
        "channel": CHANNEL,
        "engine": first.get("engine"),
        "items": items,
        "barcodes": barcodes,
        "unpriced": unpriced,
        "truncated": truncated,
        "promotions": promotions(k, ctx, company_id).await?,
        "buyer": {"named_above": register.get("named_buyer_above").filter(|v| !v.is_null()), "walk_in": register.get("customer")},
    });
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
    let mut out = body;
    if let Value::Object(m) = &mut out {
        m.insert("version".into(), json!(version));
        m.insert("signature".into(), json!(signature));
        m.insert("built_at".into(), json!(chrono::Utc::now().to_rfc3339()));
    }
    Ok(out)
}

/// What promotions call a sale at the till.
pub(crate) const CHANNEL: &str = "Point of Sale";

async fn customer_group(k: &Kernel, ctx: &Ctx, customer: Option<&Value>) -> Result<Option<String>> {
    let Some(c) = customer.and_then(Value::as_str).and_then(|c| c.parse::<Uuid>().ok()) else { return Ok(None) };
    Ok(k.get(ctx, "Customer", c, false).await.ok().and_then(|c| id(&c, "customer_group")).map(|g| g.to_string()))
}

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

/// What a basket is worth, to price it again.
pub(crate) struct Basket {
    /// `(item, quantity, a price the cashier typed, a discount the cashier typed)`.
    pub lines: Vec<(String, Decimal, Option<Decimal>, Option<Decimal>)>,
    pub customer: Option<String>,
    pub customer_group: Option<String>,
    pub date: String,
    pub time: String,
    pub discount_percent: Decimal,
}

/// The rounded total of `basket` priced with `snapshot`: each line from its item's price, discount
/// and tax rates, the promotions that apply at the basket's moment, then the taxes, the document's
/// discount and the cash rounding. Mirrors ERP's `calculate` for a draft sale of its own.
pub(crate) fn replay(snapshot: &Value, basket: &Basket) -> std::result::Result<Decimal, String> {
    let mut input: CalcInput = serde_json::from_value(snapshot.get("engine").cloned().map(with_lines).ok_or("the snapshot has no engine")?)
        .map_err(|e| format!("the snapshot's engine: {e}"))?;
    let items: BTreeMap<&str, &Value> =
        snapshot.get("items").and_then(Value::as_array).into_iter().flatten().filter_map(|i| Some((i.get("id")?.as_str()?, i))).collect();
    let dec = |v: Option<&Value>| v.and_then(Value::as_str).and_then(|x| x.parse::<Decimal>().ok()).unwrap_or_default();
    let mut groups: Vec<Option<String>> = Vec::new();
    let mut typed: Vec<bool> = Vec::new();
    for (i, (item, qty, rate, discount)) in basket.lines.iter().enumerate() {
        let own = items.get(item.as_str()).ok_or_else(|| format!("item {item} is not in the snapshot"))?;
        let line = own.get("line").ok_or("a snapshot item without its line")?;
        let tax_rates: BTreeMap<String, Decimal> = line
            .get("tax_rates")
            .and_then(Value::as_object)
            .map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.parse().ok()?))).collect())
            .unwrap_or_default();
        let discount_percent = discount.unwrap_or_else(|| dec(line.get("discount_percent")));
        typed.push(discount_percent > Decimal::ZERO);
        groups.push(own.get("item_group").and_then(Value::as_str).map(str::to_string));
        input.lines.push(LineIn {
            key: format!("l{i}"),
            qty: *qty,
            price: rate.unwrap_or_else(|| dec(line.get("price"))),
            discount_percent,
            tax_rates,
            tax_qty: line.get("tax_qty").filter(|v| !v.is_null()).map(|q| dec(Some(q)) * *qty),
        });
    }
    input.discount = (basket.discount_percent > Decimal::ZERO).then_some(DocDiscount::Percent { value: basket.discount_percent }).or(input.discount.take());
    let promos: Vec<engine::Promotion> =
        snapshot.get("promotions").and_then(Value::as_array).into_iter().flatten().filter_map(|p| serde_json::from_value(p.clone()).ok()).collect();
    if !promos.is_empty() {
        let when = engine::When {
            date: basket.date.clone(),
            weekday: chrono::NaiveDate::parse_from_str(&basket.date, "%Y-%m-%d").map(|d| chrono::Datelike::weekday(&d).number_from_monday() as u8).unwrap_or(1),
            time: basket.time.clone(),
            customer: basket.customer.clone(),
            customer_group: basket.customer_group.clone(),
            channel: Some(CHANNEL.to_string()),
            place: snapshot.get("warehouse").and_then(Value::as_str).map(str::to_string),
            first_order: false,
            codes: vec![],
        };
        // The lines before promotions, as ERP works them out: no taxes, no document discount.
        fn bare(input: &CalcInput) -> CalcInput {
            CalcInput { taxes: vec![], discount: None, round_total_to: None, ..input.clone() }
        }
        let mut added: Vec<(String, String)> = Vec::new();
        let mut out = engine::Outcome::default();
        for _ in 0..2 {
            let before = compute(&bare(&input)).map_err(|e| e.to_string())?;
            let lines: Vec<engine::Line> = input
                .lines
                .iter()
                .zip(&before.lines)
                .enumerate()
                .map(|(i, (l, o))| engine::Line {
                    key: l.key.clone(),
                    item: basket.lines.get(i).map(|x| x.0.clone()).or_else(|| added.get(i - basket.lines.len()).map(|a| a.1.clone())),
                    item_group: groups.get(i).cloned().flatten(),
                    qty: l.qty,
                    amount: o.amount,
                    line_discount: typed.get(i).copied().unwrap_or(false),
                    delivery: false,
                    added_by: added.get(i.wrapping_sub(basket.lines.len())).map(|a| a.0.clone()),
                })
                .collect();
            out =
                engine::apply(&engine::Input { lines, promotions: promos.clone(), when: when.clone(), precision: input.precision, rounding: input.rounding })?;
            // A free item its promotion adds is a line of its own, priced as the snapshot prices it.
            let mut grew = false;
            for add in &out.add {
                if added.iter().any(|a| a.0 == add.promotion && a.1 == add.item) {
                    continue;
                }
                let own = items.get(add.item.as_str()).ok_or_else(|| format!("free item {} is not in the snapshot", add.item))?;
                let line = own.get("line").ok_or("a snapshot item without its line")?;
                input.lines.push(LineIn { key: format!("f{}", added.len()), qty: add.qty, price: dec(line.get("price")), ..Default::default() });
                groups.push(own.get("item_group").and_then(Value::as_str).map(str::to_string));
                typed.push(false);
                added.push((add.promotion.clone(), add.item.clone()));
                grew = true;
            }
            if !grew {
                break;
            }
        }
        let shares: BTreeMap<&str, Decimal> = out.lines.iter().map(|l| (l.key.as_str(), l.percent)).collect();
        for l in input.lines.iter_mut() {
            if let Some(p) = shares.get(l.key.as_str()) {
                l.discount_percent = engine::combined_percent(l.discount_percent, *p);
            }
        }
    }
    Ok(compute(&input).map_err(|e| e.to_string())?.rounded_total)
}

/// The engine of a snapshot, which has no lines, as a calculation's input.
fn with_lines(mut engine: Value) -> Value {
    if let Value::Object(m) = &mut engine {
        m.entry("lines").or_insert_with(|| json!([]));
    }
    engine
}

/// A sale made offline, priced again with the snapshot its till used: the total, or why not.
pub(crate) async fn replay_sale(
    hc: &mut ferrum_kernel::HookCtx<'_>,
    doc: &Doc,
    profile: Uuid,
    typed: &[(Option<Decimal>, Option<Decimal>)],
    customer_group: Option<Uuid>,
) -> Result<Option<Decimal>> {
    let Some(version) = s(doc, "price_snapshot") else { return Ok(None) };
    let Some(body) = kept(hc.tx, hc.ctx.tenant, profile, version).await? else { return Ok(None) };
    let lines = rows(doc, "items")
        .iter()
        .enumerate()
        .filter(|(_, r)| s(r, "added_by_promotion").is_none())
        .map(|(i, r)| {
            let (discount, rate) = typed.get(i).copied().unwrap_or_default();
            (id(r, "item").map(|u| u.to_string()).unwrap_or_default(), d(r, "qty"), rate, discount)
        })
        .collect();
    let time = s(doc, "posting_time").unwrap_or_default().to_string();
    let basket = Basket {
        lines,
        customer: id(doc, "customer").map(|c| c.to_string()),
        customer_group: customer_group.map(|g| g.to_string()),
        date: s(doc, "posting_date").unwrap_or_default().to_string(),
        time,
        discount_percent: d(doc, "discount_percent"),
    };
    // A snapshot that cannot price the basket (an item it never had) is no total: the difference says so.
    Ok(replay(&body, &basket).ok())
}
