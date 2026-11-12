//! The returns desk's lookups (`/api/app/pos/returns`): which sale a customer brings back, and what
//! can still come back on it.
//!
//! A cashier's rights read only their own sales (`PosInvoice` is `if_owner`), but a customer takes
//! the receipt to whichever till is free, so these read every sale of the register's company, for a
//! person who may take returns at that register. They show the rules the return itself is held to
//! (`invoice::check_return`) before it refuses: what is left on each line, the room each payment
//! method leaves for refunds, and why a sale cannot be returned here yet.

use crate::invoice::{left_to_refund, returned_so_far, taken};
use crate::logic::{Way, plan_refund};
use crate::loyalty::Program;
use crate::site::param;
use crate::{Profile, is_manager, open_session_in};
use chrono::NaiveDate;
use ferrum_app_erp::stock::parse_serials;
use ferrum_domain::util::{b, d, get, id, money, rows, s};
use ferrum_kernel::{Action, Ctx, Error, Kernel, Result, SiteRequest, Tx};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

/// Sales shown for one search.
const FOUND: i64 = 25;

/// The register the request names, for a person who may take returns there.
async fn register(k: &Kernel, ctx: &Ctx, req: &SiteRequest, tx: &mut Tx) -> Result<Profile> {
    ctx.require("PosInvoice", Action::Create)?;
    let pid: Uuid = param(req, "profile").and_then(|v| v.parse().ok()).ok_or_else(|| Error::field("profile", "is required"))?;
    // Reading the register is the right to work at it.
    k.get(ctx, "PosProfile", pid, false).await?;
    let profile = Profile::load(k, ctx, tx, pid).await?;
    if !profile.admits(&ctx.email) && !is_manager(ctx) {
        return Err(Error::Forbidden(format!("{} is not allowed at register {}", ctx.email, profile.name())));
    }
    Ok(profile)
}

/// Why a sale cannot be returned at this till yet, if it cannot: the same rules the return is held
/// to, put as a reason a cashier can act on.
fn why_blocked(left_qty: Decimal, consolidated: bool, sale_session: Option<Uuid>, mine: Option<Uuid>, past_window: bool) -> Option<&'static str> {
    if left_qty <= Decimal::ZERO {
        return Some("everything on it has already been returned");
    }
    if past_window {
        return Some("it is past the days this register takes returns within");
    }
    if mine.is_none() {
        return Some("open the register before taking a return");
    }
    if !consolidated && sale_session != mine {
        return Some("it is still in another open session: return it there, or once that session is closed");
    }
    None
}

/// The days the register's return policy takes a sale back within (0: no limit, and none without a policy).
async fn window_days(k: &Kernel, ctx: &Ctx, tx: &mut Tx, profile: &Profile) -> Result<i64> {
    Ok(match id(&profile.doc, "return_policy") {
        Some(p) => get(k, ctx, tx, "PosReturnPolicy", p).await?.get("window_days").and_then(Value::as_i64).unwrap_or(0),
        None => 0,
    })
}

/// The last day a sale taken on `day` comes back, when the register has a window.
fn until(day: NaiveDate, window: i64) -> Option<NaiveDate> {
    (window > 0).then(|| day + chrono::Duration::days(window))
}

fn past(day: NaiveDate, window: i64, today: NaiveDate) -> bool {
    until(day, window).is_some_and(|last| last < today)
}

fn date_of(sale: &ferrum_kernel::Doc) -> NaiveDate {
    s(sale, "posting_date").and_then(|d| d.parse().ok()).unwrap_or_default()
}

#[derive(sqlx::FromRow)]
struct Found {
    id: Uuid,
    number: Option<String>,
    posting_date: NaiveDate,
    posting_time: Option<String>,
    customer_name: Option<String>,
    cashier: Option<String>,
    register: Option<String>,
    rounded_total: Option<Decimal>,
    status: Option<String>,
    session: Option<Uuid>,
    consolidated: bool,
    left_qty: Decimal,
}

/// `GET /returns?profile=&q=&days=`: sales of the register's company that can be looked up for a
/// return, newest first. With no `q` only today's; with one, whatever matches the receipt number
/// or the customer's name within `days` (90 unless asked). Each says what is left on it and, when
/// nothing can come back yet, why.
pub async fn search(k: &Kernel, ctx: &Ctx, req: &SiteRequest) -> Result<Value> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let profile = register(k, ctx, req, &mut tx).await?;
    let company = id(&profile.doc, "company").ok_or_else(|| Error::invalid("the register has no company"))?;
    let q = param(req, "q").map(|q| format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")));
    let days = param(req, "days").and_then(|v| v.parse::<i64>().ok()).unwrap_or(90).clamp(1, 3650);
    let since = if q.is_some() { ctx.today() - chrono::Duration::days(days) } else { ctx.today() };
    let mine = open_session_in(&mut tx, ctx.tenant, profile.id, &ctx.email).await?;
    // A scanned receipt (its number, whole) is found whatever its age: the register's window decides if it can come back.
    let scanned = param(req, "q").map(str::to_string);
    let window = window_days(k, ctx, &mut tx, &profile).await?;
    let found: Vec<Found> = sqlx::query_as(
        "select p.id, p.number, p.posting_date, p.posting_time, p.customer_name, p.cashier, f.profile_name as register, p.rounded_total, p.status, \
         p.pos_opening_entry as session, (p.consolidated_invoice is not null) as consolidated, \
         (select coalesce(sum(l.qty), 0) from e_pos_invoice__items l where l.tenant_id = p.tenant_id and l.parent_id = p.id) \
         - (select coalesce(sum(-l.qty), 0) from e_pos_invoice__items l join e_pos_invoice r on r.tenant_id = l.tenant_id and r.id = l.parent_id \
            where r.tenant_id = p.tenant_id and r.return_against = p.id and r.docstatus = 1) as left_qty \
         from e_pos_invoice p left join e_pos_profile f on f.tenant_id = p.tenant_id and f.id = p.pos_profile \
         where p.tenant_id = $1 and p.company = $2 and p.docstatus = 1 and not p.is_return and (p.posting_date >= $3 or upper(p.number) = upper($6)) \
         and ($4::text is null or p.number ilike $4 or p.customer_name ilike $4) \
         order by p.posting_date desc, p.posting_time desc nulls last, p.created_at desc limit $5",
    )
    .bind(ctx.tenant)
    .bind(company)
    .bind(since)
    .bind(&q)
    .bind(FOUND)
    .bind(scanned)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let sales: Vec<Value> = found
        .iter()
        .map(|f| {
            json!({
                "id": f.id, "number": f.number, "posting_date": f.posting_date, "posting_time": f.posting_time, "customer": f.customer_name,
                "cashier": f.cashier, "register": f.register, "total": f.rounded_total.map(money), "status": f.status, "left_qty": money(f.left_qty),
                "returns_until": until(f.posting_date, window),
                "blocked": why_blocked(f.left_qty, f.consolidated, f.session, mine, past(f.posting_date, window, ctx.today())),
            })
        })
        .collect();
    Ok(json!({"rows": sales, "since": since, "window_days": window}))
}

/// `GET /returns/{sale}?profile=`: one sale as a return desk needs it: its lines with what was
/// sold and returned, what each payment method took in and can still give back, the classes the
/// refund must respect (`refundable`: what is owed on account is cancelled first, points go back as
/// points, only what came in as money goes back as money), and a receipt to print a copy of.
pub async fn sheet(k: &Kernel, ctx: &Ctx, req: &SiteRequest, sale: Uuid) -> Result<Value> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let profile = register(k, ctx, req, &mut tx).await?;
    let orig = get(k, ctx, &mut tx, "PosInvoice", sale).await?;
    if d(&orig, "docstatus") != Decimal::ONE || b(&orig, "is_return") || id(&orig, "company") != id(&profile.doc, "company") {
        return Err(Error::NotFound("sale".into()));
    }
    let mine = open_session_in(&mut tx, ctx.tenant, profile.id, &ctx.email).await?;
    let window = window_days(k, ctx, &mut tx, &profile).await?;
    let done = returned_so_far(&mut tx, ctx.tenant, sale, None).await?;
    let mut left_qty = Decimal::ZERO;
    let lines: Vec<Value> = rows(&orig, "items")
        .iter()
        .map(|l| {
            let sold = d(l, "qty");
            let back = done.get(s(l, "id").unwrap_or_default()).copied().unwrap_or_default();
            let left = (sold - back).max(Decimal::ZERO);
            left_qty += left;
            json!({
                "id": l.get("id"), "item": l.get("item"), "item_name": l.get("item_name"), "sold": money(sold), "returned": money(back), "left": money(left),
                "rate": l.get("rate"), "amount": l.get("amount"), "serials": parse_serials(s(l, "serial_no")), "batch_no": l.get("batch_no"), "note": l.get("note"),
            })
        })
        .collect();

    let room = taken(&mut tx, ctx.tenant, &orig, None).await?;
    let left = left_to_refund(&room, &orig);
    let paid_with: Vec<Value> =
        room.iter().map(|t| json!({"mode": t.mode, "paid": money(t.paid), "refunded": money(t.refunded), "left": money(t.room())})).collect();
    let methods: Vec<Value> = profile
        .modes
        .iter()
        .map(|(m, in_returns)| {
            json!({"mode": m.id, "name": m.name, "kind": s(&m.doc, "mode_type"), "usable": in_returns,
                   "why": (!*in_returns).then_some("this register does not refund through it")})
        })
        .collect();

    // Points go back as points: how many are left to return, and what one is worth.
    let loyalty = match id(&orig, "loyalty_program") {
        Some(program) if left.loyalty > Decimal::ZERO => {
            let program = Program::load(k, ctx, &mut tx, program).await?;
            let redeemed = orig.get("loyalty_points_redeemed").and_then(Value::as_i64).unwrap_or(0);
            let back: i64 = sqlx::query_scalar(
                "select coalesce(sum(pm.loyalty_points), 0)::bigint from e_pos_invoice__payments pm join e_pos_invoice p on p.tenant_id = pm.tenant_id and p.id = pm.parent_id \
                 where p.tenant_id = $1 and p.return_against = $2 and p.docstatus = 1 and pm.mode_type = 'Loyalty Points'",
            )
            .bind(ctx.tenant)
            .bind(sale)
            .fetch_one(&mut *tx)
            .await?;
            json!({"factor": money(program.conversion_factor), "points_left": (redeemed - back).max(0)})
        }
        _ => Value::Null,
    };

    let pays = rows(&orig, "payments");
    let modes: Vec<Uuid> = pays.iter().filter_map(|p| id(p, "mode_of_payment")).collect();
    let names: HashMap<Uuid, String> = sqlx::query_as::<_, (Uuid, String)>("select id, mode_name from e_mode_of_payment where tenant_id = $1 and id = any($2)")
        .bind(ctx.tenant)
        .bind(&modes)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect();
    let register_name: Option<String> = match id(&orig, "pos_profile") {
        Some(p) => {
            sqlx::query_scalar("select profile_name from e_pos_profile where tenant_id = $1 and id = $2")
                .bind(ctx.tenant)
                .bind(p)
                .fetch_optional(&mut *tx)
                .await?
        }
        None => None,
    };
    tx.commit().await?;

    let receipt = json!({
        "number": orig.get("number"), "posting_date": orig.get("posting_date"), "posting_time": orig.get("posting_time"), "customer_name": orig.get("customer_name"),
        "items": rows(&orig, "items").iter().map(|l| json!({"item_name": l.get("item_name"), "qty": l.get("qty"), "rate": l.get("rate"), "amount": l.get("amount"), "note": l.get("note")})).collect::<Vec<_>>(),
        "payments": pays.iter().map(|p| json!({
            "mode_of_payment": p.get("mode_of_payment"), "amount": p.get("amount"), "reference_no": p.get("reference_no"),
            "_titles": {"mode_of_payment": id(p, "mode_of_payment").and_then(|m| names.get(&m))},
        })).collect::<Vec<_>>(),
        "total": orig.get("total"), "discount_amount": orig.get("discount_amount"), "total_taxes": orig.get("total_taxes"),
        "grand_total": orig.get("grand_total"), "rounded_total": orig.get("rounded_total"), "change_amount": orig.get("change_amount"),
    });
    Ok(json!({
        "sale": {
            "id": sale, "number": orig.get("number"), "posting_date": orig.get("posting_date"), "posting_time": orig.get("posting_time"),
            "customer": orig.get("customer"), "customer_name": orig.get("customer_name"), "cashier": orig.get("cashier"), "register": register_name,
            "status": orig.get("status"), "total": orig.get("rounded_total"), "write_off": orig.get("write_off_amount"),
        },
        "returns_until": until(date_of(&orig), window),
        "blocked": why_blocked(left_qty, id(&orig, "consolidated_invoice").is_some(), id(&orig, "pos_opening_entry"), mine, past(date_of(&orig), window, ctx.today())),
        "lines": lines,
        "paid_with": paid_with,
        "methods": methods,
        "refundable": {"money": money(left.money), "loyalty": money(left.loyalty), "credit": money(left.credit), "stored_value": money(left.stored)},
        "loyalty": loyalty,
        "receipt": receipt,
    }))
}

/// `POST /returns/{sale}/plan` `{profile, lines: [{line, qty, condition?}]}`: what a return of those lines is worth and how the
/// register proposes to refund it: back through the methods the sale was paid with where the register allows and
/// they have room, the rest onto store credit or out as cash as the return policy says, what the customer still owes
/// cancelled first. A proposal: the return itself is held to `check_refunds` whatever is sent.
pub async fn plan(k: &Kernel, ctx: &Ctx, req: &SiteRequest, sale: Uuid) -> Result<Value> {
    let v: Value = serde_json::from_slice(&req.body).map_err(|_| Error::invalid("send a JSON object"))?;
    let pid: Uuid = v.get("profile").and_then(Value::as_str).and_then(|p| p.parse().ok()).ok_or_else(|| Error::field("profile", "is required"))?;
    ctx.require("PosInvoice", Action::Create)?;
    k.get(ctx, "PosProfile", pid, false).await?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let profile = Profile::load(k, ctx, &mut tx, pid).await?;
    let orig = get(k, ctx, &mut tx, "PosInvoice", sale).await?;
    if d(&orig, "docstatus") != Decimal::ONE || b(&orig, "is_return") || id(&orig, "company") != id(&profile.doc, "company") {
        return Err(Error::NotFound("sale".into()));
    }
    let sold = rows(&orig, "items");
    let mut items = Vec::new();
    for l in v.get("lines").and_then(Value::as_array).ok_or_else(|| Error::field("lines", "is required: the lines coming back"))? {
        let line = l
            .get("line")
            .and_then(Value::as_str)
            .and_then(|x| sold.iter().find(|r| s(r, "id") == Some(x)))
            .ok_or_else(|| Error::field("lines", "a line that is not on the sale"))?;
        let qty: Decimal = l
            .get("qty")
            .and_then(Value::as_str)
            .and_then(|q| q.parse().ok())
            .filter(|q: &Decimal| *q > Decimal::ZERO)
            .ok_or_else(|| Error::field("qty", "is a positive quantity"))?;
        items.push(json!({"item": line.get("item"), "qty": (-qty).to_string(), "original_line": line.get("id"), "condition": l.get("condition")}));
    }
    let draft = json!({"pos_profile": pid, "is_return": true, "return_against": sale, "items": items});
    let priced = k.preview(ctx, "PosInvoice", draft.as_object().cloned().unwrap_or_default()).await?;
    let total = -d(&priced, "rounded_total");
    let room = taken(&mut tx, ctx.tenant, &orig, None).await?;
    let left = left_to_refund(&room, &orig);
    let policy = match id(&profile.doc, "return_policy") {
        Some(p) => Some(get(k, ctx, &mut tx, "PosReturnPolicy", p).await?),
        None => None,
    };
    tx.commit().await?;
    // The methods the sale was paid with, in the order it used them, then the rest of the register's.
    let mut ways: Vec<Way<Uuid>> =
        room.iter().filter_map(|t| Some(Way { mode: t.mode, kind: t.kind, room: t.room(), usable: profile.mode(t.mode)?.1 })).collect();
    for (m, ok) in &profile.modes {
        if !ways.iter().any(|w| w.mode == m.id) {
            ways.push(Way { mode: m.id, kind: m.kind, room: Decimal::ZERO, usable: *ok });
        }
    }
    let store_credit = policy.as_ref().and_then(|p| id(p, "store_credit")).filter(|m| profile.mode(*m).is_some_and(|x| x.1));
    let cash_to = profile.cash_mode().filter(|m| profile.mode(m.id).is_some_and(|x| x.1)).map(|m| m.id);
    let prefer_store_credit = policy.as_ref().and_then(|p| s(p, "unrefundable_to")) != Some("Cash");
    let (refunds, unplaced) = plan_refund(total, &ways, left.credit, store_credit, cash_to, prefer_store_credit);
    let name = |m: Uuid| profile.mode(m).map(|(x, _)| x.name.clone());
    Ok(json!({
        "total": money(total),
        "refunds": refunds.iter().map(|(m, a)| json!({"mode": m, "name": name(*m), "kind": profile.mode(*m).and_then(|x| s(&x.0.doc, "mode_type")), "amount": money(*a)})).collect::<Vec<_>>(),
        "unplaced": money(unplaced),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_why_a_sale_cannot_come_back_yet() {
        let (here, elsewhere) = (Some(Uuid::from_u128(1)), Some(Uuid::from_u128(2)));
        let one = Decimal::ONE;
        assert_eq!(why_blocked(one, false, here, here, false), None, "a sale of this very session");
        assert_eq!(why_blocked(one, true, elsewhere, here, false), None, "a closed session's sale was consolidated");
        assert!(why_blocked(one, false, elsewhere, here, false).unwrap().contains("another open session"));
        assert!(why_blocked(Decimal::ZERO, true, here, here, true).unwrap().contains("already been returned"), "that is said first");
        assert!(why_blocked(one, true, here, None, false).unwrap().contains("open the register"));
        assert!(why_blocked(one, true, here, here, true).unwrap().contains("past the days"));
    }
}
