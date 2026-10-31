//! POS invoices: the fast path at the register.
//!
//! A sale is priced like any sales document (price list, pricing rules, taxes and cash rounding
//! through `pricing::calculate`, with the countries' rules such as India's GST templates), held
//! to the register's rules (open session, discount and price limits, payment methods), and on
//! submit takes its stock out of the register's warehouse at once, with the valuation entry a
//! delivery note makes, so stock and the stock accounts always agree. Revenue, taxes,
//! receivables and payments reach the books when the session closes (`closing`).
//!
//! Returns copy the prices, discounts and taxes of the sale they reverse, cannot bring back
//! more than each line sold, and refund through what the sale was paid with.

use crate::logic::{self, Kind, Refundable, Tender};
use crate::loyalty::{self, Program};
use crate::{Mode, Profile, is_manager, live_session, open_session, opt_dec, rows_value};
use async_trait::async_trait;
use ferrum_app_erp::ledger::{self, Entry, Line};
use ferrum_app_erp::pricing::{Side, calculate};
use ferrum_app_erp::stock::{self, MoveIn, parse_serials};
use ferrum_domain::util::{Company, b, company, d, date, get, id, money, posting_ts, rows, s, set, sys};
use ferrum_kernel::{Doc, DocHook, Error, FieldError, HookCtx, Result};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub struct PosInvoiceHook;

fn kind_of(row: &Doc) -> Option<Kind> {
    s(row, "mode_type").and_then(Kind::parse)
}

fn tenders(payments: &[Doc], sign: Decimal) -> Vec<Tender> {
    payments.iter().map(|p| Tender { kind: kind_of(p).unwrap_or(Kind::General), amount: sign * d(p, "amount") }).collect()
}

fn credit_of(doc: &Doc) -> Decimal {
    rows(doc, "payments").iter().filter(|p| kind_of(p) == Some(Kind::Credit)).map(|p| d(p, "amount")).sum()
}

/// The current UTC time of day, for sales the client did not time.
fn now_time() -> String {
    chrono::Utc::now().format("%H:%M:%S").to_string()
}

#[async_trait]
impl DocHook for PosInvoiceHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        let pid = id(doc, "pos_profile").ok_or_else(|| Error::field("pos_profile", "is required"))?;
        let profile = Profile::load(hc.kernel, hc.ctx, hc.tx, pid).await?;
        let email = hc.ctx.email.clone();
        if id(doc, "pos_opening_entry").is_none()
            && let Some(sid) = open_session(hc, pid, &email).await?
        {
            set(doc, "pos_opening_entry", sid.to_string());
        }
        if let Some(sid) = id(doc, "pos_opening_entry") {
            let session = get(hc.kernel, hc.ctx, hc.tx, "PosOpeningEntry", sid).await?;
            set(doc, "cashier", session.get("user").cloned().unwrap_or(Value::Null));
        }
        let co = company(hc.kernel, hc.ctx, hc.tx, id(doc, "company").ok_or_else(|| Error::field("company", "is required"))?).await?;
        // The register sells in the company currency, from its own warehouse.
        set(doc, "currency", co.currency_id.to_string());
        set(doc, "conversion_rate", money(Decimal::ONE));
        set(doc, "set_warehouse", profile.warehouse.to_string());
        set(doc, "cost_center", profile.doc.get("cost_center").cloned().unwrap_or(Value::Null));
        if s(doc, "posting_time").is_none() {
            set(doc, "posting_time", now_time());
        }
        if b(doc, "is_return") {
            prepare_return(hc, doc, &profile).await?;
        } else {
            if id(doc, "customer").is_none()
                && let Some(c) = id(&profile.doc, "customer")
            {
                let cust = get(hc.kernel, hc.ctx, hc.tx, "Customer", c).await?;
                set(doc, "customer", c.to_string());
                set(doc, "customer_name", cust.get("customer_name").cloned().unwrap_or(Value::Null));
            }
            if let Some(pl) = id(&profile.doc, "price_list") {
                set(doc, "price_list", pl.to_string());
            }
            if id(doc, "tax_template").is_none()
                && let Some(t) = id(&profile.doc, "tax_template")
            {
                set(doc, "tax_template", t.to_string());
            }
            // Taxes as on sales invoices (the countries' rules run inside `calculate`), so the
            // consolidated invoice lands on the same ones.
            price_sale(hc, doc, &profile).await?;
            let walk_in = id(&profile.doc, "customer");
            let program = match id(doc, "customer").filter(|c| Some(*c) != walk_in) {
                Some(c) => loyalty::program_for(hc, co.id, c, date(doc, "posting_date")?).await?,
                None => None,
            };
            set(doc, "loyalty_program", program.map(|p| json!(p.id.to_string())).unwrap_or(Value::Null));
        }
        derive_payments(hc, doc, &profile, &co).await?;
        if d(doc, "docstatus").is_zero() {
            set(doc, "status", "Draft");
        }
        Ok(())
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let profile = Profile::load(hc.kernel, hc.ctx, hc.tx, id(doc, "pos_profile").unwrap_or_default()).await?;
        if b(&profile.doc, "disabled") {
            return Err(Error::field("pos_profile", "this register is disabled"));
        }
        let sid = id(doc, "pos_opening_entry").ok_or_else(|| Error::field("pos_opening_entry", "open a session at this register first"))?;
        let session = live_session(hc, sid, false).await?;
        if id(&session, "pos_profile") != Some(profile.id) {
            return Err(Error::field("pos_opening_entry", "this session belongs to another register"));
        }
        let cashier = s(&session, "user").unwrap_or_default();
        if !cashier.eq_ignore_ascii_case(&hc.ctx.email) && !is_manager(hc.ctx) {
            return Err(Error::Forbidden(format!("this is {cashier}'s session; sell in your own session")));
        }
        let mut errors = Vec::new();
        let day = date(doc, "posting_date")?;
        let opened = date(&session, "posting_date")?;
        let today = chrono::Utc::now().date_naive();
        // Offline devices send their own date; it must fall inside the session (one day of clock slack).
        if day < opened || day > today + chrono::Duration::days(1) {
            errors.push(FieldError::new("posting_date", format!("must be within the session, from {opened} to today")));
        }
        let ret = b(doc, "is_return");
        let walk_in = id(&profile.doc, "customer");
        match id(doc, "customer") {
            None => errors.push(FieldError::new("customer", "choose a customer (the register has no default customer)")),
            Some(c) if Some(c) != walk_in && !rows(&profile.doc, "customer_groups").is_empty() => {
                let cust = get(hc.kernel, hc.ctx, hc.tx, "Customer", c).await?;
                if !rows(&profile.doc, "customer_groups").iter().any(|g| id(g, "customer_group") == id(&cust, "customer_group")) {
                    errors.push(FieldError::new("customer", "this register does not sell to the customer's group"));
                }
            }
            _ => {}
        }
        for (i, r) in rows(doc, "items").iter().enumerate() {
            let q = d(r, "qty");
            if q.is_zero() || (ret && q > Decimal::ZERO) || (!ret && q < Decimal::ZERO) {
                errors.push(FieldError::new("qty", if ret { "returned quantities are negative" } else { "quantity must be positive" }).in_row("items", i));
            }
        }
        for (i, p) in rows(doc, "payments").iter().enumerate() {
            let Some((mode, in_returns)) = id(p, "mode_of_payment").and_then(|m| profile.mode(m)) else {
                errors.push(FieldError::new("mode_of_payment", "not a payment method of this register").in_row("payments", i));
                continue;
            };
            if ret && !in_returns {
                errors.push(FieldError::new("mode_of_payment", format!("{} cannot refund returns at this register", mode.name)).in_row("payments", i));
            }
            if matches!(mode.kind, Kind::Credit | Kind::Loyalty) && id(doc, "customer") == walk_in {
                errors
                    .push(FieldError::new("mode_of_payment", format!("{} needs a named customer, not the walk-in customer", mode.name)).in_row("payments", i));
            }
            if mode.kind == Kind::Loyalty && id(doc, "loyalty_program").is_none() {
                errors.push(FieldError::new("mode_of_payment", "the customer is not in a loyalty program").in_row("payments", i));
            }
        }
        if errors.is_empty() { Ok(()) } else { Err(Error::Validation(errors)) }
    }

    async fn before_submit(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        // Under the session lock: the closing cannot run between this check and the commit.
        live_session(hc, id(doc, "pos_opening_entry").unwrap_or_default(), true).await?;
        let profile = Profile::load(hc.kernel, hc.ctx, hc.tx, id(doc, "pos_profile").unwrap_or_default()).await?;
        let co = company(hc.kernel, hc.ctx, hc.tx, id(doc, "company").unwrap_or_default()).await?;
        let program = match id(doc, "loyalty_program") {
            Some(p) => Some(Program::load(hc.kernel, hc.ctx, hc.tx, p).await?),
            None => None,
        };
        // The settlement account of every payment is fixed now, so the closing posts what the cashier saw.
        let mut payments = rows(doc, "payments");
        for p in payments.iter_mut() {
            let mode = Mode::load(hc.kernel, hc.ctx, hc.tx, id(p, "mode_of_payment").unwrap_or_default()).await?;
            let account = match mode.kind {
                Kind::Credit => None,
                Kind::Loyalty => program.as_ref().and_then(|pr| pr.expense_account),
                _ => Some(mode.account(&co)?),
            };
            set(p, "account", account.map(|a| json!(a.to_string())).unwrap_or(Value::Null));
        }
        set(doc, "payments", rows_value(payments.clone()));
        if b(doc, "is_return") {
            return check_return(hc, doc, &payments).await;
        }
        let total = d(doc, "rounded_total");
        let st = logic::settle_sale(total, &tenders(&payments, Decimal::ONE), d(&profile.doc, "write_off_limit")).map_err(|m| Error::field("payments", m))?;
        set(doc, "paid_amount", money(st.paid));
        set(doc, "change_amount", money(st.change));
        set(doc, "write_off_amount", money(st.write_off));
        check_credit_limit(hc, doc).await?;
        let redeemed: i64 = payments.iter().filter(|p| kind_of(p) == Some(Kind::Loyalty)).map(loyalty::row_points).sum();
        if redeemed > 0 {
            let (Some(program), Some(customer)) = (program.as_ref(), id(doc, "customer")) else {
                return Err(Error::field("payments", "the customer is not in a loyalty program"));
            };
            // One redemption at a time per customer, across registers.
            hc.kernel.get_tx(&sys(hc.ctx), hc.tx, "Customer", customer, true).await?;
            let have = loyalty::available(hc.tx, hc.ctx.tenant, program.id, customer, date(doc, "posting_date")?).await?;
            if redeemed > have {
                return Err(Error::field("payments", format!("the customer has {have} points, not {redeemed}")));
            }
        }
        // A country's checks, as on sales invoices (India: HSN/SAC codes).
        ferrum_app_erp::localization::check(hc, doc, Side::Selling).await
    }

    async fn on_submit(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let iid = id(doc, "id").ok_or_else(|| Error::internal("no id"))?;
        let profile = Profile::load(hc.kernel, hc.ctx, hc.tx, id(doc, "pos_profile").unwrap_or_default()).await?;
        let mut co = company(hc.kernel, hc.ctx, hc.tx, id(doc, "company").unwrap_or_default()).await?;
        co.allow_negative_stock |= b(&profile.doc, "allow_negative_stock");
        post_stock(hc, doc, &co).await?;
        let earned = loyalty::on_submit(hc, doc).await?;
        let status = if b(doc, "is_return") {
            "Return"
        } else if credit_of(doc) > Decimal::ZERO {
            "Unpaid"
        } else {
            "Paid"
        };
        let mut v = Doc::new();
        v.insert("status".into(), json!(status));
        v.insert("loyalty_points_earned".into(), json!(earned));
        hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "PosInvoice", iid, v).await
    }

    async fn before_cancel(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        if let Some(si) = id(doc, "consolidated_invoice") {
            let inv = get(hc.kernel, hc.ctx, hc.tx, "SalesInvoice", si).await?;
            return Err(Error::invalid(format!(
                "this sale was consolidated into sales invoice {} when its session closed; make a return instead",
                s(&inv, "number").unwrap_or_default()
            )));
        }
        live_session(hc, id(doc, "pos_opening_entry").unwrap_or_default(), true).await?;
        let returned: Option<String> =
            sqlx::query_scalar("select coalesce(number, id::text) from e_pos_invoice where tenant_id = $1 and return_against = $2 and docstatus = 1 limit 1")
                .bind(hc.ctx.tenant)
                .bind(id(doc, "id"))
                .fetch_optional(&mut **hc.tx)
                .await?;
        if let Some(r) = returned {
            return Err(Error::invalid(format!("return {r} was made against this sale; cancel it first")));
        }
        Ok(())
    }

    async fn on_cancel(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let iid = id(doc, "id").ok_or_else(|| Error::internal("no id"))?;
        let profile = Profile::load(hc.kernel, hc.ctx, hc.tx, id(doc, "pos_profile").unwrap_or_default()).await?;
        let mut co = company(hc.kernel, hc.ctx, hc.tx, id(doc, "company").unwrap_or_default()).await?;
        co.allow_negative_stock |= b(&profile.doc, "allow_negative_stock");
        let (on, ts) = ledger::reversal_point(hc.tx, hc.ctx.tenant, co.id, doc).await?;
        stock::reverse_moves(hc.tx, hc.ctx, &co, "PosInvoice", iid, on, ts).await?;
        ledger::reverse(hc.tx, hc.ctx, "PosInvoice", iid, on, co.precision).await?;
        loyalty::on_cancel(hc, doc).await?;
        let mut v = Doc::new();
        v.insert("status".into(), json!("Cancelled"));
        hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "PosInvoice", iid, v).await
    }
}

/// Prices a sale. The first pass learns each line's list price and pricing-rule discount; the
/// cashier's own price or discount then replaces them when the register allows it (a POS
/// manager may always), and a second pass computes the totals with them.
async fn price_sale(hc: &mut HookCtx<'_>, doc: &mut Doc, profile: &Profile) -> Result<()> {
    let mut items = rows(doc, "items");
    let asked: Vec<(Option<Decimal>, Option<Decimal>)> =
        items.iter().map(|r| (opt_dec(r, "discount_percent"), opt_dec(r, "manual_rate").filter(|m| *m > Decimal::ZERO))).collect();
    for r in items.iter_mut() {
        r.insert("price_list_rate".into(), Value::Null);
        r.insert("discount_percent".into(), Value::Null);
        set(r, "warehouse", profile.warehouse.to_string());
    }
    set(doc, "items", rows_value(items));
    calculate(hc.kernel, hc.ctx, hc.tx, hc.entity, doc, Side::Selling).await?;

    let manager = is_manager(hc.ctx);
    let allow_discount = b(&profile.doc, "allow_discount_change");
    let allow_rate = b(&profile.doc, "allow_rate_change");
    let max_discount = if allow_discount { d(&profile.doc, "max_discount") } else { Decimal::ZERO };
    let header = d(doc, "discount_percent");
    let hundred = Decimal::ONE_HUNDRED;
    let mut items = rows(doc, "items");
    let mut errors = Vec::new();
    let mut again = false;
    for (i, r) in items.iter_mut().enumerate() {
        let (list, rule) = (d(r, "price_list_rate"), d(r, "discount_percent"));
        let (ask_discount, ask_rate) = asked[i];
        let price = ask_rate.unwrap_or(list);
        let discount = ask_discount.unwrap_or(rule);
        let name = s(r, "item_name").unwrap_or("this item").to_string();
        if price <= Decimal::ZERO {
            errors.push(FieldError::new("manual_rate", format!("{name} has no price in the price list; type its price")).in_row("items", i));
            continue;
        }
        if !manager {
            if ask_rate.is_some_and(|m| m != list) && !allow_rate {
                errors.push(FieldError::new("manual_rate", "this register does not allow changing prices; ask a POS manager").in_row("items", i));
            }
            if (discount > rule || header > Decimal::ZERO) && !allow_discount {
                errors.push(FieldError::new("discount_percent", "this register does not allow discounts; ask a POS manager").in_row("items", i));
            } else if list > Decimal::ZERO {
                // What the customer saves against the list price: typed price, line and invoice discount together.
                let pays = price / list * (hundred - discount) / hundred * (hundred - header) / hundred;
                let saving = ((Decimal::ONE - pays) * hundred).round_dp(4);
                let limit = rule.max(max_discount);
                if saving > limit {
                    errors.push(
                        FieldError::new(
                            "discount_percent",
                            format!("a {}% discount on {name} exceeds the {}% allowed; ask a POS manager", saving.normalize(), limit.normalize()),
                        )
                        .in_row("items", i),
                    );
                }
            }
        }
        again |= price != list || discount != rule;
        set(r, "price_list_rate", money(price));
        set(r, "discount_percent", money(discount));
    }
    if !errors.is_empty() {
        return Err(Error::Validation(errors));
    }
    if again {
        set(doc, "items", rows_value(items));
        calculate(hc.kernel, hc.ctx, hc.tx, hc.entity, doc, Side::Selling).await?;
    }
    Ok(())
}

/// Quantity of each original line already returned by other submitted returns.
async fn returned_so_far(hc: &mut HookCtx<'_>, original: Uuid, this: Option<Uuid>) -> Result<HashMap<String, Decimal>> {
    let rows: Vec<(Option<String>, Decimal)> = sqlx::query_as(
        "select l.original_line, coalesce(sum(-l.qty), 0) from e_pos_invoice__items l join e_pos_invoice p on p.tenant_id = l.tenant_id and p.id = l.parent_id \
         where p.tenant_id = $1 and p.return_against = $2 and p.docstatus = 1 and p.id is distinct from $3 group by l.original_line",
    )
    .bind(hc.ctx.tenant)
    .bind(original)
    .bind(this)
    .fetch_all(&mut **hc.tx)
    .await?;
    Ok(rows.into_iter().filter_map(|(l, q)| Some((l?, q))).collect())
}

/// A return is priced from its sale: same prices, discounts, taxes and customer.
async fn prepare_return(hc: &mut HookCtx<'_>, doc: &mut Doc, profile: &Profile) -> Result<()> {
    let oid = id(doc, "return_against").ok_or_else(|| Error::field("return_against", "choose the sale being returned"))?;
    let orig = get(hc.kernel, hc.ctx, hc.tx, "PosInvoice", oid).await?;
    if d(&orig, "docstatus") != Decimal::ONE || b(&orig, "is_return") {
        return Err(Error::field("return_against", "returns are made against a submitted sale"));
    }
    if id(&orig, "company") != id(doc, "company") {
        return Err(Error::field("return_against", "the sale belongs to another company"));
    }
    for f in ["customer", "customer_name", "price_list", "tax_template", "discount_percent", "loyalty_program"] {
        set(doc, f, orig.get(f).cloned().unwrap_or(Value::Null));
    }
    let taxes: Vec<Value> = rows(&orig, "taxes")
        .into_iter()
        .map(|mut t| {
            for k in ["tax_amount", "total", "base_tax_amount", "base_total"] {
                t.remove(k);
            }
            t.insert("id".into(), json!(Uuid::now_v7().to_string()));
            Value::Object(t)
        })
        .collect();
    set(doc, "taxes", Value::Array(taxes));
    let sold = rows(&orig, "items");
    let done = returned_so_far(hc, oid, id(doc, "id")).await?;
    let mut items = rows(doc, "items");
    let mut errors = Vec::new();
    for (i, r) in items.iter_mut().enumerate() {
        let item = id(r, "item");
        let want = -d(r, "qty");
        let left = |l: &Doc| d(l, "qty") - done.get(s(l, "id").unwrap_or_default()).copied().unwrap_or_default();
        let line = match s(r, "original_line") {
            Some(given) => sold.iter().find(|l| s(l, "id") == Some(given) && id(l, "item") == item),
            None => {
                let same: Vec<&Doc> = sold.iter().filter(|l| id(l, "item") == item).collect();
                same.iter().find(|l| left(l) >= want).or(same.first()).copied()
            }
        };
        let Some(line) = line else {
            errors.push(FieldError::new("item", format!("not sold on {}", s(&orig, "number").unwrap_or("the original sale"))).in_row("items", i));
            continue;
        };
        set(r, "original_line", line.get("id").cloned().unwrap_or(Value::Null));
        set(r, "price_list_rate", line.get("price_list_rate").cloned().unwrap_or(Value::Null));
        set(r, "discount_percent", line.get("discount_percent").cloned().unwrap_or(json!("0")));
        r.insert("manual_rate".into(), Value::Null);
        if s(r, "batch_no").is_none() {
            set(r, "batch_no", line.get("batch_no").cloned().unwrap_or(Value::Null));
        }
        set(r, "warehouse", profile.warehouse.to_string());
    }
    if !errors.is_empty() {
        return Err(Error::Validation(errors));
    }
    set(doc, "items", rows_value(items));
    calculate(hc.kernel, hc.ctx, hc.tx, hc.entity, doc, Side::Selling).await?;
    Ok(())
}

/// Amounts of loyalty rows, paid and change (refreshed on every save so drafts and `_calc`
/// previews show them; enforced at submit).
async fn derive_payments(hc: &mut HookCtx<'_>, doc: &mut Doc, profile: &Profile, co: &Company) -> Result<()> {
    let ret = b(doc, "is_return");
    let sign = if ret { -Decimal::ONE } else { Decimal::ONE };
    let mut payments = rows(doc, "payments");
    let mut redeemed = 0;
    if payments.iter().any(|p| kind_of(p) == Some(Kind::Loyalty))
        && let Some(pid) = id(doc, "loyalty_program")
    {
        let program = Program::load(hc.kernel, hc.ctx, hc.tx, pid).await?;
        for p in payments.iter_mut().filter(|p| kind_of(p) == Some(Kind::Loyalty)) {
            let points = loyalty::row_points(p);
            redeemed += points;
            set(p, "amount", money(sign * loyalty::value_of(&program, points, co.precision)));
        }
        set(doc, "payments", rows_value(payments.clone()));
    }
    let paid: Decimal = payments.iter().map(|p| d(p, "amount")).sum();
    set(doc, "paid_amount", money(paid));
    let (change, write_off) = if ret {
        (Decimal::ZERO, Decimal::ZERO)
    } else {
        logic::settle_sale(d(doc, "rounded_total"), &tenders(&payments, Decimal::ONE), d(&profile.doc, "write_off_limit"))
            .map(|st| (st.change, st.write_off))
            .unwrap_or_default()
    };
    set(doc, "change_amount", money(change));
    set(doc, "write_off_amount", money(write_off));
    set(doc, "loyalty_points_redeemed", json!(if ret { 0 } else { redeemed }));
    Ok(())
}

/// Return checks that need the original under lock: it is consolidated or in this session (so
/// the closing finds its sales invoice), each line comes back at most as often as it was sold,
/// serials left on it, and refunds follow its payments.
async fn check_return(hc: &mut HookCtx<'_>, doc: &Doc, payments: &[Doc]) -> Result<()> {
    let oid = id(doc, "return_against").ok_or_else(|| Error::field("return_against", "is required"))?;
    let orig = hc.kernel.get_tx(&sys(hc.ctx), hc.tx, "PosInvoice", oid, true).await?;
    if d(&orig, "docstatus") != Decimal::ONE {
        return Err(Error::field("return_against", "the sale was cancelled"));
    }
    if id(&orig, "consolidated_invoice").is_none() && id(&orig, "pos_opening_entry") != id(doc, "pos_opening_entry") {
        return Err(Error::field("return_against", "the sale is still in another register's open session; return it there, or once that session is closed"));
    }
    let sold = rows(&orig, "items");
    let done = returned_so_far(hc, oid, id(doc, "id")).await?;
    let mut now: HashMap<String, Decimal> = HashMap::new();
    let mut errors = Vec::new();
    for (i, r) in rows(doc, "items").iter().enumerate() {
        let Some(line) = s(r, "original_line").and_then(|l| sold.iter().find(|x| s(x, "id") == Some(l))) else {
            errors.push(FieldError::new("original_line", "not a line of the original sale").in_row("items", i));
            continue;
        };
        let key = s(line, "id").unwrap_or_default().to_string();
        let total = now.entry(key.clone()).or_default();
        *total += -d(r, "qty");
        let returnable = d(line, "qty") - done.get(&key).copied().unwrap_or_default();
        if *total > returnable {
            errors.push(
                FieldError::new(
                    "qty",
                    format!(
                        "{}: only {} of the {} sold can still come back",
                        s(line, "item_name").unwrap_or("item"),
                        returnable.normalize(),
                        d(line, "qty").normalize()
                    ),
                )
                .in_row("items", i),
            );
        }
        let left: HashSet<String> = parse_serials(s(line, "serial_no")).into_iter().collect();
        for serial in parse_serials(s(r, "serial_no")) {
            if !left.contains(&serial) {
                errors.push(FieldError::new("serial_no", format!("serial {serial} was not sold on this line")).in_row("items", i));
            }
        }
    }
    if !errors.is_empty() {
        return Err(Error::Validation(errors));
    }
    // What the sale was paid with, less what earlier returns refunded, per class.
    let mut paid = tenders(&rows(&orig, "payments"), Decimal::ONE);
    logic::net_of_change(d(&orig, "change_amount"), &mut paid);
    let refunded: Vec<(Option<String>, Decimal)> = sqlx::query_as(
        "select pm.mode_type, coalesce(sum(-pm.amount), 0) from e_pos_invoice__payments pm join e_pos_invoice p on p.tenant_id = pm.tenant_id and p.id = pm.parent_id \
         where p.tenant_id = $1 and p.return_against = $2 and p.docstatus = 1 and p.id <> $3 group by pm.mode_type",
    )
    .bind(hc.ctx.tenant)
    .bind(oid)
    .bind(id(doc, "id"))
    .fetch_all(&mut **hc.tx)
    .await?;
    let mut left = Refundable::default();
    for t in &paid {
        match t.kind {
            Kind::Credit => left.credit += t.amount,
            Kind::Loyalty => left.loyalty += t.amount,
            _ => left.money += t.amount,
        }
    }
    for (kind, amount) in refunded {
        match kind.as_deref().and_then(Kind::parse) {
            Some(Kind::Credit) => left.credit -= amount,
            Some(Kind::Loyalty) => left.loyalty -= amount,
            _ => left.money -= amount,
        }
    }
    let refunds = tenders(payments, -Decimal::ONE);
    logic::check_refunds(-d(doc, "rounded_total"), &refunds, &left).map_err(|m| Error::field("payments", m))
}

/// A named customer with a credit limit: the consolidated invoice will count the whole sale
/// against the limit at closing (as every sales invoice does), so the register refuses it now
/// rather than leaving the closing to fail.
async fn check_credit_limit(hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
    let Some(customer) = id(doc, "customer") else { return Ok(()) };
    let cust = get(hc.kernel, hc.ctx, hc.tx, "Customer", customer).await?;
    let limit = d(&cust, "credit_limit");
    if limit <= Decimal::ZERO {
        return Ok(());
    }
    let (exposure, pending): (Decimal, Decimal) = sqlx::query_as(
        "select (select coalesce(sum(base_outstanding), 0) from open_item where tenant_id = $1 and customer_id = $2 and company_id = $3 and status = 'open'), \
         (select coalesce(sum(rounded_total), 0) from e_pos_invoice where tenant_id = $1 and customer = $2 and company = $3 and docstatus = 1 \
          and not is_return and consolidated_invoice is null and id <> $4)",
    )
    .bind(hc.ctx.tenant)
    .bind(customer)
    .bind(id(doc, "company"))
    .bind(id(doc, "id"))
    .fetch_one(&mut **hc.tx)
    .await?;
    let this = d(doc, "rounded_total");
    if exposure + pending + this > limit {
        return Err(Error::invalid(format!(
            "credit limit exceeded for {}: outstanding {} + register sales not yet closed {} + this sale {} > limit {}",
            s(&cust, "customer_name").unwrap_or_default(),
            exposure.normalize(),
            pending.normalize(),
            this.normalize(),
            limit.normalize()
        )));
    }
    Ok(())
}

/// Stock leaves (or, for returns, comes back to) the register's warehouse, valued like a
/// delivery: issues at the current valuation, returns at the cost they left at.
async fn post_stock(hc: &mut HookCtx<'_>, doc: &Doc, co: &Company) -> Result<()> {
    let iid = id(doc, "id").ok_or_else(|| Error::internal("no id"))?;
    let original = id(doc, "return_against").filter(|_| b(doc, "is_return"));
    let mut stock_items: HashMap<Uuid, bool> = HashMap::new();
    let mut moves = Vec::new();
    for r in rows(doc, "items") {
        let Some(item) = id(&r, "item") else { continue };
        if let std::collections::hash_map::Entry::Vacant(e) = stock_items.entry(item) {
            e.insert(b(&get(hc.kernel, hc.ctx, hc.tx, "Item", item).await?, "is_stock_item"));
        }
        let qty = -d(&r, "qty");
        if !stock_items[&item] || qty.is_zero() {
            continue;
        }
        let rate = match original {
            Some(o) if qty > Decimal::ZERO => {
                let cost: Option<Decimal> = sqlx::query_scalar(
                    "select sum(value) / nullif(sum(qty), 0) from stock_move where tenant_id = $1 and source_entity = 'PosInvoice' and source_id = $2 \
                     and item_id = $3 and qty < 0 and reversal_of is null",
                )
                .bind(hc.ctx.tenant)
                .bind(o)
                .bind(item)
                .fetch_one(&mut **hc.tx)
                .await?;
                cost.map(|c| c.abs().round_dp(12))
            }
            _ => None,
        };
        moves.push(MoveIn {
            item,
            warehouse: id(&r, "warehouse").ok_or_else(|| Error::internal("line without warehouse"))?,
            qty,
            rate,
            batch_no: s(&r, "batch_no").map(str::to_string),
            serials: parse_serials(s(&r, "serial_no")),
            source_line: id(&r, "id"),
            ..Default::default()
        });
    }
    if moves.is_empty() {
        return Ok(());
    }
    let on = date(doc, "posting_date")?;
    let posted = stock::post_moves(hc.tx, hc.ctx, co, "PosInvoice", iid, on, posting_ts(doc)?, moves, "delivered").await?;
    let cogs = co.require("cogs_account", "cost of goods sold account")?;
    let mut entry = Entry::new(co.id, on, "PosInvoice", iid, s(doc, "number").map(str::to_string));
    entry.memo = Some(if original.is_some() { "Goods returned at the register" } else { "Goods sold at the register" }.into());
    for p in &posted {
        let wh = get(hc.kernel, hc.ctx, hc.tx, "Warehouse", p.warehouse).await?;
        let account = match id(&wh, "account") {
            Some(a) => a,
            None => co.require("default_inventory_account", "default inventory account")?,
        };
        entry.lines.push(Line::new(account, p.value, &co.currency_code));
        entry.lines.push(Line::new(cogs, -p.value, &co.currency_code).cost_center(id(doc, "cost_center")));
    }
    ledger::post(hc.tx, hc.ctx, entry, co.precision).await?;
    Ok(())
}
