//! Loyalty points: earned on sales at the customer's tier, redeemed as a payment method, taken
//! back by returns and cancellations, expired by `maintenance`.
//!
//! The ledger is `LoyaltyPointEntry`. Each earning keeps its unused `remaining`, which
//! redemptions consume soonest-expiring first, so expiry removes exactly the points never used.
//! Redeemed points reach the books at closing (the program's expense account is their payment
//! account); earning has no accounting effect.

use crate::logic::{self, Kind};
use chrono::{Duration, NaiveDate};
use ferrum_domain::util::{b, d, date, elevated, find, get, id, rows, s};
use ferrum_kernel::{Ctx, Doc, Error, Filter, HookCtx, Kernel, Result, Tx};
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub(crate) struct Program {
    pub id: Uuid,
    pub conversion_factor: Decimal,
    pub expiry_days: i64,
    pub expense_account: Option<Uuid>,
    pub tiers: Vec<(Decimal, Decimal)>,
}

impl Program {
    fn from_doc(doc: &Doc) -> Result<Program> {
        Ok(Program {
            id: id(doc, "id").ok_or_else(|| Error::internal("loyalty program without id"))?,
            conversion_factor: d(doc, "conversion_factor"),
            expiry_days: doc.get("expiry_days").and_then(Value::as_i64).unwrap_or(0),
            expense_account: id(doc, "expense_account"),
            tiers: rows(doc, "tiers").iter().map(|t| (d(t, "min_spent"), d(t, "collection_factor"))).collect(),
        })
    }

    pub async fn load(k: &Kernel, ctx: &Ctx, tx: &mut Tx, program: Uuid) -> Result<Program> {
        Program::from_doc(&get(k, ctx, tx, "LoyaltyProgram", program).await?)
    }

    fn expiry(&self, from: NaiveDate) -> Value {
        if self.expiry_days > 0 { json!((from + Duration::days(self.expiry_days)).to_string()) } else { Value::Null }
    }
}

/// The program a customer collects in: the company's first enabled program, valid on `on`,
/// whose customer groups include the customer's (no groups = everyone). The register's walk-in
/// customer never collects.
pub(crate) async fn program_for(hc: &mut HookCtx<'_>, company: Uuid, customer: Uuid, on: NaiveDate) -> Result<Option<Program>> {
    let cust = get(hc.kernel, hc.ctx, hc.tx, "Customer", customer).await?;
    let group = id(&cust, "customer_group");
    let day = on.to_string();
    let candidates = find(
        hc.kernel,
        hc.ctx,
        hc.tx,
        "LoyaltyProgram",
        vec![Filter::eq("company", company.to_string()), Filter::eq("disabled", false)],
        Some("created_at asc"),
        50,
    )
    .await?;
    for c in candidates {
        if s(&c, "from_date").is_some_and(|f| f > day.as_str()) || s(&c, "to_date").is_some_and(|t| t < day.as_str()) {
            continue;
        }
        let full = get(hc.kernel, hc.ctx, hc.tx, "LoyaltyProgram", id(&c, "id").unwrap_or_default()).await?;
        let groups = rows(&full, "customer_groups");
        if groups.is_empty() || groups.iter().any(|g| id(g, "customer_group") == group) {
            return Ok(Some(Program::from_doc(&full)?));
        }
    }
    Ok(None)
}

/// Points a customer can redeem on `on`: everything posted, less earnings past their expiry
/// date that `maintenance` has not expired yet.
pub(crate) async fn available(tx: &mut Tx, tenant: Uuid, program: Uuid, customer: Uuid, on: NaiveDate) -> Result<i64> {
    let v: Decimal = sqlx::query_scalar(
        "select coalesce(sum(points), 0) - coalesce(sum(remaining) filter (where expiry_date < $4), 0) from e_loyalty_point_entry \
         where tenant_id = $1 and loyalty_program = $2 and customer = $3",
    )
    .bind(tenant)
    .bind(program)
    .bind(customer)
    .bind(on)
    .fetch_one(&mut **tx)
    .await?;
    Ok(v.to_i64().unwrap_or(0))
}

/// Takes `points` from the customer's earnings, soonest expiry first. A shortfall (points
/// already spent before a sale is cancelled) leaves the balance negative until new earnings.
async fn consume(hc: &mut HookCtx<'_>, program: Uuid, customer: Uuid, mut points: i64) -> Result<()> {
    if points <= 0 {
        return Ok(());
    }
    let open: Vec<(Uuid, i64)> = sqlx::query_as(
        "select id, remaining from e_loyalty_point_entry where tenant_id = $1 and loyalty_program = $2 and customer = $3 and remaining > 0 \
         order by expiry_date nulls last, posting_date, created_at for update",
    )
    .bind(hc.ctx.tenant)
    .bind(program)
    .bind(customer)
    .fetch_all(&mut **hc.tx)
    .await?;
    for (entry, remaining) in open {
        let take = points.min(remaining);
        sqlx::query("update e_loyalty_point_entry set remaining = remaining - $3, updated_at = now() where tenant_id = $1 and id = $2")
            .bind(hc.ctx.tenant)
            .bind(entry)
            .bind(take)
            .execute(&mut **hc.tx)
            .await?;
        points -= take;
        if points == 0 {
            break;
        }
    }
    Ok(())
}

struct Posting<'a> {
    program: &'a Program,
    invoice: &'a Doc,
    entry_type: &'a str,
    points: i64,
    purchase: Decimal,
    /// New points stay redeemable (and expire) like earnings.
    credit: bool,
}

async fn post(hc: &mut HookCtx<'_>, p: Posting<'_>) -> Result<()> {
    let on = date(p.invoice, "posting_date")?;
    let mut e = Doc::new();
    e.insert("loyalty_program".into(), json!(p.program.id.to_string()));
    e.insert("customer".into(), p.invoice.get("customer").cloned().unwrap_or(Value::Null));
    e.insert("company".into(), p.invoice.get("company").cloned().unwrap_or(Value::Null));
    e.insert("entry_type".into(), json!(p.entry_type));
    e.insert("points".into(), json!(p.points));
    e.insert("remaining".into(), json!(if p.credit { p.points.max(0) } else { 0 }));
    e.insert("purchase_amount".into(), json!(p.purchase.to_string()));
    e.insert("posting_date".into(), json!(on.to_string()));
    e.insert("expiry_date".into(), if p.credit && p.points > 0 { p.program.expiry(on) } else { Value::Null });
    e.insert("pos_invoice".into(), p.invoice.get("id").cloned().unwrap_or(Value::Null));
    hc.kernel.insert_tx(&elevated(hc.ctx), hc.tx, "LoyaltyPointEntry", e).await?;
    Ok(())
}

/// Value and points of the invoice's loyalty payment rows (both positive).
fn loyalty_paid(invoice: &Doc) -> (Decimal, i64) {
    rows(invoice, "payments")
        .iter()
        .filter(|p| s(p, "mode_type").and_then(Kind::parse) == Some(Kind::Loyalty))
        .fold((Decimal::ZERO, 0), |(v, n), p| (v + d(p, "amount").abs(), n + p.get("loyalty_points").and_then(Value::as_i64).unwrap_or(0)))
}

/// Posts the points of a submitted sale or return; returns the points earned.
pub(crate) async fn on_submit(hc: &mut HookCtx<'_>, invoice: &Doc) -> Result<i64> {
    let Some(pid) = id(invoice, "loyalty_program") else { return Ok(0) };
    let customer = id(invoice, "customer").ok_or_else(|| Error::field("customer", "is required"))?;
    let program = Program::load(hc.kernel, hc.ctx, hc.tx, pid).await?;
    let (paid_value, paid_points) = loyalty_paid(invoice);
    if !b(invoice, "is_return") {
        if paid_points > 0 {
            consume(hc, program.id, customer, paid_points).await?;
            post(hc, Posting { program: &program, invoice, entry_type: "Redeem", points: -paid_points, purchase: Decimal::ZERO, credit: false }).await?;
        }
        // Points are earned on what the customer paid for, not on what points paid for.
        let eligible = d(invoice, "rounded_total") - paid_value;
        let spent: Decimal = sqlx::query_scalar(
            "select coalesce(sum(purchase_amount), 0) from e_loyalty_point_entry where tenant_id = $1 and loyalty_program = $2 and customer = $3",
        )
        .bind(hc.ctx.tenant)
        .bind(program.id)
        .bind(customer)
        .fetch_one(&mut **hc.tx)
        .await?;
        let earned = logic::tier_factor(spent, &program.tiers).map(|f| logic::points_earned(eligible, f)).unwrap_or(0);
        if earned != 0 || !eligible.is_zero() {
            post(hc, Posting { program: &program, invoice, entry_type: "Earn", points: earned, purchase: eligible, credit: true }).await?;
        }
        return Ok(earned);
    }
    // A return takes back its share of what the sale earned and gives back points it refunds.
    let original = id(invoice, "return_against").ok_or_else(|| Error::field("return_against", "is required"))?;
    let earning: Option<(i64, Option<Decimal>)> =
        sqlx::query_as("select points, purchase_amount from e_loyalty_point_entry where tenant_id = $1 and pos_invoice = $2 and entry_type = 'Earn' limit 1")
            .bind(hc.ctx.tenant)
            .bind(original)
            .fetch_optional(&mut **hc.tx)
            .await?;
    let (returned_before, reversed_before): (Decimal, Decimal) = sqlx::query_as(
        "select coalesce(sum(-e.purchase_amount), 0), coalesce(sum(-e.points) filter (where e.points < 0), 0) from e_loyalty_point_entry e \
         join e_pos_invoice r on r.tenant_id = e.tenant_id and r.id = e.pos_invoice \
         where e.tenant_id = $1 and e.entry_type = 'Return' and r.return_against = $2 and r.docstatus = 1 and r.id <> $3",
    )
    .bind(hc.ctx.tenant)
    .bind(original)
    .bind(id(invoice, "id"))
    .fetch_one(&mut **hc.tx)
    .await?;
    let returned = -d(invoice, "rounded_total") - paid_value;
    if let Some((earned, eligible)) = earning {
        let back = logic::points_to_reverse(earned, eligible.unwrap_or_default(), returned_before + returned, reversed_before.to_i64().unwrap_or(0));
        consume(hc, program.id, customer, back).await?;
        post(hc, Posting { program: &program, invoice, entry_type: "Return", points: -back, purchase: -returned, credit: false }).await?;
    }
    if paid_points > 0 {
        post(hc, Posting { program: &program, invoice, entry_type: "Return", points: paid_points, purchase: Decimal::ZERO, credit: true }).await?;
    }
    Ok(0)
}

/// Undoes every points posting of a cancelled invoice.
pub(crate) async fn on_cancel(hc: &mut HookCtx<'_>, invoice: &Doc) -> Result<()> {
    let entries: Vec<(Uuid, Uuid, Uuid, i64, i64, Option<Decimal>)> = sqlx::query_as(
        "select id, loyalty_program, customer, points, remaining, purchase_amount from e_loyalty_point_entry \
         where tenant_id = $1 and pos_invoice = $2 and entry_type <> 'Cancel' order by created_at",
    )
    .bind(hc.ctx.tenant)
    .bind(id(invoice, "id"))
    .fetch_all(&mut **hc.tx)
    .await?;
    for (entry, pid, customer, points, remaining, purchase) in entries {
        let program = Program::load(hc.kernel, hc.ctx, hc.tx, pid).await?;
        if points > 0 {
            // What is still unused goes with the entry; what was spent comes from other earnings.
            sqlx::query("update e_loyalty_point_entry set remaining = 0, updated_at = now() where tenant_id = $1 and id = $2")
                .bind(hc.ctx.tenant)
                .bind(entry)
                .execute(&mut **hc.tx)
                .await?;
            consume(hc, pid, customer, points - remaining).await?;
        }
        post(hc, Posting { program: &program, invoice, entry_type: "Cancel", points: -points, purchase: -purchase.unwrap_or_default(), credit: points < 0 })
            .await?;
    }
    Ok(())
}

/// Expires earnings past their date (idempotent: an expired earning has nothing remaining).
pub(crate) async fn expire_points(k: &Kernel) -> Result<()> {
    let mut sys = k.db.system_tx().await?;
    let tenants: Vec<Uuid> =
        sqlx::query_scalar("select t.id from tenant t join installed_package p on p.tenant_id = t.id and p.name = 'pos' where t.status = 'active'")
            .fetch_all(&mut *sys)
            .await?;
    sys.commit().await?;
    for tenant in tenants {
        let schema = k.registry.schema(tenant).await?;
        if schema.entity("LoyaltyPointEntry").is_none() {
            continue;
        }
        let ctx = Ctx::system(tenant, schema);
        let mut tx = k.db.tenant_tx(tenant).await?;
        // Served by the partial index on live earnings (sql/001_loyalty.sql): only what is due is read.
        let due: Vec<(Uuid, Uuid, Uuid, Uuid, i64, NaiveDate)> = sqlx::query_as(
            "select id, loyalty_program, customer, company, remaining, expiry_date from e_loyalty_point_entry \
             where tenant_id = $1 and expiry_date < current_date and remaining > 0 order by expiry_date limit 500 for update skip locked",
        )
        .bind(tenant)
        .fetch_all(&mut *tx)
        .await?;
        for (entry, program, customer, company, remaining, expiry) in &due {
            sqlx::query("update e_loyalty_point_entry set remaining = 0, updated_at = now() where tenant_id = $1 and id = $2")
                .bind(tenant)
                .bind(entry)
                .execute(&mut *tx)
                .await?;
            let mut e = Doc::new();
            e.insert("loyalty_program".into(), json!(program.to_string()));
            e.insert("customer".into(), json!(customer.to_string()));
            e.insert("company".into(), json!(company.to_string()));
            e.insert("entry_type".into(), json!("Expire"));
            e.insert("points".into(), json!(-remaining));
            e.insert("remaining".into(), json!(0));
            e.insert("posting_date".into(), json!((*expiry + Duration::days(1)).to_string()));
            k.insert_tx(&ctx, &mut tx, "LoyaltyPointEntry", e).await?;
        }
        tx.commit().await?;
        if !due.is_empty() {
            tracing::info!(%tenant, entries = due.len(), "loyalty points expired");
        }
    }
    Ok(())
}

/// Money value of points in the document currency, for the payment row.
pub(crate) fn value_of(program: &Program, points: i64, precision: u32) -> Decimal {
    logic::points_value(points, program.conversion_factor, precision)
}

/// The points a payment row redeems.
pub(crate) fn row_points(row: &Doc) -> i64 {
    row.get("loyalty_points").and_then(Value::as_i64).unwrap_or(0).max(0)
}
