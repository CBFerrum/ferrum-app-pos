//! POS reports: session takings (X/Z report data), daily sales by item, payment reconciliation,
//! top items, hourly sales, returns, and the item lookup a register calls on every scan.
//!
//! A cashier whose role reads only their own POS invoices sees only their own figures.

use crate::closing::reconcile;
use crate::logic::{self, Kind, Tender};
use async_trait::async_trait;
use chrono::NaiveDate;
use ferrum_domain::reports::{Params, ReportCompany, ReportSource, col, param_def, period, read_tx, resolve_company};
use ferrum_domain::util::{get, money, rows, s};
use ferrum_kernel::{Access, Action, Ctx, Error, Kernel, Result, Tx};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;

pub struct PosReports;

struct Def {
    name: &'static str,
    label: &'static str,
    entity: &'static str,
    params: &'static [&'static str],
}

const RANGE: &[&str] = &["company", "from_date", "to_date", "pos_profile", "cashier"];

const DEFS: &[Def] = &[
    Def {
        name: "pos_sales_summary",
        label: "POS Takings by Session, Cashier and Payment Method",
        entity: "PosInvoice",
        params: &["company", "from_date", "to_date", "pos_profile", "cashier", "pos_opening_entry"],
    },
    Def {
        name: "pos_daily_sales",
        label: "POS Daily Sales by Item",
        entity: "PosInvoice",
        params: &["company", "from_date", "to_date", "pos_profile", "cashier", "group_by"],
    },
    Def {
        name: "pos_payment_reconciliation",
        label: "POS Payment Reconciliation",
        entity: "PosClosingEntry",
        params: &["company", "from_date", "to_date", "pos_profile"],
    },
    Def {
        name: "pos_top_items",
        label: "POS Top Selling Items",
        entity: "PosInvoice",
        params: &["company", "from_date", "to_date", "pos_profile", "cashier", "limit"],
    },
    Def { name: "pos_hourly_sales", label: "POS Hourly Sales", entity: "PosInvoice", params: RANGE },
    Def { name: "pos_returns", label: "POS Returns", entity: "PosInvoice", params: RANGE },
    Def { name: "pos_item_lookup", label: "POS Item Lookup", entity: "PosProfile", params: &["pos_profile", "code", "search", "item_group"] },
];

fn param(name: &str) -> Value {
    match name {
        "pos_profile" => json!({"name": name, "label": "POS Profile", "type": "link", "to": "PosProfile"}),
        "pos_opening_entry" => json!({"name": name, "label": "Session", "type": "link", "to": "PosOpeningEntry"}),
        "item_group" => json!({"name": name, "label": "Item Group", "type": "link", "to": "ItemGroup"}),
        "cashier" => json!({"name": name, "label": "Cashier (email)", "type": "data"}),
        "code" => json!({"name": name, "label": "Barcode or Item Code", "type": "data"}),
        "search" => json!({"name": name, "label": "Search", "type": "data"}),
        "group_by" => json!({"name": name, "label": "Group By", "type": "select", "options": ["Item", "Item Group"], "default": "Item"}),
        "limit" => json!({"name": name, "label": "Top", "type": "select", "options": ["10", "20", "50", "100"], "default": "20"}),
        other => param_def(other),
    }
}

/// Filters shared by the date-range reports.
struct Range {
    company: Uuid,
    from: NaiveDate,
    to: NaiveDate,
    profile: Option<Uuid>,
    cashier: Option<String>,
}

#[async_trait]
impl ReportSource for PosReports {
    fn catalog(&self) -> Vec<Value> {
        DEFS.iter()
            .map(|d| json!({"name": d.name, "label": d.label, "module": "pos", "entity": d.entity, "params": d.params.iter().map(|p| param(p)).collect::<Vec<_>>()}))
            .collect()
    }

    async fn run(&self, k: &Kernel, ctx: &Ctx, name: &str, raw: &HashMap<String, String>) -> Result<Value> {
        let p = Params { raw };
        let mut tx = read_tx(k, ctx).await?;
        if name == "pos_item_lookup" {
            let out = item_lookup(&mut tx, ctx, &p).await?;
            tx.rollback().await?;
            return Ok(out);
        }
        let co = resolve_company(&mut tx, ctx, &p).await?;
        let own = ctx.perms.access("PosInvoice", Action::Read) == Access::Own;
        let cashier = if own { Some(ctx.email.to_lowercase()) } else { p.str("cashier").map(str::to_lowercase) };
        let (from, to) = period(&p, &co)?;
        let range = Range { company: co.id, from, to, profile: p.uuid("pos_profile")?, cashier };
        let mut out = match name {
            "pos_sales_summary" => sales_summary(k, ctx, &mut tx, &range, p.uuid("pos_opening_entry")?).await?,
            "pos_daily_sales" => daily_sales(&mut tx, ctx, &co, &range, p.str("group_by") == Some("Item Group")).await?,
            "pos_payment_reconciliation" => reconciliation(&mut tx, ctx, &range).await?,
            "pos_top_items" => top_items(&mut tx, ctx, &range, p.str("limit").and_then(|l| l.parse().ok()).unwrap_or(20)).await?,
            "pos_hourly_sales" => hourly(&mut tx, ctx, &range).await?,
            "pos_returns" => returns(&mut tx, ctx, &range).await?,
            _ => return Err(Error::NotFound(format!("report {name}"))),
        };
        tx.rollback().await?;
        if let Value::Object(m) = &mut out {
            let meta = m.entry("meta").or_insert_with(|| json!({}));
            meta["company"] = json!(co.name);
            meta["currency"] = json!(co.currency);
            meta["from_date"] = json!(from);
            meta["to_date"] = json!(to);
        }
        Ok(out)
    }
}

#[derive(sqlx::FromRow)]
struct Sale {
    id: Uuid,
    session: Option<String>,
    cashier: Option<String>,
    is_return: bool,
    change_amount: Option<Decimal>,
    net_total: Option<Decimal>,
    total_taxes: Option<Decimal>,
    rounded_total: Option<Decimal>,
}

/// Takings per session, cashier and payment method (net of change and refunds). For one session
/// it is the X report while the session is open and the Z report once it is closed: `meta.session`
/// then carries the expected and counted amounts per payment method.
async fn sales_summary(k: &Kernel, ctx: &Ctx, tx: &mut Tx, r: &Range, session: Option<Uuid>) -> Result<Value> {
    let sales: Vec<Sale> = sqlx::query_as(
        "select p.id, o.number as session, p.cashier, p.is_return, p.change_amount, p.net_total, p.total_taxes, p.rounded_total \
         from e_pos_invoice p left join e_pos_opening_entry o on o.tenant_id = p.tenant_id and o.id = p.pos_opening_entry \
         where p.tenant_id = $1 and p.company = $2 and p.docstatus = 1 and ($3::uuid is not null or p.posting_date between $4 and $5) \
         and ($3::uuid is null or p.pos_opening_entry = $3) and ($6::uuid is null or p.pos_profile = $6) and ($7::text is null or lower(p.cashier) = $7) \
         order by o.number, p.cashier",
    )
    .bind(ctx.tenant)
    .bind(r.company)
    .bind(session)
    .bind(r.from)
    .bind(r.to)
    .bind(r.profile)
    .bind(&r.cashier)
    .fetch_all(&mut **tx)
    .await?;
    let ids: Vec<Uuid> = sales.iter().map(|s| s.id).collect();
    let pays: Vec<(Uuid, Option<String>, Option<String>, Option<Decimal>)> = sqlx::query_as(
        "select pm.parent_id, m.mode_name, pm.mode_type, pm.amount from e_pos_invoice__payments pm \
         left join e_mode_of_payment m on m.tenant_id = pm.tenant_id and m.id = pm.mode_of_payment \
         where pm.tenant_id = $1 and pm.parent_id = any($2) order by pm.parent_id, pm.idx",
    )
    .bind(ctx.tenant)
    .bind(&ids)
    .fetch_all(&mut **tx)
    .await?;
    let mut by_sale: HashMap<Uuid, Vec<&(Uuid, Option<String>, Option<String>, Option<Decimal>)>> = HashMap::new();
    for p in &pays {
        by_sale.entry(p.0).or_default().push(p);
    }
    let mut by: BTreeMap<(String, String, String), (i64, Decimal)> = BTreeMap::new();
    for sale in &sales {
        let mine = by_sale.remove(&sale.id).unwrap_or_default();
        let mut tenders: Vec<Tender> =
            mine.iter().map(|p| Tender { kind: p.2.as_deref().and_then(Kind::parse).unwrap_or(Kind::General), amount: p.3.unwrap_or_default() }).collect();
        logic::net_of_change(sale.change_amount.unwrap_or_default(), &mut tenders);
        for (p, t) in mine.iter().zip(tenders) {
            let key = (sale.session.clone().unwrap_or_default(), sale.cashier.clone().unwrap_or_default(), p.1.clone().unwrap_or_default());
            let e = by.entry(key).or_default();
            e.0 += 1;
            e.1 += t.amount;
        }
    }
    let total: Decimal = by.values().map(|v| v.1).sum();
    let rows_out: Vec<Value> = by
        .into_iter()
        .map(|((session, cashier, mode), (n, amount))| json!({"session": session, "cashier": cashier, "mode_of_payment": mode, "payments": n, "amount": money(amount)}))
        .collect();
    let sum = |f: fn(&Sale) -> Option<Decimal>| -> Decimal { sales.iter().map(|s| f(s).unwrap_or_default()).sum() };
    let mut meta = json!({
        "sales": sales.iter().filter(|s| !s.is_return).count(), "returns": sales.iter().filter(|s| s.is_return).count(),
        "net_total": money(sum(|s| s.net_total)), "total_taxes": money(sum(|s| s.total_taxes)), "grand_total": money(sum(|s| s.rounded_total)),
    });
    if let Some(sid) = session {
        let doc = get(k, ctx, tx, "PosOpeningEntry", sid).await?;
        let counted = match ferrum_domain::util::id(&doc, "pos_closing_entry") {
            Some(c) => rows(&get(k, ctx, tx, "PosClosingEntry", c).await?, "payments"),
            None => vec![],
        };
        let lines = reconcile(k, ctx, tx, &doc, &counted, &[]).await?;
        let names: HashMap<String, String> = sqlx::query_as::<_, (Uuid, String)>("select id, mode_name from e_mode_of_payment where tenant_id = $1")
            .bind(ctx.tenant)
            .fetch_all(&mut **tx)
            .await?
            .into_iter()
            .map(|(i, n)| (i.to_string(), n))
            .collect();
        let recon: Vec<Value> = lines
            .iter()
            .map(|l| {
                json!({"mode_of_payment": names.get(s(l, "mode_of_payment").unwrap_or_default()), "opening": l.get("opening_amount"),
                       "expected": l.get("expected_amount"), "counted": l.get("closing_amount"), "difference": l.get("difference")})
            })
            .collect();
        meta["session"] = json!({"number": doc.get("number"), "cashier": doc.get("user"), "status": doc.get("status"), "opened_at": doc.get("period_start"),
            "closed_at": doc.get("period_end"), "report": if s(&doc, "status") == Some("Closed") { "Z" } else { "X" }, "reconciliation": recon});
    }
    Ok(json!({
        "columns": [col("session", "Session", "data"), col("cashier", "Cashier", "data"), col("mode_of_payment", "Payment Method", "data"),
            col("payments", "Payments", "int"), col("amount", "Amount", "currency")],
        "rows": rows_out,
        "totals": {"amount": money(total)},
        "meta": meta,
    }))
}

/// Sales per day and item (or item group): quantity, net amount and its share of the invoices'
/// taxes. Returns count negatively, so the figures are net sales.
async fn daily_sales(tx: &mut Tx, ctx: &Ctx, co: &ReportCompany, r: &Range, by_group: bool) -> Result<Value> {
    let (keys, cols) = if by_group {
        ("p.posting_date, coalesce(g.group_name, ''), null::text, null::text", "1, 2")
    } else {
        ("p.posting_date, coalesce(g.group_name, ''), i.item_code, i.item_name", "1, 2, 3, 4")
    };
    let sql = format!(
        "select {keys}, coalesce(sum(l.qty), 0), coalesce(sum(l.net_amount), 0), \
         coalesce(sum(case when p.net_total <> 0 then l.net_amount * p.total_taxes / p.net_total else 0 end), 0) \
         from e_pos_invoice__items l join e_pos_invoice p on p.tenant_id = l.tenant_id and p.id = l.parent_id \
         join e_item i on i.tenant_id = l.tenant_id and i.id = l.item left join e_item_group g on g.tenant_id = i.tenant_id and g.id = i.item_group \
         where p.tenant_id = $1 and p.company = $2 and p.docstatus = 1 and p.posting_date between $3 and $4 and ($5::uuid is null or p.pos_profile = $5) \
         and ($6::text is null or lower(p.cashier) = $6) group by {cols} order by {cols}"
    );
    let data: Vec<(NaiveDate, String, Option<String>, Option<String>, Decimal, Decimal, Decimal)> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(ctx.tenant)
        .bind(r.company)
        .bind(r.from)
        .bind(r.to)
        .bind(r.profile)
        .bind(&r.cashier)
        .fetch_all(&mut **tx)
        .await?;
    let (mut tq, mut tn) = (Decimal::ZERO, Decimal::ZERO);
    let out: Vec<Value> = data
        .into_iter()
        .map(|(day, group, code, name, qty, net, tax)| {
            tq += qty;
            tn += net;
            json!({"posting_date": day, "item_group": group, "item_code": code, "item_name": name, "qty": money(qty), "net_amount": money(net),
                   "tax_amount": money(ferrum_domain::util::round(tax, co.precision))})
        })
        .collect();
    // The tax total comes from the invoices themselves, not from the rounded line shares.
    let taxes: Decimal = sqlx::query_scalar(
        "select coalesce(sum(total_taxes), 0) from e_pos_invoice p where p.tenant_id = $1 and p.company = $2 and p.docstatus = 1 \
         and p.posting_date between $3 and $4 and ($5::uuid is null or p.pos_profile = $5) and ($6::text is null or lower(p.cashier) = $6)",
    )
    .bind(ctx.tenant)
    .bind(r.company)
    .bind(r.from)
    .bind(r.to)
    .bind(r.profile)
    .bind(&r.cashier)
    .fetch_one(&mut **tx)
    .await?;
    let mut columns = vec![col("posting_date", "Date", "date"), col("item_group", "Item Group", "data")];
    if !by_group {
        columns.extend([col("item_code", "Item", "data"), col("item_name", "Item Name", "data")]);
    }
    columns.extend([col("qty", "Quantity", "decimal"), col("net_amount", "Net Amount", "currency"), col("tax_amount", "Tax", "currency")]);
    Ok(json!({"columns": columns, "rows": out, "totals": {"qty": money(tq), "net_amount": money(tn), "tax_amount": money(taxes)}}))
}

/// Expected against counted per closing and payment method.
async fn reconciliation(tx: &mut Tx, ctx: &Ctx, r: &Range) -> Result<Value> {
    let data: Vec<(
        Uuid,
        Option<String>,
        NaiveDate,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<Decimal>,
        Option<Decimal>,
        Option<Decimal>,
        Option<Decimal>,
    )> = sqlx::query_as(
        "select c.id, c.number, c.posting_date, o.number, c.\"user\", m.mode_name, x.opening_amount, x.expected_amount, x.closing_amount, x.difference \
             from e_pos_closing_entry c join e_pos_closing_entry__payments x on x.tenant_id = c.tenant_id and x.parent_id = c.id \
             left join e_mode_of_payment m on m.tenant_id = x.tenant_id and m.id = x.mode_of_payment \
             left join e_pos_opening_entry o on o.tenant_id = c.tenant_id and o.id = c.pos_opening_entry \
             where c.tenant_id = $1 and c.company = $2 and c.docstatus = 1 and c.posting_date between $3 and $4 and ($5::uuid is null or c.pos_profile = $5) \
             and ($6::text is null or lower(c.\"user\") = $6) order by c.posting_date, c.number, x.idx",
    )
    .bind(ctx.tenant)
    .bind(r.company)
    .bind(r.from)
    .bind(r.to)
    .bind(r.profile)
    .bind(&r.cashier)
    .fetch_all(&mut **tx)
    .await?;
    let mut totals = [Decimal::ZERO; 3];
    let out: Vec<Value> = data
        .into_iter()
        .map(|(cid, number, day, session, user, mode, opening, expected, counted, diff)| {
            totals[0] += expected.unwrap_or_default();
            totals[1] += counted.unwrap_or(expected.unwrap_or_default());
            totals[2] += diff.unwrap_or_default();
            json!({"closing_id": cid, "closing": number, "posting_date": day, "session": session, "cashier": user, "mode_of_payment": mode,
                   "opening_amount": money(opening.unwrap_or_default()), "expected_amount": money(expected.unwrap_or_default()),
                   "closing_amount": counted.map(money), "difference": money(diff.unwrap_or_default())})
        })
        .collect();
    Ok(json!({
        "columns": [col("closing", "Closing", "data"), col("posting_date", "Date", "date"), col("session", "Session", "data"), col("cashier", "Cashier", "data"),
            col("mode_of_payment", "Payment Method", "data"), col("opening_amount", "Opening", "currency"), col("expected_amount", "Expected", "currency"),
            col("closing_amount", "Counted", "currency"), col("difference", "Difference", "currency")],
        "rows": out,
        "totals": {"expected_amount": money(totals[0]), "closing_amount": money(totals[1]), "difference": money(totals[2])},
    }))
}

async fn top_items(tx: &mut Tx, ctx: &Ctx, r: &Range, limit: i64) -> Result<Value> {
    let data: Vec<(String, String, Decimal, Decimal, i64)> = sqlx::query_as(
        "select i.item_code, i.item_name, coalesce(sum(l.qty), 0), coalesce(sum(l.net_amount), 0), count(distinct p.id) \
         from e_pos_invoice__items l join e_pos_invoice p on p.tenant_id = l.tenant_id and p.id = l.parent_id join e_item i on i.tenant_id = l.tenant_id and i.id = l.item \
         where p.tenant_id = $1 and p.company = $2 and p.docstatus = 1 and p.posting_date between $3 and $4 and ($5::uuid is null or p.pos_profile = $5) \
         and ($6::text is null or lower(p.cashier) = $6) group by i.item_code, i.item_name order by 4 desc, 3 desc limit $7",
    )
    .bind(ctx.tenant)
    .bind(r.company)
    .bind(r.from)
    .bind(r.to)
    .bind(r.profile)
    .bind(&r.cashier)
    .bind(limit.clamp(1, 1000))
    .fetch_all(&mut **tx)
    .await?;
    let out: Vec<Value> = data
        .into_iter()
        .enumerate()
        .map(|(i, (code, name, qty, net, n))| json!({"rank": i + 1, "item_code": code, "item_name": name, "qty": money(qty), "net_amount": money(net), "invoices": n}))
        .collect();
    Ok(json!({
        "columns": [col("rank", "#", "int"), col("item_code", "Item", "data"), col("item_name", "Item Name", "data"), col("qty", "Quantity", "decimal"),
            col("net_amount", "Net Sales", "currency"), col("invoices", "Invoices", "int")],
        "rows": out,
    }))
}

async fn hourly(tx: &mut Tx, ctx: &Ctx, r: &Range) -> Result<Value> {
    let data: Vec<(String, i64, i64, Decimal, Decimal)> = sqlx::query_as(
        "select substr(coalesce(p.posting_time, '00'), 1, 2), count(*) filter (where not p.is_return), count(*) filter (where p.is_return), \
         coalesce(sum(p.net_total), 0), coalesce(sum(p.rounded_total), 0) from e_pos_invoice p \
         where p.tenant_id = $1 and p.company = $2 and p.docstatus = 1 and p.posting_date between $3 and $4 and ($5::uuid is null or p.pos_profile = $5) \
         and ($6::text is null or lower(p.cashier) = $6) group by 1 order by 1",
    )
    .bind(ctx.tenant)
    .bind(r.company)
    .bind(r.from)
    .bind(r.to)
    .bind(r.profile)
    .bind(&r.cashier)
    .fetch_all(&mut **tx)
    .await?;
    let (mut tn, mut tg) = (Decimal::ZERO, Decimal::ZERO);
    let out: Vec<Value> = data
        .into_iter()
        .map(|(hour, sales, rets, net, grand)| {
            tn += net;
            tg += grand;
            json!({"hour": format!("{hour}:00"), "sales": sales, "returns": rets, "net_total": money(net), "grand_total": money(grand)})
        })
        .collect();
    Ok(json!({
        "columns": [col("hour", "Hour", "data"), col("sales", "Sales", "int"), col("returns", "Returns", "int"), col("net_total", "Net Total", "currency"),
            col("grand_total", "Grand Total", "currency")],
        "rows": out,
        "totals": {"net_total": money(tn), "grand_total": money(tg)},
    }))
}

async fn returns(tx: &mut Tx, ctx: &Ctx, r: &Range) -> Result<Value> {
    let data: Vec<(Uuid, Option<String>, NaiveDate, Option<String>, Option<String>, Option<String>, Decimal, Decimal, Option<String>, Option<String>)> =
        sqlx::query_as(
            "select r.id, r.number, r.posting_date, r.customer_name, o.number, r.cashier, coalesce(-r.rounded_total, 0), \
             (select coalesce(sum(-l.qty), 0) from e_pos_invoice__items l where l.tenant_id = r.tenant_id and l.parent_id = r.id), \
             (select string_agg(distinct m.mode_name, ', ') from e_pos_invoice__payments pm join e_mode_of_payment m on m.tenant_id = pm.tenant_id \
              and m.id = pm.mode_of_payment where pm.tenant_id = r.tenant_id and pm.parent_id = r.id), r.status \
             from e_pos_invoice r left join e_pos_invoice o on o.tenant_id = r.tenant_id and o.id = r.return_against \
             where r.tenant_id = $1 and r.company = $2 and r.docstatus = 1 and r.is_return and r.posting_date between $3 and $4 \
             and ($5::uuid is null or r.pos_profile = $5) and ($6::text is null or lower(r.cashier) = $6) order by r.posting_date, r.number",
        )
        .bind(ctx.tenant)
        .bind(r.company)
        .bind(r.from)
        .bind(r.to)
        .bind(r.profile)
        .bind(&r.cashier)
        .fetch_all(&mut **tx)
        .await?;
    let total: Decimal = data.iter().map(|d| d.6).sum();
    let count = data.len();
    let out: Vec<Value> = data
        .into_iter()
        .map(|(rid, number, day, customer, original, cashier, amount, qty, modes, status)| {
            json!({"voucher_id": rid, "voucher_no": number, "posting_date": day, "customer": customer, "return_against": original, "cashier": cashier,
                   "qty": money(qty), "refund": money(amount), "refunded_via": modes, "status": status})
        })
        .collect();
    Ok(json!({
        "columns": [col("voucher_no", "Return", "data"), col("posting_date", "Date", "date"), col("return_against", "Original Sale", "data"),
            col("customer", "Customer", "data"), col("cashier", "Cashier", "data"), col("qty", "Quantity", "decimal"), col("refund", "Refund", "currency"),
            col("refunded_via", "Refunded Via", "data"), col("status", "Status", "data")],
        "rows": out,
        "totals": {"refund": money(total), "count": count},
    }))
}

/// One query per scan: the code is matched against item barcodes, the item's own barcode and
/// the item code (in that order); `search` matches codes and names, `item_group` browses a
/// group (both limited to the register's item groups). Prices come from the register's price
/// list (else the item's standard rate) and stock from its warehouse. Pricing rules apply on the
/// invoice, which (or its `_calc` preview) is the authority on the final price.
async fn item_lookup(tx: &mut Tx, ctx: &Ctx, p: &Params<'_>) -> Result<Value> {
    let profile = p.uuid("pos_profile")?.ok_or_else(|| Error::field("pos_profile", "is required"))?;
    let code = p.str("code");
    let search = p.str("search").map(|s| format!("%{}%", s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")));
    let group = p.uuid("item_group")?;
    if code.is_none() && search.is_none() && group.is_none() {
        return Err(Error::field("code", "give a barcode, a search text or an item group"));
    }
    let data: Vec<(Uuid, String, String, Option<String>, Option<Uuid>, Decimal, Option<Decimal>, Decimal, bool, bool, bool, Option<Uuid>)> = sqlx::query_as(
        "with prof as (select warehouse, price_list from e_pos_profile where tenant_id = $1 and id = $2), \
         lst as (select coalesce((select price_list from prof), \
           (select id from e_price_list where tenant_id = $1 and selling and enabled order by created_at limit 1)) as id), \
         shown as (select item_group from e_pos_profile__item_groups where tenant_id = $1 and parent_id = $2), \
         hit as ( \
           select item, coalesce(qty, 1) as qty, 0 as rank from e_item_barcode where tenant_id = $1 and $3::text is not null and barcode = $3 \
           union all select id, 1, 1 from e_item where tenant_id = $1 and $3::text is not null and barcode = $3 \
           union all select id, 1, 2 from e_item where tenant_id = $1 and $3::text is not null and item_code = $3 \
           union all (select id, 1, 3 from e_item where tenant_id = $1 and $3::text is null and $4::text is not null \
             and (item_code ilike $4 or item_name ilike $4 or barcode = $5) order by item_code limit 50) \
           union all (select id, 1, 4 from e_item where tenant_id = $1 and $3::text is null and $4::text is null and item_group = $6 order by item_code limit 200)) \
         select i.id, i.item_code, i.item_name, u.uom_name, i.stock_uom, h.qty, \
           coalesce((select ip.rate from e_item_price ip where ip.tenant_id = $1 and ip.item = i.id and ip.price_list = (select id from lst) \
             and ip.valid_from <= current_date and (ip.valid_upto is null or ip.valid_upto >= current_date) order by ip.valid_from desc limit 1), i.standard_rate), \
           coalesce((select b.qty from stock_balance b where b.tenant_id = $1 and b.item_id = i.id and b.warehouse_id = (select warehouse from prof)), 0), \
           i.is_stock_item, i.has_serial_no, i.has_batch_no, i.item_group \
         from hit h join e_item i on i.tenant_id = $1 and i.id = h.item left join e_uom u on u.tenant_id = i.tenant_id and u.id = i.stock_uom \
         where not i.disabled and (h.rank < 3 or not exists (select 1 from shown) or i.item_group in (select item_group from shown)) \
         order by h.rank, i.item_code limit 50",
    )
    .bind(ctx.tenant)
    .bind(profile)
    .bind(code)
    .bind(&search)
    .bind(p.str("search"))
    .bind(group)
    .fetch_all(&mut **tx)
    .await?;
    let out: Vec<Value> = data
        .into_iter()
        .map(|(item, code, name, uom, stock_uom, qty, rate, actual, is_stock, serial, batch, group)| {
            json!({"item": item, "item_code": code, "item_name": name, "uom": uom, "stock_uom": stock_uom, "qty": money(qty),
                   "rate": rate.map(money), "actual_qty": money(actual), "is_stock_item": is_stock, "has_serial_no": serial, "has_batch_no": batch,
                   "item_group": group})
        })
        .collect();
    Ok(json!({
        "columns": [col("item_code", "Item", "data"), col("item_name", "Item Name", "data"), col("uom", "Unit", "data"), col("qty", "Qty per Scan", "decimal"),
            col("rate", "Price", "currency"), col("actual_qty", "In Stock", "decimal")],
        "rows": out,
    }))
}
