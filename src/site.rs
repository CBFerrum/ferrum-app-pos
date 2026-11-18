//! The register's own endpoints (`/api/app/pos/...`, signed in), all reads: the snapshot a till prices with
//! while offline (`snapshot`, which keeps the version it gave out), stored value balances, the cashier's limits,
//! the returns desk's lookups (`returns`) and the page of a receipt event (`paper`). What a till changes is an
//! operation: `set_pin` of a register; `approve`, `print_receipt`, `reprint` and `send_receipt` of the cashier's
//! session (limits.rs, receipt.rs); `exchange` of a return's draft (invoice.rs).

use crate::returns;
use async_trait::async_trait;
use ferrum_domain::util::{id, rows, s};
use ferrum_kernel::{Ctx, Doc, Error, Filter, Kernel, ListQuery, Op, Result, Site, SiteRequest, SiteResponse};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};
use uuid::Uuid;

/// Items of the price book priced at a time; the snapshot pages through them with `after`.
const PAGE: u32 = 250;

pub struct PosSite;

#[async_trait]
impl Site for PosSite {
    async fn handle(&self, k: &Kernel, req: SiteRequest) -> Result<SiteResponse> {
        let Some(ctx) = &req.user else { return Err(Error::NotFound("page".into())) };
        let path: Vec<&str> = req.path.split('/').filter(|p| !p.is_empty()).collect();
        match (req.method.as_str(), path.as_slice()) {
            ("GET", ["snapshot"]) => Ok(SiteResponse::json(200, &crate::snapshot::snapshot(k, ctx, &req).await?)),
            ("POST", ["balance"]) => Ok(SiteResponse::json(200, &card_balance(k, ctx, &req).await?)),
            ("GET", ["paper", event]) => {
                let event: Uuid = event.parse().map_err(|_| Error::NotFound("page".into()))?;
                crate::receipt::paper(k, ctx, &req, event).await
            }
            ("GET", ["limits"]) => Ok(SiteResponse::json(200, &limits(k, ctx, &req).await?)),
            ("GET", ["returns"]) => Ok(SiteResponse::json(200, &returns::search(k, ctx, &req).await?)),
            ("POST", ["returns", sale, "plan"]) => {
                let sale: Uuid = sale.parse().map_err(|_| Error::NotFound("page".into()))?;
                Ok(SiteResponse::json(200, &returns::plan(k, ctx, &req, sale).await?))
            }
            ("GET", ["returns", sale]) => {
                let sale: Uuid = sale.parse().map_err(|_| Error::NotFound("page".into()))?;
                Ok(SiteResponse::json(200, &returns::sheet(k, ctx, &req, sale).await?))
            }
            _ => Err(Error::NotFound("page".into())),
        }
    }
}

pub(crate) fn param<'a>(req: &'a SiteRequest, key: &str) -> Option<&'a str> {
    req.query.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
}

/// One page of the register's price book for its snapshot (`after`: the last item of the page before): its items as the
/// till shows them (with the template each is a variant of, where ERP's Stock Operations add-on is installed), their pack
/// barcodes, the items it cannot sell offline and why (`unpriced`), the templates its variants name (`templates`), `next`
/// while items remain; and the sale of one of each of its items the register priced (none when no item of the page sells).
pub(crate) async fn book_sale(k: &Kernel, ctx: &Ctx, profile_id: Uuid, after: Option<Uuid>) -> Result<(Value, Option<Doc>)> {
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
    let mut fields = ["id", "item_code", "item_name", "barcode", "item_group"].map(String::from).to_vec();
    // ERP's Stock Operations add-on marks a variant on `Item` (`stk_variant_of`, its template): where the workspace has
    // it, each item says its template, for the till's one tile per template. Read as the caller, like the rest.
    let variants = ctx.schema.entity("Item").is_some_and(|e| e.field("stk_variant_of").is_some());
    if variants {
        fields.push("stk_variant_of".into());
    }
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
            return Ok((json!({"items": [], "barcodes": [], "unpriced": unpriced, "templates": [], "next": next}), None));
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
    // Each item the sale priced (a free item a promotion added is not one of the page's), as the till shows it.
    let shown: Vec<Value> = rows(&priced, "items")
        .iter()
        .filter(|r| s(r, "added_by_promotion").is_none())
        .filter_map(|r| {
            let item = id(r, "item")?;
            let own = items.iter().find(|i| i.get("id").and_then(Value::as_str) == Some(&item.to_string()))?;
            Some(json!({"id": item, "code": own.get("item_code"), "name": own.get("item_name"), "barcode": own.get("barcode"), "item_group": own.get("item_group"),
                        "variant_of": own.get("stk_variant_of")}))
        })
        .collect();
    // The templates those variants name, read once as the caller and in one order (the version is a digest): one they may
    // not read is left out, and its variants show under their own names.
    let named: BTreeSet<&str> = shown.iter().filter_map(|i| i.get("variant_of").and_then(Value::as_str)).collect();
    let templates: Vec<Value> = if named.is_empty() {
        Vec::new()
    } else {
        let q = ListQuery {
            filters: vec![Filter { field: "id".into(), op: Op::In, value: json!(named) }],
            fields: Some(["id", "item_name", "item_code"].map(String::from).to_vec()),
            sort: Some("id asc".into()),
            limit: Some(PAGE),
            ..Default::default()
        };
        k.list(ctx, "Item", &q)
            .await?
            .rows
            .iter()
            .map(|t| json!({"id": t.get("id"), "name": s(t, "item_name").filter(|n| !n.trim().is_empty()).or_else(|| s(t, "item_code"))}))
            .collect()
    };
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
    Ok((json!({"items": shown, "barcodes": barcodes, "unpriced": unpriced, "templates": templates, "next": next}), Some(priced)))
}

/// `GET /limits?profile=`: what the signed-in person may do at the register on their own, for the
/// till to check before it asks (and, offline, to hold the sale to the same limits the server will).
pub async fn limits(k: &Kernel, ctx: &Ctx, req: &SiteRequest) -> Result<Value> {
    let pid: Uuid = param(req, "profile").and_then(|v| v.parse().ok()).ok_or_else(|| Error::field("profile", "is required"))?;
    k.get(ctx, "PosProfile", pid, false).await?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let profile = crate::Profile::load(k, ctx, &mut tx, pid).await?;
    let limits = crate::limits::of(ctx, &mut tx, &profile).await?;
    tx.commit().await?;
    serde_json::to_value(limits).map_err(|e| Error::internal(e.to_string()))
}

/// A text field of a JSON body.
fn body_str(req: &SiteRequest, key: &str) -> Result<Option<String>> {
    let v: Value = serde_json::from_slice(&req.body).map_err(|_| Error::invalid("send a JSON object"))?;
    Ok(v.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string))
}

/// `POST /balance` `{mode, code, pin?}`: what a card of a stored value payment method holds, its
/// state and expiry, for the cashier before taking it (ERP's guessing limits apply; online only).
async fn card_balance(k: &Kernel, ctx: &Ctx, req: &SiteRequest) -> Result<Value> {
    let mode: Uuid = body_str(req, "mode")?.and_then(|m| m.parse().ok()).ok_or_else(|| Error::field("mode", "is a payment method's id"))?;
    let code = body_str(req, "code")?.ok_or_else(|| Error::field("code", "is required"))?;
    let m = k.get(ctx, "ModeOfPayment", mode, false).await?;
    let kind = id(&m, "stored_value_kind").ok_or_else(|| Error::field("mode", "is not a stored value payment method"))?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let out = ferrum_app_erp::stored_value::balance(k, ctx, &mut tx, kind, &code, body_str(req, "pin")?.as_deref()).await?;
    tx.commit().await?;
    Ok(out)
}
