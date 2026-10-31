//! Closing a session: counting the drawer against what the register expects, then consolidating
//! the session's POS invoices into the books.
//!
//! As in ERPNext, the session's paid sales become one sales invoice per customer and its returns
//! credit notes per customer (here per customer and original invoice, which a credit note must
//! name). A sale left partly on account gets an invoice of its own, so each unpaid sale stays a
//! separate receivable with its own due date. Consolidated invoices never move stock (the POS
//! invoices did); they carry the POS taxes as fixed amounts and the cash rounding as an amount,
//! so each one totals exactly what its POS invoices did (checked). One journal entry of the
//! closing then settles every consolidated invoice per payment method (cash net of change,
//! cards, points, write-offs) and books what the count found missing or extra.

use crate::logic::{self, Kind, Tender};
use crate::session::open_key;
use crate::{Mode, Profile, is_manager, live_session, opt_dec, rows_value};
use async_trait::async_trait;
use ferrum_app_erp::flow::sync_invoice_outstanding;
use ferrum_app_erp::ledger::{self, Entry, Line};
use ferrum_domain::util::{Company, company, d, date, elevated, get, id, money, rows, s, set, sys};
use ferrum_kernel::{Ctx, Doc, DocHook, Error, HookCtx, Kernel, Result, Tx};
use rust_decimal::{Decimal, RoundingStrategy};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct Inv {
    id: Uuid,
    number: Option<String>,
    customer: Uuid,
    is_return: bool,
    return_against: Option<Uuid>,
    rounded_total: Option<Decimal>,
    net_total: Option<Decimal>,
    total_taxes: Option<Decimal>,
    rounding_adjustment: Option<Decimal>,
    change_amount: Option<Decimal>,
    write_off_amount: Option<Decimal>,
    tax_template: Option<Uuid>,
}

impl Inv {
    fn total(&self) -> Decimal {
        self.rounded_total.unwrap_or_default()
    }
}

/// A payment of a POS invoice, net of the change it gave.
struct Pay {
    invoice: Uuid,
    mode: Uuid,
    kind: Kind,
    account: Option<Uuid>,
    amount: Decimal,
}

/// The submitted POS invoices of a session with their payments, and its cash movements.
struct Takings {
    invoices: Vec<Inv>,
    pays: Vec<Pay>,
    /// `(mode, signed amount)`: cash in positive, cash out negative.
    cash: Vec<(Option<Uuid>, Decimal)>,
}

impl Takings {
    async fn load(tx: &mut Tx, tenant: Uuid, session: Uuid, unconsolidated: bool) -> Result<Takings> {
        let invoices: Vec<Inv> = sqlx::query_as(
            "select id, number, customer, is_return, return_against, rounded_total, net_total, total_taxes, rounding_adjustment, change_amount, \
             write_off_amount, tax_template from e_pos_invoice where tenant_id = $1 and pos_opening_entry = $2 and docstatus = 1 \
             and ($3 = false or consolidated_invoice is null) order by posting_date, posting_time, created_at",
        )
        .bind(tenant)
        .bind(session)
        .bind(unconsolidated)
        .fetch_all(&mut **tx)
        .await?;
        let ids: Vec<Uuid> = invoices.iter().map(|i| i.id).collect();
        let rows: Vec<(Uuid, Uuid, Option<String>, Option<Uuid>, Option<Decimal>)> = sqlx::query_as(
            "select parent_id, mode_of_payment, mode_type, account, amount from e_pos_invoice__payments where tenant_id = $1 and parent_id = any($2) \
             order by parent_id, idx",
        )
        .bind(tenant)
        .bind(&ids)
        .fetch_all(&mut **tx)
        .await?;
        let mut by_invoice: HashMap<Uuid, Vec<&(Uuid, Uuid, Option<String>, Option<Uuid>, Option<Decimal>)>> = HashMap::new();
        for r in &rows {
            by_invoice.entry(r.0).or_default().push(r);
        }
        let mut pays = Vec::with_capacity(rows.len());
        for inv in &invoices {
            let mine = by_invoice.remove(&inv.id).unwrap_or_default();
            let mut tenders: Vec<Tender> =
                mine.iter().map(|r| Tender { kind: r.2.as_deref().and_then(Kind::parse).unwrap_or(Kind::General), amount: r.4.unwrap_or_default() }).collect();
            logic::net_of_change(inv.change_amount.unwrap_or_default(), &mut tenders);
            for (r, t) in mine.iter().zip(tenders) {
                pays.push(Pay { invoice: inv.id, mode: r.1, kind: t.kind, account: r.3, amount: t.amount });
            }
        }
        let cash: Vec<(Option<Uuid>, String, Decimal)> = sqlx::query_as(
            "select mode_of_payment, movement_type, amount from e_pos_cash_movement where tenant_id = $1 and pos_opening_entry = $2 and docstatus = 1",
        )
        .bind(tenant)
        .bind(session)
        .fetch_all(&mut **tx)
        .await?;
        let cash = cash.into_iter().map(|(m, t, a)| (m, if t == "Cash Out" { -a } else { a })).collect();
        Ok(Takings { invoices, pays, cash })
    }

    /// What should be in each money mode at closing: opening float, takings net of change and
    /// refunds, cash moved in or out.
    fn expected(&self, opening: &BTreeMap<Uuid, Decimal>, cash_mode: Option<Uuid>) -> BTreeMap<Uuid, Decimal> {
        let mut out = opening.clone();
        for p in self.pays.iter().filter(|p| p.kind.is_money()) {
            *out.entry(p.mode).or_default() += p.amount;
        }
        for (mode, amount) in &self.cash {
            if let Some(m) = mode.or(cash_mode) {
                *out.entry(m).or_default() += *amount;
            }
        }
        out
    }
}

/// Opening float per mode of a session.
fn opening(session: &Doc) -> BTreeMap<Uuid, Decimal> {
    let mut out = BTreeMap::new();
    for r in rows(session, "balance_details") {
        if let Some(m) = id(&r, "mode_of_payment") {
            *out.entry(m).or_default() += d(&r, "opening_amount");
        }
    }
    out
}

/// The reconciliation rows of a session: one per money mode, counted amounts kept (or taken
/// from the denominations counted), expected amounts and differences recomputed.
pub(crate) async fn reconcile(k: &Kernel, ctx: &Ctx, tx: &mut Tx, session: &Doc, counted: &[Doc], denominations: &[Doc]) -> Result<Vec<Doc>> {
    let sid = id(session, "id").ok_or_else(|| Error::internal("session without id"))?;
    let profile = Profile::load(k, ctx, tx, id(session, "pos_profile").unwrap_or_default()).await?;
    let takings = Takings::load(tx, ctx.tenant, sid, false).await?;
    let cash_mode = profile.cash_mode().map(|m| m.id);
    let open = opening(session);
    let expected = takings.expected(&open, cash_mode);
    let mut order: Vec<Uuid> = profile.modes.iter().filter(|(m, _)| m.kind.is_money()).map(|(m, _)| m.id).collect();
    for m in expected.keys() {
        if !order.contains(m) {
            order.push(*m);
        }
    }
    let mut counted_cash: HashMap<Uuid, Decimal> = HashMap::new();
    for r in denominations {
        if let Some(m) = id(r, "mode_of_payment").or(cash_mode) {
            *counted_cash.entry(m).or_default() += d(r, "amount");
        }
    }
    let mut out = Vec::new();
    for (i, m) in order.into_iter().enumerate() {
        let given = counted.iter().find(|r| id(r, "mode_of_payment") == Some(m));
        let exp = expected.get(&m).copied().unwrap_or_default();
        let count = counted_cash.get(&m).copied().or_else(|| given.and_then(|r| opt_dec(r, "closing_amount")));
        let mut row = Doc::new();
        row.insert("id".into(), given.and_then(|r| r.get("id").cloned()).unwrap_or_else(|| json!(Uuid::now_v7().to_string())));
        row.insert("idx".into(), json!(i));
        row.insert("mode_of_payment".into(), json!(m.to_string()));
        row.insert("opening_amount".into(), money(open.get(&m).copied().unwrap_or_default()));
        row.insert("expected_amount".into(), money(exp));
        row.insert("closing_amount".into(), count.map(money).unwrap_or(Value::Null));
        row.insert("difference".into(), money(count.map(|c| c - exp).unwrap_or_default()));
        out.push(row);
    }
    Ok(out)
}

pub struct ClosingHook;

#[async_trait]
impl DocHook for ClosingHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        let sid = id(doc, "pos_opening_entry").ok_or_else(|| Error::field("pos_opening_entry", "is required"))?;
        let session = get(hc.kernel, hc.ctx, hc.tx, "PosOpeningEntry", sid).await?;
        let mut denominations = rows(doc, "denominations");
        for r in denominations.iter_mut() {
            let n = r.get("count").and_then(Value::as_i64).unwrap_or(0);
            set(r, "amount", money(logic::count_cash(&[(d(r, "denomination"), n)])));
        }
        let rows_ = reconcile(hc.kernel, hc.ctx, hc.tx, &session, &rows(doc, "payments"), &denominations).await?;
        let takings = Takings::load(hc.tx, hc.ctx.tenant, sid, false).await?;
        let sum = |f: fn(&Inv) -> Option<Decimal>| -> Decimal { takings.invoices.iter().map(|i| f(i).unwrap_or_default()).sum() };
        set(doc, "invoice_count", json!(takings.invoices.iter().filter(|i| !i.is_return).count()));
        set(doc, "return_count", json!(takings.invoices.iter().filter(|i| i.is_return).count()));
        set(doc, "net_total", money(sum(|i| i.net_total)));
        set(doc, "total_taxes", money(sum(|i| i.total_taxes)));
        set(doc, "grand_total", money(sum(|i| i.rounded_total)));
        set(doc, "total_difference", money(rows_.iter().map(|r| d(r, "difference")).sum()));
        set(doc, "payments", rows_value(rows_));
        set(doc, "denominations", rows_value(denominations));
        if d(doc, "docstatus").is_zero() {
            set(doc, "status", "Draft");
        }
        Ok(())
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let session = live_session(hc, id(doc, "pos_opening_entry").unwrap_or_default(), false).await?;
        let cashier = s(&session, "user").unwrap_or_default();
        if !cashier.eq_ignore_ascii_case(&hc.ctx.email) && !is_manager(hc.ctx) {
            return Err(Error::Forbidden(format!("only {cashier} or a POS Manager can close this session")));
        }
        Ok(())
    }

    async fn before_submit(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        let sid = id(doc, "pos_opening_entry").unwrap_or_default();
        live_session(hc, sid, true).await?;
        let drafts: i64 = sqlx::query_scalar("select count(*) from e_pos_invoice where tenant_id = $1 and pos_opening_entry = $2 and docstatus = 0")
            .bind(hc.ctx.tenant)
            .bind(sid)
            .fetch_one(&mut **hc.tx)
            .await?;
        if drafts > 0 {
            return Err(Error::invalid(format!("{drafts} unfinished sale(s) are still open in this session; submit or delete them first")));
        }
        set(doc, "period_end", chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        set(doc, "status", "Submitted");
        Ok(())
    }

    async fn on_submit(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        consolidate(hc, doc).await
    }

    async fn before_cancel(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let cid = id(doc, "id").ok_or_else(|| Error::internal("no id"))?;
        let made = consolidated(hc, cid).await?;
        let ids: Vec<Uuid> = made.iter().map(|m| m.0).collect();
        let blocker: Option<String> = sqlx::query_scalar(
            "select 'credit note ' || coalesce(number, id::text) || ' was made against an invoice of this closing' from e_sales_invoice \
               where tenant_id = $1 and return_against = any($2) and docstatus = 1 and not (id = any($2)) \
             union all select 'payments were received against invoice ' || coalesce(o.number, o.id::text) from allocation a \
               join open_item o on o.tenant_id = a.tenant_id and o.id = a.open_item_id \
               where a.tenant_id = $1 and a.open_item_id = any($2) and a.payment_entity = 'PaymentEntry' and a.reversal_of is null \
               and not exists (select 1 from allocation r where r.tenant_id = a.tenant_id and r.reversal_of = a.id) \
             union all select 'return ' || coalesce(r.number, r.id::text) || ' was made against a sale of this closing' from e_pos_invoice r \
               where r.tenant_id = $1 and r.docstatus = 1 and r.pos_closing_entry is distinct from $3 \
               and r.return_against in (select id from e_pos_invoice where tenant_id = $1 and pos_closing_entry = $3) \
             limit 1",
        )
        .bind(hc.ctx.tenant)
        .bind(&ids)
        .bind(cid)
        .fetch_optional(&mut **hc.tx)
        .await?;
        if let Some(b) = blocker {
            return Err(Error::invalid(format!("{b}; cancel it first")));
        }
        let session = get(hc.kernel, hc.ctx, hc.tx, "PosOpeningEntry", id(doc, "pos_opening_entry").unwrap_or_default()).await?;
        let key = open_key(s(&session, "pos_profile").unwrap_or_default(), s(&session, "user").unwrap_or_default());
        let reopened: bool = sqlx::query_scalar("select exists(select 1 from e_pos_opening_entry where tenant_id = $1 and open_key = $2)")
            .bind(hc.ctx.tenant)
            .bind(&key)
            .fetch_one(&mut **hc.tx)
            .await?;
        if reopened {
            return Err(Error::invalid("the cashier has opened a new session at this register; close it before reopening this one"));
        }
        Ok(())
    }

    async fn on_cancel(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let cid = id(doc, "id").ok_or_else(|| Error::internal("no id"))?;
        let co = company(hc.kernel, hc.ctx, hc.tx, id(doc, "company").unwrap_or_default()).await?;
        let (on, _) = ledger::reversal_point(hc.tx, hc.ctx.tenant, co.id, doc).await?;
        // Settlements first, so the invoices have nothing allocated when they are cancelled;
        // credit notes before the invoices they settle against.
        ledger::unallocate(hc.tx, hc.ctx, "PosClosingEntry", cid, on).await?;
        ledger::reverse(hc.tx, hc.ctx, "PosClosingEntry", cid, on, co.precision).await?;
        let mut made = consolidated(hc, cid).await?;
        made.sort_by_key(|m| !m.1);
        for (si, _) in made {
            hc.kernel.cancel_tx(&elevated(hc.ctx), hc.tx, "SalesInvoice", si, None).await?;
        }
        sqlx::query(
            "update e_pos_invoice p set consolidated_invoice = null, pos_closing_entry = null, updated_at = now(), status = case when p.is_return then 'Return' \
             when exists (select 1 from e_pos_invoice__payments pm where pm.tenant_id = p.tenant_id and pm.parent_id = p.id and pm.mode_type = 'Credit' and pm.amount > 0) \
             then 'Unpaid' else 'Paid' end where p.tenant_id = $1 and p.pos_closing_entry = $2",
        )
        .bind(hc.ctx.tenant)
        .bind(cid)
        .execute(&mut **hc.tx)
        .await?;
        let sid = id(doc, "pos_opening_entry").unwrap_or_default();
        let session = get(hc.kernel, hc.ctx, hc.tx, "PosOpeningEntry", sid).await?;
        let mut v = Doc::new();
        v.insert("status".into(), json!("Open"));
        v.insert("pos_closing_entry".into(), Value::Null);
        v.insert("period_end".into(), Value::Null);
        v.insert("open_key".into(), json!(open_key(s(&session, "pos_profile").unwrap_or_default(), s(&session, "user").unwrap_or_default())));
        hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "PosOpeningEntry", sid, v).await?;
        let mut v = Doc::new();
        v.insert("status".into(), json!("Cancelled"));
        hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "PosClosingEntry", cid, v).await
    }
}

/// Consolidated invoices belong to their closing: cancelling one alone would leave register sales
/// pointing at a cancelled invoice, so only the closing's own cancellation (an engine context) may.
pub struct ConsolidatedGuard;

#[async_trait]
impl DocHook for ConsolidatedGuard {
    async fn before_cancel(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        if hc.ctx.is_system || hc.ctx.schema.entity("PosInvoice").is_none() {
            return Ok(());
        }
        let closing: Option<String> = sqlx::query_scalar(
            "select coalesce(c.number, c.id::text) from e_pos_invoice p join e_pos_closing_entry c on c.tenant_id = p.tenant_id and c.id = p.pos_closing_entry \
             where p.tenant_id = $1 and p.consolidated_invoice = $2 limit 1",
        )
        .bind(hc.ctx.tenant)
        .bind(id(doc, "id"))
        .fetch_optional(&mut **hc.tx)
        .await?;
        match closing {
            Some(c) => Err(Error::invalid(format!("this invoice consolidates register sales; cancel POS closing {c} instead"))),
            None => Ok(()),
        }
    }
}

/// The sales invoices and credit notes a closing made: `(id, is_return)`.
async fn consolidated(hc: &mut HookCtx<'_>, closing: Uuid) -> Result<Vec<(Uuid, bool)>> {
    Ok(sqlx::query_as(
        "select s.id, coalesce(s.is_return, false) from e_sales_invoice s where s.tenant_id = $1 and s.docstatus = 1 and s.id in \
         (select consolidated_invoice from e_pos_invoice where tenant_id = $1 and pos_closing_entry = $2)",
    )
    .bind(hc.ctx.tenant)
    .bind(closing)
    .fetch_all(&mut **hc.tx)
    .await?)
}

#[derive(sqlx::FromRow)]
struct ItemLine {
    parent_id: Uuid,
    item: Uuid,
    qty: Option<Decimal>,
    net_amount: Option<Decimal>,
    income_account: Option<Uuid>,
    cost_center: Option<Uuid>,
    batch_no: Option<String>,
    serial_no: Option<String>,
}

#[derive(sqlx::FromRow)]
struct TaxLine {
    parent_id: Uuid,
    account: Uuid,
    cost_center: Option<Uuid>,
    description: Option<String>,
    tax_amount: Option<Decimal>,
    deduct: Option<bool>,
}

struct Made {
    id: Uuid,
    debit_to: Uuid,
}

async fn consolidate(hc: &mut HookCtx<'_>, closing: &Doc) -> Result<()> {
    let cid = id(closing, "id").ok_or_else(|| Error::internal("no id"))?;
    let sid = id(closing, "pos_opening_entry").ok_or_else(|| Error::field("pos_opening_entry", "is required"))?;
    let session = get(hc.kernel, hc.ctx, hc.tx, "PosOpeningEntry", sid).await?;
    let profile = Profile::load(hc.kernel, hc.ctx, hc.tx, id(&session, "pos_profile").unwrap_or_default()).await?;
    let co = company(hc.kernel, hc.ctx, hc.tx, id(closing, "company").unwrap_or_default()).await?;
    let on = date(closing, "posting_date")?;
    let takings = Takings::load(hc.tx, hc.ctx.tenant, sid, true).await?;
    let ids: Vec<Uuid> = takings.invoices.iter().map(|i| i.id).collect();
    let items: Vec<ItemLine> = sqlx::query_as(
        "select parent_id, item, qty, net_amount, income_account, cost_center, batch_no, serial_no from e_pos_invoice__items \
         where tenant_id = $1 and parent_id = any($2) order by parent_id, idx",
    )
    .bind(hc.ctx.tenant)
    .bind(&ids)
    .fetch_all(&mut **hc.tx)
    .await?;
    let taxes: Vec<TaxLine> = sqlx::query_as(
        "select parent_id, account, cost_center, description, tax_amount, deduct from e_pos_invoice__taxes where tenant_id = $1 and parent_id = any($2) \
         order by parent_id, idx",
    )
    .bind(hc.ctx.tenant)
    .bind(&ids)
    .fetch_all(&mut **hc.tx)
    .await?;
    let mut entry = Entry::new(co.id, on, "PosClosingEntry", cid, s(closing, "number").map(str::to_string));
    entry.memo = Some(format!("POS closing of session {}", s(&session, "number").unwrap_or_default()));
    let ctx = Consolidation { co: &co, closing, profile: &profile, items: &items, taxes: &taxes, pays: &takings.pays };
    let credit: HashSet<Uuid> = takings.pays.iter().filter(|p| p.kind == Kind::Credit && p.amount > Decimal::ZERO).map(|p| p.invoice).collect();

    // Paid sales per customer; a sale left on account by itself.
    let mut groups: Vec<((Uuid, Option<Uuid>), Vec<&Inv>)> = Vec::new();
    for inv in takings.invoices.iter().filter(|i| !i.is_return) {
        let key = (inv.customer, credit.contains(&inv.id).then_some(inv.id));
        match groups.iter_mut().find(|g| g.0 == key) {
            Some(g) => g.1.push(inv),
            None => groups.push((key, vec![inv])),
        }
    }
    let mut made_for: HashMap<Uuid, Uuid> = HashMap::new();
    let mut marks: Vec<(Uuid, Vec<Uuid>)> = Vec::new();
    for ((customer, _), group) in &groups {
        let m = ctx.make(hc, *customer, group, None).await?;
        ctx.settle(hc, &mut entry, cid, on, &m, *customer, group).await?;
        made_for.extend(group.iter().map(|i| (i.id, m.id)));
        marks.push((m.id, group.iter().map(|i| i.id).collect()));
    }
    // Returns per customer and the invoice that consolidated their sale.
    let mut returns: Vec<((Uuid, Uuid), Vec<&Inv>)> = Vec::new();
    for inv in takings.invoices.iter().filter(|i| i.is_return) {
        let orig = inv.return_against.ok_or_else(|| Error::internal("return without its sale"))?;
        let against = match made_for.get(&orig) {
            Some(si) => *si,
            None => {
                let found: Option<Uuid> = sqlx::query_scalar("select consolidated_invoice from e_pos_invoice where tenant_id = $1 and id = $2")
                    .bind(hc.ctx.tenant)
                    .bind(orig)
                    .fetch_optional(&mut **hc.tx)
                    .await?
                    .flatten();
                found.ok_or_else(|| {
                    Error::invalid(format!(
                        "return {} is against a sale whose session is still open; close that session first",
                        inv.number.clone().unwrap_or_default()
                    ))
                })?
            }
        };
        let key = (inv.customer, against);
        match returns.iter_mut().find(|g| g.0 == key) {
            Some(g) => g.1.push(inv),
            None => returns.push((key, vec![inv])),
        }
    }
    for ((customer, against), group) in &returns {
        let m = ctx.make(hc, *customer, group, Some(*against)).await?;
        ctx.settle(hc, &mut entry, cid, on, &m, *customer, group).await?;
        marks.push((m.id, group.iter().map(|i| i.id).collect()));
    }
    // What the count found missing or extra.
    let difference_account = id(&profile.doc, "cash_difference_account").map(Ok).unwrap_or_else(|| co.require("round_off_account", "round off account"))?;
    for r in rows(closing, "payments") {
        let diff = d(&r, "difference");
        if diff.is_zero() {
            continue;
        }
        let mode = Mode::load(hc.kernel, hc.ctx, hc.tx, id(&r, "mode_of_payment").unwrap_or_default()).await?;
        entry.lines.push(Line::new(mode.account(&co)?, diff, &co.currency_code).remarks(format!("{} counted at closing", mode.name)));
        entry.lines.push(Line::new(difference_account, -diff, &co.currency_code).remarks(if diff < Decimal::ZERO { "Cash shortage" } else { "Cash excess" }));
    }
    ledger::post(hc.tx, hc.ctx, entry, co.precision).await?;
    for (si, invoices) in marks {
        sqlx::query(
            "update e_pos_invoice set consolidated_invoice = $3, pos_closing_entry = $4, status = 'Consolidated', updated_at = now() \
             where tenant_id = $1 and id = any($2)",
        )
        .bind(hc.ctx.tenant)
        .bind(&invoices)
        .bind(si)
        .bind(cid)
        .execute(&mut **hc.tx)
        .await?;
    }
    let mut v = Doc::new();
    v.insert("status".into(), json!("Closed"));
    v.insert("pos_closing_entry".into(), json!(cid.to_string()));
    v.insert("period_end".into(), closing.get("period_end").cloned().unwrap_or(Value::Null));
    v.insert("open_key".into(), Value::Null);
    hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "PosOpeningEntry", sid, v).await
}

struct Consolidation<'a> {
    co: &'a Company,
    closing: &'a Doc,
    profile: &'a Profile,
    items: &'a [ItemLine],
    taxes: &'a [TaxLine],
    pays: &'a [Pay],
}

impl Consolidation<'_> {
    /// One sales invoice (or credit note, with `against`) for `group`, submitted, totalling
    /// exactly the group's POS invoices.
    async fn make(&self, hc: &mut HookCtx<'_>, customer: Uuid, group: &[&Inv], against: Option<Uuid>) -> Result<Made> {
        let co = self.co;
        let ids: HashSet<Uuid> = group.iter().map(|i| i.id).collect();
        // Lines merged per item, batch, income account and cost center.
        type Key = (Uuid, Option<String>, Option<Uuid>, Option<Uuid>);
        let mut merged: Vec<(Key, Decimal, Decimal, Vec<String>)> = Vec::new();
        for l in self.items.iter().filter(|l| ids.contains(&l.parent_id)) {
            let key = (l.item, l.batch_no.clone().filter(|b| !b.is_empty()), l.income_account, l.cost_center);
            let pos = match merged.iter().position(|m| m.0 == key) {
                Some(p) => p,
                None => {
                    merged.push((key, Decimal::ZERO, Decimal::ZERO, Vec::new()));
                    merged.len() - 1
                }
            };
            let m = &mut merged[pos];
            m.1 += l.qty.unwrap_or_default();
            m.2 += l.net_amount.unwrap_or_default();
            m.3.extend(ferrum_app_erp::stock::parse_serials(l.serial_no.as_deref()));
        }
        let strategy = match co.rounding {
            ferrum_calc::Rounding::HalfEven => RoundingStrategy::MidpointNearestEven,
            ferrum_calc::Rounding::HalfUp => RoundingStrategy::MidpointAwayFromZero,
        };
        let mut lines = Vec::new();
        for ((item, batch, income, cc), qty, net, serials) in merged {
            for (n, (q, price)) in logic::exact_lines(qty, net, co.precision, strategy).into_iter().enumerate() {
                // A zero price would be re-read from the price list: free goods go at 100% off.
                let (price, discount) = if price.is_zero() { (Decimal::ONE, Decimal::ONE_HUNDRED) } else { (price, Decimal::ZERO) };
                lines.push(json!({
                    "item": item.to_string(), "qty": q.to_string(), "price_list_rate": price.to_string(), "discount_percent": discount.to_string(),
                    "income_account": income.map(|a| a.to_string()), "cost_center": cc.map(|c| c.to_string()), "batch_no": batch,
                    "serial_no": (n == 0 && !serials.is_empty()).then(|| serials.join("\n")),
                }));
            }
        }
        // Taxes as the fixed amounts the register charged, per account; cash rounding the same way.
        let mut tax_rows: Vec<((Uuid, Option<Uuid>, bool), String, Decimal)> = Vec::new();
        for t in self.taxes.iter().filter(|t| ids.contains(&t.parent_id)) {
            let key = (t.account, t.cost_center, t.deduct.unwrap_or(false));
            match tax_rows.iter_mut().find(|r| r.0 == key) {
                Some(r) => r.2 += t.tax_amount.unwrap_or_default(),
                None => tax_rows.push((key, t.description.clone().unwrap_or_else(|| "Tax".into()), t.tax_amount.unwrap_or_default())),
            }
        }
        let rounding: Decimal = group.iter().map(|i| i.rounding_adjustment.unwrap_or_default()).sum();
        if !rounding.is_zero() {
            tax_rows.push(((co.require("round_off_account", "round off account")?, None, false), "Cash rounding at the register".into(), rounding));
        }
        let taxes: Vec<Value> = tax_rows
            .into_iter()
            .map(|((account, cc, deduct), description, amount)| {
                json!({"charge_type": "Actual", "account": account.to_string(), "cost_center": cc.map(|c| c.to_string()), "deduct": deduct,
                       "description": description, "amount": amount.to_string()})
            })
            .collect();
        let numbers: Vec<String> = group.iter().filter_map(|i| i.number.clone()).collect();
        let shown =
            if numbers.len() > 20 { format!("{} … {}", numbers[..10].join(", "), numbers[numbers.len() - 5..].join(", ")) } else { numbers.join(", ") };
        let input = json!({
            "company": co.id.to_string(), "customer": customer.to_string(), "posting_date": self.closing.get("posting_date"),
            "currency": co.currency_id.to_string(), "conversion_rate": "1", "update_stock": false,
            "is_return": against.is_some(), "return_against": against.map(|a| a.to_string()),
            "tax_template": group.iter().find_map(|i| i.tax_template).map(|t| t.to_string()),
            "cost_center": self.profile.doc.get("cost_center"),
            "items": lines, "taxes": taxes,
            "remarks": format!("Consolidated at POS closing {} from {} register invoice(s): {shown}", s(self.closing, "number").unwrap_or_default(), group.len()),
        });
        let sctx = elevated(hc.ctx);
        let input = input.as_object().cloned().unwrap_or_default();
        let draft = hc.kernel.insert_tx(&sctx, hc.tx, "SalesInvoice", input).await?;
        let si = id(&draft, "id").ok_or_else(|| Error::internal("no id"))?;
        let si_doc = hc.kernel.submit_tx(&sctx, hc.tx, "SalesInvoice", si, None).await?;
        let expected: Decimal = group.iter().map(|i| i.total()).sum();
        if d(&si_doc, "rounded_total") != expected {
            return Err(Error::invalid(format!(
                "consolidated invoice {} came to {} but its register invoices total {}; check the company's rounding step and the tax templates",
                s(&si_doc, "number").unwrap_or_default(),
                d(&si_doc, "rounded_total").normalize(),
                expected.normalize()
            )));
        }
        Ok(Made { id: si, debit_to: id(&si_doc, "debit_to").ok_or_else(|| Error::internal("sales invoice without receivable account"))? })
    }

    /// Settles a consolidated invoice from its POS payments: each money mode (and redeemed
    /// points) debited, write-offs debited, the receivable credited and allocated. What was sold
    /// on account stays open on the invoice.
    #[allow(clippy::too_many_arguments)]
    async fn settle(
        &self,
        hc: &mut HookCtx<'_>,
        entry: &mut Entry,
        closing: Uuid,
        on: chrono::NaiveDate,
        m: &Made,
        customer: Uuid,
        group: &[&Inv],
    ) -> Result<()> {
        let co = self.co;
        let ids: HashSet<Uuid> = group.iter().map(|i| i.id).collect();
        let mut settled = Decimal::ZERO;
        for p in self.pays.iter().filter(|p| ids.contains(&p.invoice) && p.kind != Kind::Credit && !p.amount.is_zero()) {
            let account = p.account.ok_or_else(|| Error::internal("a POS payment has no account"))?;
            entry.lines.push(Line::new(account, p.amount, &co.currency_code));
            settled += p.amount;
        }
        let write_off: Decimal = group.iter().map(|i| i.write_off_amount.unwrap_or_default()).sum();
        if !write_off.is_zero() {
            let account = id(&self.profile.doc, "write_off_account").map(Ok).unwrap_or_else(|| co.require("round_off_account", "round off account"))?;
            entry.lines.push(
                Line::new(account, write_off, &co.currency_code)
                    .cost_center(id(&self.profile.doc, "write_off_cost_center"))
                    .remarks("Written off at the register"),
            );
            settled += write_off;
        }
        if settled.is_zero() {
            return Ok(());
        }
        ledger::allocate(hc.tx, hc.ctx, co.id, m.id, "PosClosingEntry", closing, on, settled, settled).await?;
        entry.lines.push(Line::new(m.debit_to, -settled, &co.currency_code).customer(Some(customer)).against("SalesInvoice", m.id));
        sync_invoice_outstanding(hc.kernel, hc.ctx, hc.tx, "SalesInvoice", m.id).await
    }
}
