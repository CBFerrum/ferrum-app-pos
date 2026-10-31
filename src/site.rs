//! The register's own endpoints (`/api/app/pos/...`, signed in): its price book, so a till that
//! loses the connection keeps pricing sales with the platform's own engine (`ferrum-calc`, the
//! same code built for the browser) instead of stopping.

use async_trait::async_trait;
use ferrum_domain::pricing::calc_input;
use ferrum_domain::util::{company, currency, d, id, rows, s};
use ferrum_kernel::{Ctx, Doc, Error, Filter, Kernel, ListQuery, Op, Result, Site, SiteRequest, SiteResponse};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

/// Items priced per request; the till asks for the next page with `after`.
const PAGE: u32 = 250;

pub struct PosSite;

#[async_trait]
impl Site for PosSite {
    async fn handle(&self, k: &Kernel, req: SiteRequest) -> Result<SiteResponse> {
        let Some(ctx) = &req.user else { return Err(Error::NotFound("page".into())) };
        let path: Vec<&str> = req.path.split('/').filter(|p| !p.is_empty()).collect();
        match (req.method.as_str(), path.as_slice()) {
            ("GET", ["pricebook"]) => Ok(SiteResponse::json(200, &price_book(k, ctx, &req).await?)),
            _ => Err(Error::NotFound("page".into())),
        }
    }
}

fn param<'a>(req: &'a SiteRequest, key: &str) -> Option<&'a str> {
    req.query.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
}

/// `GET /pricebook?profile=&after=`: a page of the register's items, each with what the engine
/// needs to price it (its price, line discount and item tax rates, as a sale of one has them for
/// the register's default customer), and what every sale shares (tax rows, rounding, precision),
/// with `next` while items remain; `unpriced` names the page's items the register cannot sell as
/// they stand (no price in its price list), which a till sells only online. A till prices a sale offline from these; the server prices the
/// sale again when it arrives, and one whose payments no longer cover it waits for a person (a
/// price changed meanwhile, a quantity or customer the price book could not foresee).
pub async fn price_book(k: &Kernel, ctx: &Ctx, req: &SiteRequest) -> Result<Value> {
    let profile_id: Uuid = param(req, "profile").and_then(|v| v.parse().ok()).ok_or_else(|| Error::field("profile", "is required"))?;
    let after: Option<Uuid> = match param(req, "after") {
        Some(a) => Some(a.parse().map_err(|_| Error::field("after", "is an item id"))?),
        None => None,
    };
    // Reading the register is the right to its prices.
    let profile = k.get(ctx, "PosProfile", profile_id, false).await?;
    let groups: Vec<String> = rows(&profile, "item_groups").iter().filter_map(|g| s(g, "item_group").map(str::to_string)).collect();
    let mut filters = vec![Filter { field: "disabled".into(), op: Op::Eq, value: json!(false) }];
    if !groups.is_empty() {
        filters.push(Filter { field: "item_group".into(), op: Op::In, value: json!(groups) });
    }
    if let Some(a) = after {
        filters.push(Filter { field: "id".into(), op: Op::Gt, value: json!(a) });
    }
    let fields = ["id", "item_code", "item_name", "barcode"].map(String::from).to_vec();
    let query = ListQuery { filters, fields: Some(fields), sort: Some("id asc".into()), limit: Some(PAGE + 1), ..Default::default() };
    let mut items = k.list(ctx, "Item", &query).await?.rows;
    let more = items.len() > PAGE as usize;
    items.truncate(PAGE as usize);
    let next = if more { items.last().and_then(|i| i.get("id")).cloned() } else { None };
    // Items the register's price list has no price for cannot be sold without typing one: not offline.
    let mut unpriced: Vec<Value> = Vec::new();
    if let Some(list) = id(&profile, "price_list") {
        let ids: Vec<Value> = items.iter().filter_map(|i| i.get("id").cloned()).collect();
        let prices = ListQuery {
            filters: vec![
                Filter { field: "price_list".into(), op: Op::Eq, value: json!(list) },
                Filter { field: "item".into(), op: Op::In, value: Value::Array(ids) },
            ],
            fields: Some(vec!["item".into()]),
            limit: Some(5000),
            ..Default::default()
        };
        let priced: HashSet<String> =
            k.list(ctx, "ItemPrice", &prices).await?.rows.iter().filter_map(|r| r.get("item").and_then(Value::as_str).map(String::from)).collect();
        items.retain(|i| {
            let has = i.get("id").and_then(Value::as_str).is_some_and(|id| priced.contains(id));
            if !has {
                unpriced.push(json!({"id": i.get("id"), "name": i.get("item_name"), "reason": "no price in the register's price list"}));
            }
            has
        });
    }

    // A sale of one of each, priced as the register prices it; nothing is saved. A line the
    // register refuses as it stands (a price not valid today) is left out and named, and the rest
    // priced again: each round drops at least one, so it ends.
    let priced = loop {
        if items.is_empty() {
            return Ok(json!({"profile": profile_id, "items": [], "barcodes": [], "unpriced": unpriced, "next": next}));
        }
        let sale: Doc = json!({"pos_profile": profile_id, "items": items.iter().map(|i| json!({"item": i.get("id"), "qty": "1"})).collect::<Vec<_>>()})
            .as_object()
            .cloned()
            .unwrap_or_default();
        match k.preview(ctx, "PosInvoice", sale).await {
            Ok(doc) => break doc,
            Err(Error::Validation(errors)) if !errors.is_empty() && errors.iter().all(|e| e.row.as_ref().is_some_and(|(t, _)| t == "items")) => {
                let bad: HashMap<usize, String> = errors.iter().filter_map(|e| e.row.as_ref().map(|(_, i)| (*i, e.message.clone()))).collect();
                let mut kept = Vec::with_capacity(items.len());
                for (i, item) in items.into_iter().enumerate() {
                    match bad.get(&i) {
                        Some(why) => unpriced.push(json!({"id": item.get("id"), "name": item.get("item_name"), "reason": why})),
                        None => kept.push(item),
                    }
                }
                items = kept;
            }
            Err(e) => return Err(e),
        }
    };
    let company_id = id(&priced, "company").ok_or_else(|| Error::field("company", "the register has no company"))?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let co = company(k, ctx, &mut tx, company_id).await?;
    let (code, precision) = currency(k, ctx, &mut tx, id(&priced, "currency").unwrap_or(co.currency_id)).await?;
    tx.commit().await?;
    let rate = Some(d(&priced, "conversion_rate")).filter(|r| *r > Decimal::ZERO).unwrap_or(Decimal::ONE);
    let lines = rows(&priced, "items");
    let input = calc_input(&lines, &rows(&priced, "taxes"), d(&priced, "discount_percent"), &co, precision, rate, true);
    let mut engine = serde_json::to_value(&input).map_err(|e| Error::internal(e.to_string()))?;
    if let Value::Object(m) = &mut engine {
        m.remove("lines");
    }
    // Each item with its line, matched by item (the engine keeps the lines' order).
    let priced_items: Vec<Value> = lines
        .iter()
        .zip(&input.lines)
        .filter_map(|(row, line)| {
            let item = id(row, "item")?;
            let own = items.iter().find(|i| i.get("id").and_then(Value::as_str) == Some(&item.to_string()))?;
            Some(json!({
                "id": item, "code": own.get("item_code"), "name": own.get("item_name"), "barcode": own.get("barcode"),
                "line": {"price": line.price, "discount_percent": line.discount_percent, "tax_rates": line.tax_rates},
            }))
        })
        .collect();
    // Pack barcodes of these items (a case of six scans as six).
    let ids: Vec<Value> = items.iter().filter_map(|i| i.get("id").cloned()).collect();
    let packs = ListQuery {
        filters: vec![Filter { field: "item".into(), op: Op::In, value: Value::Array(ids) }],
        fields: Some(["barcode", "item", "qty"].map(String::from).to_vec()),
        limit: Some(1000),
        ..Default::default()
    };
    // Pack barcodes are an extra: a person who may not read them still gets prices.
    let barcodes = k.list(ctx, "ItemBarcode", &packs).await.map(|p| p.rows).unwrap_or_default();
    Ok(json!({
        "profile": profile_id,
        "currency": code,
        "customer": priced.get("customer"),
        "engine": engine,
        "items": priced_items,
        "barcodes": barcodes,
        "unpriced": unpriced,
        "next": next,
        "built_at": chrono::Utc::now().to_rfc3339(),
    }))
}
