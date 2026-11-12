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

use crate::logic::{self, Act, Kind, LineAsk, Refundable, Tender};
use crate::loyalty::{self, Program};
use crate::{Mode, Profile, is_manager, live_session, open_session, opt_dec, rows_value};
use async_trait::async_trait;
use ferrum_app_erp::ledger::{self, Entry, Line};
use ferrum_app_erp::pricing::{Side, calculate};
use ferrum_app_erp::stock::{self, MoveIn, parse_serials};
use ferrum_domain::util::{Company, b, company, d, date, elevated, get, id, money, posting_ts, rows, s, set, sys};
use ferrum_kernel::{Doc, DocHook, Error, FieldError, HookCtx, Result, Tx};
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
        let mut named = false;
        if b(doc, "is_return") && b(doc, "without_receipt") {
            prepare_unreceipted(hc, doc, &profile).await?;
        } else if b(doc, "is_return") {
            prepare_return(hc, doc, &profile).await?;
        } else {
            if id(doc, "customer").is_none()
                && let Some(c) = id(&profile.doc, "customer")
            {
                let cust = get(hc.kernel, hc.ctx, hc.tx, "Customer", c).await?;
                set(doc, "customer", c.to_string());
                set(doc, "customer_name", cust.get("customer_name").cloned().unwrap_or(Value::Null));
            }
            // A buyer who gives a tax registration is that customer, and gets a tax invoice of their own.
            let buyer = crate::buyer::resolve(hc, doc, &profile).await?;
            set(doc, "tax_invoice", json!(buyer.as_ref().is_some_and(|b| b.tax_invoice)));
            if buyer.as_ref().is_some_and(|b| b.tax_invoice) {
                set(doc, "invoice_now", json!(true));
            }
            named = buyer.is_some();
            if s(doc, "channel").is_none() {
                set(doc, "channel", crate::snapshot::CHANNEL);
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
        crate::stored::prepare(hc, doc, &profile).await?;
        derive_payments(hc, doc, &profile, &co).await?;
        // A sale above what the register takes without a named buyer (the rule on the sale says so).
        let unnamed = !named && id(doc, "customer") == id(&profile.doc, "customer");
        let needs = !b(doc, "is_return") && unnamed && opt_dec(&profile.doc, "named_buyer_above").is_some_and(|above| d(doc, "rounded_total") > above);
        set(doc, "needs_buyer", json!(needs));
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
            if ret && id(r, "stored_value_kind").is_some() {
                errors.push(FieldError::new("item", "a card is not returned: what is left on it can be cashed out or adjusted").in_row("items", i));
            }
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
        let voided = rows(doc, "voided_lines");
        for (i, v) in voided.iter().enumerate() {
            let ok = match id(v, "reason") {
                Some(r) => {
                    let reason = get(hc.kernel, hc.ctx, hc.tx, "PosReason", r).await?;
                    s(&reason, "applies_to") == Some("Void") && !b(&reason, "disabled")
                }
                None => false,
            };
            if !ok {
                errors.push(FieldError::new("reason", "choose one of the business's reasons for voiding").in_row("voided_lines", i));
            }
        }
        if !voided.is_empty() && !crate::limits::of(hc.ctx, hc.tx, &profile).await?.void_line && !approved(hc, doc, Act::VoidLine, Decimal::ZERO, false).await?
        {
            errors.push(FieldError::new("voided_lines", "you may not void lines; ask someone who may to approve it"));
        }
        if errors.is_empty() { Ok(()) } else { Err(Error::Validation(errors)) }
    }

    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, params: &Value) -> Result<Option<Value>> {
        if name != "void" {
            return Ok(None);
        }
        void_sale(hc, doc, params).await.map(Some)
    }

    async fn before_submit(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        // Under the session lock: the closing cannot run between this check and the commit.
        live_session(hc, id(doc, "pos_opening_entry").unwrap_or_default(), true).await?;
        let named: Vec<Uuid> = rows(doc, "approvals").iter().filter_map(|r| id(r, "approval")).collect();
        crate::limits::use_approvals(hc.tx, hc.ctx.tenant, &named, id(doc, "id").unwrap_or_default()).await?;
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
                Kind::Credit | Kind::StoredValue => None,
                Kind::Loyalty => program.as_ref().and_then(|pr| pr.expense_account),
                _ => Some(mode.account(&co)?),
            };
            set(p, "account", account.map(|a| json!(a.to_string())).unwrap_or(Value::Null));
        }
        set(doc, "payments", rows_value(payments.clone()));
        if b(doc, "is_return") && b(doc, "without_receipt") {
            return check_unreceipted(hc, doc, &payments).await;
        }
        if b(doc, "is_return") {
            return check_return(hc, doc, &payments).await;
        }
        // Stored value taken offline: what each card holds now, the rest written off and recorded.
        let short = crate::stored::offline(hc, doc, &profile).await?;
        let payments = rows(doc, "payments");
        let short_total: Decimal = short.iter().map(|x| x.0).sum();
        let total = d(doc, "rounded_total");
        let st = logic::settle_sale(total, &tenders(&payments, Decimal::ONE), d(&profile.doc, "write_off_limit") + short_total)
            .map_err(|m| Error::field("payments", m))?;
        let system = ferrum_domain::util::elevated(hc.ctx);
        for (amount, account) in short {
            let row = json!({"pos_invoice": id(doc, "id"), "pos_profile": profile.id, "company": co.id, "amount_short": money(amount),
                "stored_value_account": account, "sold_at": format!("{} {}", s(doc, "posting_date").unwrap_or_default(), s(doc, "posting_time").unwrap_or_default())});
            hc.kernel.insert_tx(&system, hc.tx, "PosStockShortfall", row.as_object().cloned().unwrap_or_default()).await?;
        }
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
        // A sale made while the till was offline that takes more than the warehouse holds when it
        // arrives: the customer paid and took the goods, so it is recorded, and what it oversold waits
        // as a Stock Shortfall for someone to put right, unless the register refuses such sales (FEO-026).
        let reconcile = b(doc, "sold_offline") && !co.allow_negative_stock && s(&profile.doc, "offline_shortfall") != Some("Refuse");
        let before = if reconcile { Some(on_hand(hc, doc, &co).await?) } else { None };
        co.allow_negative_stock |= reconcile;
        post_stock(hc, doc, &co).await?;
        // The codes and promotions it used are counted once. A sale made offline was made on the till's
        // word: a use that ran out meanwhile is not a reason to refuse what the buyer already paid.
        if let Err(e) = ferrum_app_erp::promotion::count_uses(hc, doc, 1).await
            && !b(doc, "sold_offline")
        {
            return Err(e);
        }
        record_difference(hc, doc).await?;
        if let Some(before) = before {
            record_shortfalls(hc, doc, &co, &before).await?;
        }
        // Stored value, or a tax invoice asked for now: the sale's own invoice now, cards paid from or onto.
        // A return without a receipt too: the closing's credit notes name the sale they reverse.
        if crate::stored::touches(doc) || b(doc, "invoice_now") || b(doc, "without_receipt") {
            let si = crate::closing::invoice_now(hc, iid).await?;
            crate::stored::settle(hc, doc, si).await?;
        }
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
        ferrum_app_erp::promotion::count_uses(hc, doc, -1).await?;
        let mut v = Doc::new();
        v.insert("status".into(), json!("Cancelled"));
        hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "PosInvoice", iid, v).await
    }
}

/// A sale made offline whose totals disagree: what the till showed, what the snapshot it used gives and what the
/// sale was recorded at are not all the same (or the snapshot is no longer kept). The sale stands as the buyer paid
/// it; a person looks at why (`PosPriceDifference`).
async fn record_difference(hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
    if !b(doc, "sold_offline") || (s(doc, "price_snapshot").is_none() && opt_dec(doc, "till_total").is_none()) {
        return Ok(());
    }
    let (sale, till, replay) = (d(doc, "rounded_total"), opt_dec(doc, "till_total"), opt_dec(doc, "replay_total"));
    let gone = s(doc, "price_snapshot").is_some() && replay.is_none();
    if !gone && till.is_none_or(|t| t == sale) && replay.is_none_or(|r| r == sale) {
        return Ok(());
    }
    let row = json!({
        "pos_invoice": id(doc, "id"), "pos_profile": id(doc, "pos_profile"), "company": id(doc, "company"), "price_snapshot": s(doc, "price_snapshot"),
        "till_total": till.map(money), "replay_total": replay.map(money), "sale_total": money(sale), "snapshot_kept": !gone,
    });
    hc.kernel.insert_tx(&elevated(hc.ctx), hc.tx, "PosPriceDifference", row.as_object().cloned().unwrap_or_default()).await?;
    Ok(())
}

/// Prices a sale. The first pass learns each line's list price and pricing-rule discount; the
/// cashier's own price or discount then replaces them when the register allows it (a POS
/// manager may always), and a second pass computes the totals with them.
async fn price_sale(hc: &mut HookCtx<'_>, doc: &mut Doc, profile: &Profile) -> Result<()> {
    let mut items = rows(doc, "items");
    let asked: Vec<(Option<Decimal>, Option<Decimal>)> =
        items.iter().map(|r| (opt_dec(r, "discount_percent"), opt_dec(r, "manual_rate").filter(|m| *m > Decimal::ZERO))).collect();
    // A sale made offline is also priced with the snapshot its till used, to see that the two agree.
    if b(doc, "sold_offline") && s(doc, "price_snapshot").is_some() {
        let group = match id(doc, "customer") {
            Some(c) => id(&get(hc.kernel, hc.ctx, hc.tx, "Customer", c).await?, "customer_group"),
            None => None,
        };
        let total = crate::snapshot::replay_sale(hc, doc, profile.id, &asked, group).await?;
        set(doc, "replay_total", total.map(money).unwrap_or(Value::Null));
    }
    for r in items.iter_mut() {
        r.insert("price_list_rate".into(), Value::Null);
        r.insert("discount_percent".into(), Value::Null);
        set(r, "warehouse", profile.warehouse.to_string());
    }
    set(doc, "items", rows_value(items));
    calculate(hc.kernel, hc.ctx, hc.tx, hc.entity, doc, Side::Selling).await?;

    let limits = crate::limits::of(hc.ctx, hc.tx, profile).await?;
    let header = d(doc, "discount_percent");
    let mut items = rows(doc, "items");
    let mut errors = Vec::new();
    let mut again = false;
    let mut asks = Vec::with_capacity(items.len());
    for (i, r) in items.iter_mut().enumerate() {
        let (list, rule) = (d(r, "price_list_rate"), d(r, "discount_percent"));
        // A free item a promotion added has no cashier's ask.
        let (ask_discount, ask_rate) = asked.get(i).copied().unwrap_or_default();
        let price = ask_rate.unwrap_or(list);
        let discount = ask_discount.unwrap_or(rule);
        if price <= Decimal::ZERO {
            let name = s(r, "item_name").unwrap_or("this item");
            errors.push(FieldError::new("manual_rate", format!("{name} has no price in the price list; type its price")).in_row("items", i));
        }
        asks.push(LineAsk { qty: d(r, "qty"), list, rule, price: ask_rate, discount: ask_discount });
        again |= price != list || discount != rule;
        set(r, "price_list_rate", money(price));
        set(r, "discount_percent", money(discount));
    }
    if errors.is_empty() {
        for (line, act, figure, why) in logic::beyond(&limits, &asks, header) {
            if approved(hc, doc, act, figure, line.is_none()).await? {
                continue;
            }
            let field = if act == Act::PriceChange { "manual_rate" } else { "discount_percent" };
            let e = match line {
                Some(i) => FieldError::new(field, format!("{}: {why}; ask someone who may to approve it", s(&items[i], "item_name").unwrap_or("item")))
                    .in_row("items", i),
                None => FieldError::new("discount_percent", format!("{why}; ask someone who may to approve it")),
            };
            errors.push(e);
        }
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

/// Quantity of each original line already returned by other submitted returns (the returns desk
/// asks the same question before a return is made).
pub(crate) async fn returned_so_far(tx: &mut Tx, tenant: Uuid, original: Uuid, this: Option<Uuid>) -> Result<HashMap<String, Decimal>> {
    let rows: Vec<(Option<String>, Decimal)> = sqlx::query_as(
        "select l.original_line, coalesce(sum(-l.qty), 0) from e_pos_invoice__items l join e_pos_invoice p on p.tenant_id = l.tenant_id and p.id = l.parent_id \
         where p.tenant_id = $1 and p.return_against = $2 and p.docstatus = 1 and p.id is distinct from $3 group by l.original_line",
    )
    .bind(tenant)
    .bind(original)
    .bind(this)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().filter_map(|(l, q)| Some((l?, q))).collect())
}

/// What a sale took in through one payment method (cash net of the change it gave) and what its
/// other returns refunded through it so far.
pub(crate) struct Taken {
    pub mode: Uuid,
    pub kind: Kind,
    pub paid: Decimal,
    pub refunded: Decimal,
}

impl Taken {
    pub fn room(&self) -> Decimal {
        self.paid - self.refunded
    }
}

/// The room a sale leaves for refunds, per payment method. A return may refund through a method
/// the sale did not use (cash for a card), so those appear too, with nothing paid.
pub(crate) async fn taken(tx: &mut Tx, tenant: Uuid, orig: &Doc, except: Option<Uuid>) -> Result<Vec<Taken>> {
    let pays = rows(orig, "payments");
    let mut net = tenders(&pays, Decimal::ONE);
    logic::net_of_change(d(orig, "change_amount"), &mut net);
    let mut out: Vec<Taken> = Vec::new();
    for (p, t) in pays.iter().zip(net) {
        let Some(mode) = id(p, "mode_of_payment") else { continue };
        match out.iter_mut().find(|x| x.mode == mode) {
            Some(x) => x.paid += t.amount,
            None => out.push(Taken { mode, kind: t.kind, paid: t.amount, refunded: Decimal::ZERO }),
        }
    }
    let refunded: Vec<(Option<Uuid>, Option<String>, Decimal)> = sqlx::query_as(
        "select pm.mode_of_payment, pm.mode_type, coalesce(sum(-pm.amount), 0) from e_pos_invoice__payments pm join e_pos_invoice p on p.tenant_id = pm.tenant_id \
         and p.id = pm.parent_id where p.tenant_id = $1 and p.return_against = $2 and p.docstatus = 1 and p.id is distinct from $3 group by pm.mode_of_payment, pm.mode_type",
    )
    .bind(tenant)
    .bind(id(orig, "id"))
    .bind(except)
    .fetch_all(&mut **tx)
    .await?;
    for (mode, kind, amount) in refunded {
        let Some(mode) = mode else { continue };
        match out.iter_mut().find(|x| x.mode == mode) {
            Some(x) => x.refunded += amount,
            None => out.push(Taken { mode, kind: kind.as_deref().and_then(Kind::parse).unwrap_or(Kind::General), paid: Decimal::ZERO, refunded: amount }),
        }
    }
    Ok(out)
}

/// What the sale can still pay back, per class.
pub(crate) fn left_to_refund(room: &[Taken], orig: &Doc) -> Refundable {
    let all: Vec<_> = room.iter().map(|t| (t.kind, t.paid, t.refunded)).collect();
    logic::refundable(&all, d(orig, "write_off_amount"))
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
    let done = returned_so_far(hc.tx, hc.ctx.tenant, oid, id(doc, "id")).await?;
    let fees = fees(policy(hc, profile).await?.as_ref());
    let mut items = rows(doc, "items");
    let mut errors = Vec::new();
    for (i, r) in items.iter_mut().enumerate() {
        let item = id(r, "item");
        let condition = condition_of(r);
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
        set(r, "promotion_percent", line.get("promotion_percent").cloned().unwrap_or(Value::Null));
        set(r, "discount_percent", money(logic::with_fee(d(line, "discount_percent"), logic::restocking_fee(&fees, &condition))));
        r.insert("manual_rate".into(), Value::Null);
        if s(r, "batch_no").is_none() {
            set(r, "batch_no", line.get("batch_no").cloned().unwrap_or(Value::Null));
        }
        match return_warehouse(profile, &condition) {
            Ok(w) => set(r, "warehouse", w.to_string()),
            Err(m) => errors.push(FieldError::new("condition", m).in_row("items", i)),
        }
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
    let done = returned_so_far(hc.tx, hc.ctx.tenant, oid, id(doc, "id")).await?;
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
    let profile = Profile::load(hc.kernel, hc.ctx, hc.tx, id(doc, "pos_profile").unwrap_or_default()).await?;
    let policy = policy(hc, &profile).await?;
    let window = policy.as_ref().and_then(|p| p.get("window_days")).and_then(Value::as_i64).unwrap_or(0);
    if window > 0 && date(&orig, "posting_date")? + chrono::Duration::days(window) < date(doc, "posting_date")? {
        return Err(Error::field("return_against", format!("the sale is older than the {window} days the register's return policy takes returns within")));
    }
    // What the sale was paid with, less what earlier returns refunded, per class; in an exchange what
    // went on to the new sale is not refunded.
    let (carried, payments) = exchanged(policy.as_ref(), doc, payments);
    let room = taken(hc.tx, hc.ctx.tenant, &orig, id(doc, "id")).await?;
    let left = left_to_refund(&room, &orig);
    let refunds = tenders(&payments, -Decimal::ONE);
    let total = -d(doc, "rounded_total") - carried;
    logic::check_refunds(total, &refunds, &left).map_err(|m| Error::field("payments", m))?;
    let limits = crate::limits::of(hc.ctx, hc.tx, &profile).await?;
    refund_within(hc, doc, &limits, total).await
}

/// In an exchange, what its return carried on to the new sale through the policy's clearing method,
/// and the rest of its refunds.
fn exchanged(policy: Option<&Doc>, doc: &Doc, payments: &[Doc]) -> (Decimal, Vec<Doc>) {
    let via = policy.and_then(|p| id(p, "exchange_mode")).filter(|_| id(doc, "exchange").is_some());
    let (carried, rest): (Vec<Doc>, Vec<Doc>) = payments.iter().cloned().partition(|p| via.is_some() && id(p, "mode_of_payment") == via);
    (carried.iter().map(|p| -d(p, "amount")).sum(), rest)
}

/// A refund of `total` within the cashier's limit, or approved.
async fn refund_within(hc: &mut HookCtx<'_>, doc: &Doc, limits: &logic::Limits, total: Decimal) -> Result<()> {
    if !limits.allows(Act::Refund, total) && !approved(hc, doc, Act::Refund, total, false).await? {
        return Err(Error::field(
            "payments",
            format!(
                "a refund of {} is more than the {} you may give; ask someone who may to approve it",
                total.normalize(),
                limits.refund.unwrap_or_default().normalize()
            ),
        ));
    }
    Ok(())
}

/// The register's return policy, if it has one.
async fn policy(hc: &mut HookCtx<'_>, profile: &Profile) -> Result<Option<Doc>> {
    match id(&profile.doc, "return_policy") {
        Some(p) => Ok(Some(get(hc.kernel, hc.ctx, hc.tx, "PosReturnPolicy", p).await?)),
        None => Ok(None),
    }
}

fn condition_of(row: &Doc) -> String {
    s(row, "condition").unwrap_or("Resaleable").to_string()
}

/// Where goods coming back in `condition` go: the register's own warehouse when they can be sold
/// again, its damaged or scrap warehouse otherwise.
fn return_warehouse(profile: &Profile, condition: &str) -> std::result::Result<Uuid, String> {
    let named = |f: &str, what: &str| id(&profile.doc, f).ok_or_else(|| format!("this register takes nothing back {what}: it names no warehouse for it"));
    match condition {
        "Damaged" => named("damaged_warehouse", "damaged"),
        "Scrap" => named("scrap_warehouse", "for scrap"),
        _ => Ok(profile.warehouse),
    }
}

/// A policy's restocking fees: (condition, percent).
fn fees(policy: Option<&Doc>) -> Vec<(String, Decimal)> {
    policy.map(|p| rows(p, "fees").iter().filter_map(|f| Some((s(f, "condition")?.to_string(), d(f, "fee_percent")))).collect()).unwrap_or_default()
}

/// The lowest the register sold `item` for over the last `days` days.
async fn lowest_sold(hc: &mut HookCtx<'_>, profile: Uuid, item: Option<Uuid>, days: i64) -> Result<Option<Decimal>> {
    Ok(sqlx::query_scalar(
        "select min(l.rate) from e_pos_invoice__items l join e_pos_invoice p on p.tenant_id = l.tenant_id and p.id = l.parent_id \
         where p.tenant_id = $1 and p.pos_profile = $2 and p.docstatus = 1 and not coalesce(p.is_return, false) and l.item = $3 and l.qty > 0 \
         and p.posting_date >= current_date - $4::int",
    )
    .bind(hc.ctx.tenant)
    .bind(profile)
    .bind(item)
    .bind(days as i32)
    .fetch_one(&mut **hc.tx)
    .await?)
}

/// A return without a receipt (PS-34, PS-38): by the customer named or the walk-in customer, each
/// line at the price the register's return policy states (today's, the lowest it sold for over the
/// policy's window, or the price typed), less the restocking fee its condition carries, back to the
/// warehouse its condition says, taxed as a sale is.
async fn prepare_unreceipted(hc: &mut HookCtx<'_>, doc: &mut Doc, profile: &Profile) -> Result<()> {
    let policy = policy(hc, profile).await?.ok_or_else(|| Error::field("without_receipt", "this register has no return policy: a return needs its receipt"))?;
    set(doc, "return_against", Value::Null);
    if id(doc, "customer").is_none()
        && let Some(c) = id(&profile.doc, "customer")
    {
        let cust = get(hc.kernel, hc.ctx, hc.tx, "Customer", c).await?;
        set(doc, "customer", c.to_string());
        set(doc, "customer_name", cust.get("customer_name").cloned().unwrap_or(Value::Null));
    }
    for f in ["price_list", "tax_template"] {
        if let Some(v) = id(&profile.doc, f) {
            set(doc, f, v.to_string());
        }
    }
    let mut items = rows(doc, "items");
    let entered: Vec<Option<Decimal>> = items.iter().map(|r| opt_dec(r, "manual_rate").filter(|m| *m > Decimal::ZERO)).collect();
    let mut errors = Vec::new();
    for (i, r) in items.iter_mut().enumerate() {
        r.insert("price_list_rate".into(), Value::Null);
        r.insert("discount_percent".into(), Value::Null);
        r.insert("original_line".into(), Value::Null);
        match return_warehouse(profile, &condition_of(r)) {
            Ok(w) => set(r, "warehouse", w.to_string()),
            Err(m) => errors.push(FieldError::new("condition", m).in_row("items", i)),
        }
    }
    if !errors.is_empty() {
        return Err(Error::Validation(errors));
    }
    set(doc, "items", rows_value(items));
    calculate(hc.kernel, hc.ctx, hc.tx, hc.entity, doc, Side::Selling).await?;
    let basis = logic::ReturnBasis::parse(s(&policy, "price_basis"));
    let days = policy.get("price_window_days").and_then(Value::as_i64).unwrap_or(30);
    let fees = fees(Some(&policy));
    let mut items = rows(doc, "items");
    for (i, r) in items.iter_mut().enumerate() {
        let lowest = if basis == logic::ReturnBasis::Lowest { lowest_sold(hc, profile.id, id(r, "item"), days).await? } else { None };
        match logic::return_price(basis, d(r, "price_list_rate"), lowest, entered.get(i).copied().flatten()) {
            Ok(price) => {
                set(r, "price_list_rate", money(price));
                set(r, "discount_percent", money(logic::restocking_fee(&fees, &condition_of(r))));
            }
            Err(m) => errors.push(FieldError::new("manual_rate", format!("{}: {m}", s(r, "item_name").unwrap_or("item"))).in_row("items", i)),
        }
    }
    if !errors.is_empty() {
        return Err(Error::Validation(errors));
    }
    set(doc, "items", rows_value(items));
    calculate(hc.kernel, hc.ctx, hc.tx, hc.entity, doc, Side::Selling).await?;
    Ok(())
}

/// A return without a receipt, before it is kept: online only, with one of the business's reasons,
/// by someone who may take one (or with an approval), refunded only as the policy says (store
/// credit, or the methods it lists; an exchange's clearing method), within the cashier's refund
/// limit or approved.
async fn check_unreceipted(hc: &mut HookCtx<'_>, doc: &Doc, payments: &[Doc]) -> Result<()> {
    if b(doc, "sold_offline") {
        return Err(Error::field(
            "without_receipt",
            "a return without a receipt is taken online only: its price, the approval it may need and the store credit it is refunded onto are the server's",
        ));
    }
    let profile = Profile::load(hc.kernel, hc.ctx, hc.tx, id(doc, "pos_profile").unwrap_or_default()).await?;
    let policy = policy(hc, &profile).await?.ok_or_else(|| Error::field("without_receipt", "this register has no return policy"))?;
    let reason = match id(doc, "reason") {
        Some(r) => Some(get(hc.kernel, hc.ctx, hc.tx, "PosReason", r).await?),
        None => None,
    };
    if !reason.is_some_and(|r| s(&r, "applies_to") == Some("Return") && !b(&r, "disabled")) {
        return Err(Error::field("reason", "choose one of the business's reasons for returns"));
    }
    let limits = crate::limits::of(hc.ctx, hc.tx, &profile).await?;
    if !limits.return_without_receipt && !approved(hc, doc, Act::ReturnWithoutReceipt, Decimal::ZERO, false).await? {
        return Err(Error::field("without_receipt", "you may not take returns without a receipt; ask someone who may to approve it"));
    }
    let mut allowed: Vec<Uuid> = rows(&policy, "refund_modes").iter().filter_map(|r| id(r, "mode_of_payment")).collect();
    allowed.extend(id(&policy, "store_credit"));
    let (carried, refunds) = exchanged(Some(&policy), doc, payments);
    let mut refunded = Decimal::ZERO;
    for (i, p) in refunds.iter().enumerate() {
        if d(p, "amount") >= Decimal::ZERO {
            return Err(Error::field("payments", "refunds are entered as negative amounts on a return"));
        }
        if !id(p, "mode_of_payment").is_some_and(|m| allowed.contains(&m)) {
            let name = id(p, "mode_of_payment").and_then(|m| profile.mode(m)).map(|(m, _)| m.name.clone()).unwrap_or_default();
            let why =
                FieldError::new("mode_of_payment", format!("{name} is not how the return policy refunds a return without a receipt")).in_row("payments", i);
            return Err(Error::Validation(vec![why]));
        }
        refunded -= d(p, "amount");
    }
    let total = -d(doc, "rounded_total");
    if refunded + carried != total {
        return Err(Error::field("payments", format!("refunds of {} must equal the return total of {}", (refunded + carried).normalize(), total.normalize())));
    }
    refund_within(hc, doc, &limits, refunded).await
}

/// An exchange (PS-35), as one transaction: what comes back (`back`, a return with its receipt or
/// without one) and what goes out in its place (`out`, a sale), at one register, for one customer,
/// each priced, taxed and moving stock as on its own. What came back pays for what goes out through
/// the return policy's clearing method (so it nets to nothing at closing); the customer pays what is
/// left with the sale's payments, or is refunded the rest with the return's, as the policy says. Online only.
pub(crate) async fn exchange(k: &ferrum_kernel::Kernel, ctx: &ferrum_kernel::Ctx, mut back: Doc, mut out: Doc) -> Result<Value> {
    let pid = id(&back, "pos_profile").ok_or_else(|| Error::field("back.pos_profile", "is required"))?;
    if id(&out, "pos_profile") != Some(pid) {
        return Err(Error::field("out.pos_profile", "both halves of an exchange are at one register"));
    }
    if b(&back, "sold_offline") || b(&out, "sold_offline") {
        return Err(Error::invalid("an exchange is taken online only: what comes back must be in the books before it pays for what goes out"));
    }
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let profile = Profile::load(k, ctx, &mut tx, pid).await?;
    let policy = match id(&profile.doc, "return_policy") {
        Some(p) => get(k, ctx, &mut tx, "PosReturnPolicy", p).await?,
        None => return Err(Error::invalid("this register has no return policy: exchanges are not taken")),
    };
    let via = id(&policy, "exchange_mode")
        .ok_or_else(|| Error::invalid("the register's return policy names no Exchange Clearing method: exchanges are not taken"))?;
    let (bid, oid) = (id(&back, "id").unwrap_or_else(Uuid::now_v7), id(&out, "id").unwrap_or_else(Uuid::now_v7));
    let (back_pays, out_pays) = (rows(&back, "payments"), rows(&out, "payments"));
    for (doc, me, ret) in [(&mut back, bid, true), (&mut out, oid, false)] {
        set(doc, "id", me.to_string());
        set(doc, "is_return", ret);
        set(doc, "payments", json!([]));
    }
    let returned = k.insert_tx(ctx, &mut tx, "PosInvoice", back).await?;
    set(&mut out, "customer", returned.get("customer").cloned().unwrap_or(Value::Null));
    let sold = k.insert_tx(ctx, &mut tx, "PosInvoice", out).await?;
    let x = logic::exchange(-d(&returned, "rounded_total"), d(&sold, "rounded_total"));
    for (me, mut pays, carried, other) in [(bid, back_pays, -x.carried, oid), (oid, out_pays, x.carried, bid)] {
        let mut link = Doc::new();
        link.insert("exchange".into(), json!(other.to_string()));
        k.set_values_tx(&sys(ctx), &mut tx, "PosInvoice", me, link).await?;
        if !carried.is_zero() {
            pays.push(json!({"mode_of_payment": via.to_string(), "amount": money(carried)}).as_object().cloned().unwrap_or_default());
        }
        let mut patch = Doc::new();
        patch.insert("payments".into(), rows_value(pays));
        k.update_tx(ctx, &mut tx, "PosInvoice", me, patch, None).await?;
    }
    let returned = k.submit_tx(ctx, &mut tx, "PosInvoice", bid, None).await?;
    let sold = k.submit_tx(ctx, &mut tx, "PosInvoice", oid, None).await?;
    tx.commit().await?;
    Ok(json!({"return": returned, "sale": sold, "carried": money(x.carried), "due": money(x.due), "refund": money(x.refund)}))
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

/// What a sale takes out of each warehouse, by item: its stock lines' quantities, sold (positive).
async fn stock_taken(hc: &mut HookCtx<'_>, doc: &Doc) -> Result<HashMap<(Uuid, Uuid), Decimal>> {
    let mut out: HashMap<(Uuid, Uuid), Decimal> = HashMap::new();
    for r in rows(doc, "items") {
        let (Some(item), Some(wh)) = (id(&r, "item"), id(&r, "warehouse")) else { continue };
        if d(&r, "qty") <= Decimal::ZERO || !b(&get(hc.kernel, hc.ctx, hc.tx, "Item", item).await?, "is_stock_item") {
            continue;
        }
        *out.entry((item, wh)).or_default() += d(&r, "qty");
    }
    Ok(out)
}

/// What each warehouse holds of what the sale takes, before it is posted (the balances locked).
async fn on_hand(hc: &mut HookCtx<'_>, doc: &Doc, co: &Company) -> Result<HashMap<(Uuid, Uuid), Decimal>> {
    let keys: Vec<(Uuid, Uuid)> = stock_taken(hc, doc).await?.into_keys().collect();
    if keys.is_empty() {
        return Ok(HashMap::new());
    }
    let held = stock::lock_balances(hc.tx, hc.ctx.tenant, co.id, &keys).await?;
    Ok(keys.into_iter().map(|k| (k, held.get(&k).map(|b| b.0).unwrap_or_default())).collect())
}

/// A shortfall for each item the sale took beyond what its warehouse held: the part of it that was
/// not there.
async fn record_shortfalls(hc: &mut HookCtx<'_>, doc: &Doc, co: &Company, before: &HashMap<(Uuid, Uuid), Decimal>) -> Result<()> {
    let iid = id(doc, "id").ok_or_else(|| Error::internal("no id"))?;
    let system = ferrum_domain::util::elevated(hc.ctx);
    let sold_at = format!("{} {}", s(doc, "posting_date").unwrap_or_default(), s(doc, "posting_time").unwrap_or_default()).trim().to_string();
    for ((item, wh), qty) in stock_taken(hc, doc).await? {
        let had = before.get(&(item, wh)).copied().unwrap_or_default().max(Decimal::ZERO);
        let short = qty - had;
        if short <= Decimal::ZERO {
            continue;
        }
        let mut row = Doc::new();
        for (k, v) in [
            ("pos_invoice", json!(iid)),
            ("pos_profile", json!(id(doc, "pos_profile"))),
            ("company", json!(co.id)),
            ("item", json!(item)),
            ("warehouse", json!(wh)),
            ("qty_short", json!(short.normalize().to_string())),
            ("sold_at", json!(sold_at)),
        ] {
            row.insert(k.into(), v);
        }
        hc.kernel.insert_tx(&system, hc.tx, "PosStockShortfall", row).await?;
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

/// Whether an approval the sale names covers `act` at `figure` for its cashier in its session.
async fn approved(hc: &mut HookCtx<'_>, doc: &Doc, act: Act, figure: Decimal, money: bool) -> Result<bool> {
    let (Some(cashier), Some(session)) = (s(doc, "cashier").map(str::to_string), id(doc, "pos_opening_entry")) else { return Ok(false) };
    let me = id(doc, "id").unwrap_or_default();
    for a in rows(doc, "approvals").iter().filter_map(|r| id(r, "approval")) {
        if crate::limits::covers(hc.tx, hc.ctx.tenant, a, (&cashier, session), act, figure, money, me).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Voids a submitted sale not yet closed into the books, with one of the business's reasons, by
/// someone whose limits allow it or with an approval for it: it is cancelled (stock back, out of
/// the session's takings) and keeps who voided it and why.
async fn void_sale(hc: &mut HookCtx<'_>, doc: &Doc, params: &Value) -> Result<Value> {
    let sale = id(doc, "id").ok_or_else(|| Error::internal("no id"))?;
    let reason: Uuid =
        params.get("reason").and_then(Value::as_str).and_then(|r| r.parse().ok()).ok_or_else(|| Error::field("reason", "choose why the sale is voided"))?;
    let r = get(hc.kernel, hc.ctx, hc.tx, "PosReason", reason).await?;
    if s(&r, "applies_to") != Some("Void") || b(&r, "disabled") {
        return Err(Error::field("reason", "choose one of the business's reasons for voiding"));
    }
    let profile = Profile::load(hc.kernel, hc.ctx, hc.tx, id(doc, "pos_profile").unwrap_or_default()).await?;
    if !crate::limits::of(hc.ctx, hc.tx, &profile).await?.void_sale {
        let approval: Option<Uuid> = params.get("approval").and_then(Value::as_str).and_then(|a| a.parse().ok());
        let session = crate::open_session_in(hc.tx, hc.ctx.tenant, profile.id, &hc.ctx.email).await?;
        let ok = match (approval, session) {
            (Some(a), Some(sid)) => crate::limits::covers(hc.tx, hc.ctx.tenant, a, (&hc.ctx.email, sid), Act::VoidSale, Decimal::ZERO, false, sale).await?,
            _ => false,
        };
        if !ok {
            return Err(Error::Forbidden("you may not void sales; ask someone who may to approve it".into()));
        }
        crate::limits::use_approvals(hc.tx, hc.ctx.tenant, &approval.into_iter().collect::<Vec<_>>(), sale).await?;
    }
    let mut v = Doc::new();
    v.insert("void_reason".into(), json!(reason.to_string()));
    v.insert("voided_by".into(), json!(hc.ctx.email));
    hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "PosInvoice", sale, v).await?;
    hc.kernel.cancel_tx(&ferrum_domain::util::elevated(hc.ctx), hc.tx, "PosInvoice", sale, None).await?;
    Ok(json!({"status": "Cancelled"}))
}
