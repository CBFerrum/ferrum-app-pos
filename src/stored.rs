//! Stored value at the till (PS-36, PS-37), through ERP's stored value (`ferrum_app_erp::stored_value`):
//! gift cards and store credit sold or topped up on a sale line, taken as a tender, given back onto
//! on a return.
//!
//! A sale that touches stored value is invoiced when it is submitted, not at closing
//! (`closing::invoice_now`): a card sold at ten is spendable at eleven, and a card's balance is
//! taken when the customer pays with it. The card's line loads it through the sales invoice (ERP's
//! own hook); a tender takes from it, or a refund gives back onto it, by a payment entry against
//! that invoice or credit note, in the sale's own transaction, so each happens exactly once with the
//! sale's submit (which a retry or a second sync cannot repeat). Codes are never kept: a line or a
//! tender keeps the code's last four characters and, for a new card, the hash ERP keeps; a PIN is
//! checked when the sale is saved (with ERP's guessing limits) and dropped.
//!
//! Offline, a till cannot see a balance: a payment method of this kind is refused offline unless it
//! states an amount it may take offline (`ModeOfPayment.offline_limit`); such a sale is settled when
//! it arrives, and what the card no longer holds is written off on the sale and recorded as a
//! shortfall (`PosStockShortfall.amount_short`) for someone to put right.

use crate::Profile;
use crate::logic::Kind;
use ferrum_app_erp::stored_value as sv;
use ferrum_domain::util::{b, d, elevated, get, id, money, rows, s, set};
use ferrum_kernel::{Doc, Error, FieldError, HookCtx, Result};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use uuid::Uuid;

/// The account an existing card's code names, without its PIN (value is given, not taken).
async fn by_code(hc: &mut HookCtx<'_>, hash: &str) -> Result<Option<Uuid>> {
    Ok(sqlx::query_scalar("select id from e_stored_value_account where tenant_id = $1 and code_hash = $2")
        .bind(hc.ctx.tenant)
        .bind(hash)
        .fetch_optional(&mut **hc.tx)
        .await?)
}

fn fresh(row: &Doc) -> Option<String> {
    s(row, "stored_value_code").filter(|c| !c.starts_with('•')).map(str::to_string)
}

/// Before a sale is kept: each code typed is replaced by its last four characters. A line's code
/// names the card topped up, or a new card (its hash kept for the invoice); a tender's code (and
/// PIN) names the card paid with, or on a return the card given back onto (a new card when unknown).
pub(crate) async fn prepare(hc: &mut HookCtx<'_>, doc: &mut Doc, profile: &Profile) -> Result<()> {
    let tenant = hc.ctx.tenant;
    let mut items = rows(doc, "items");
    let mut errors = Vec::new();
    for (i, r) in items.iter_mut().enumerate() {
        if id(r, "stored_value_kind").is_none() {
            continue;
        }
        if let Some(code) = fresh(r) {
            let sec = sv::secret(tenant, &code, s(r, "stored_value_pin")).map_err(|e| Error::field(format!("items.{i}.stored_value_code"), e.to_string()))?;
            match by_code(hc, &sec.hash).await? {
                Some(acc) => {
                    set(r, "stored_value_account", acc.to_string());
                    set(r, "stored_value_secret", Value::Null);
                }
                None => {
                    set(r, "stored_value_account", Value::Null);
                    set(r, "stored_value_secret", format!("{}:{}:{}", sec.hash, sec.hint, sec.pin_hash.unwrap_or_default()));
                }
            }
            set(r, "stored_value_code", sv::masked(&sec.hint));
        }
        set(r, "stored_value_pin", Value::Null);
        if id(r, "stored_value_account").is_none() && s(r, "stored_value_secret").is_none() {
            errors.push(FieldError::new("stored_value_code", "scan or type the card's code").in_row("items", i));
        }
    }
    set(doc, "items", crate::rows_value(items));
    let ret = b(doc, "is_return");
    let mut payments = rows(doc, "payments");
    for (i, p) in payments.iter_mut().enumerate() {
        let Some((mode, _)) = id(p, "mode_of_payment").and_then(|m| profile.mode(m)) else { continue };
        if mode.kind != Kind::StoredValue {
            continue;
        }
        let kind = id(&mode.doc, "stored_value_kind").ok_or_else(|| Error::invalid(format!("{} names no stored value kind", mode.name)))?;
        if let Some(code) = fresh(p) {
            let pin = s(p, "stored_value_pin").map(str::to_string);
            let sec = sv::secret(tenant, &code, pin.as_deref()).map_err(|e| Error::field(format!("payments.{i}.stored_value_code"), e.to_string()))?;
            let (acc, secret) = if ret {
                match by_code(hc, &sec.hash).await? {
                    Some(a) => (Some(a), None),
                    None => (None, Some(format!("{}:{}:{}", sec.hash, sec.hint, sec.pin_hash.unwrap_or_default()))),
                }
            } else {
                (Some(sv::find(hc.kernel, hc.ctx, hc.tx, Some(kind), &code, pin.as_deref()).await?), None)
            };
            set(p, "stored_value_account", acc.map(|a| json!(a.to_string())).unwrap_or(Value::Null));
            set(p, "stored_value_secret", secret.map(Value::String).unwrap_or(Value::Null));
            set(p, "stored_value_code", sv::masked(&sec.hint));
        }
        set(p, "stored_value_pin", Value::Null);
        if id(p, "stored_value_account").is_none() && !(ret && s(p, "stored_value_secret").is_some()) {
            errors.push(FieldError::new("stored_value_code", "scan or type the card's code").in_row("payments", i));
        }
    }
    set(doc, "payments", crate::rows_value(payments));
    if errors.is_empty() { Ok(()) } else { Err(Error::Validation(errors)) }
}

/// Whether a sale loads, takes or gives back stored value.
pub(crate) fn touches(doc: &Doc) -> bool {
    rows(doc, "items").iter().any(|r| id(r, "stored_value_kind").is_some())
        || rows(doc, "payments").iter().any(|p| s(p, "mode_type").and_then(Kind::parse) == Some(Kind::StoredValue))
}

/// A sale made offline: each card tender is held to what its payment method lets a till take
/// offline, and takes what the card holds now; the rest is the sale's shortfall (amount, card).
pub(crate) async fn offline(hc: &mut HookCtx<'_>, doc: &mut Doc, profile: &Profile) -> Result<Vec<(Decimal, Uuid)>> {
    let mut short = Vec::new();
    if !b(doc, "sold_offline") || b(doc, "is_return") {
        return Ok(short);
    }
    let on = ferrum_domain::util::date(doc, "posting_date")?;
    let mut payments = rows(doc, "payments");
    for p in payments.iter_mut() {
        let Some((mode, _)) = id(p, "mode_of_payment").and_then(|m| profile.mode(m)) else { continue };
        if mode.kind != Kind::StoredValue {
            continue;
        }
        let want = d(p, "amount");
        let limit = d(&mode.doc, "offline_limit");
        if want > limit {
            return Err(Error::field(
                "payments",
                format!("{} is taken offline up to {} only: the till cannot see the card's balance without the connection", mode.name, limit.normalize()),
            ));
        }
        let Some(account) = id(p, "stored_value_account") else { continue };
        let acc = sv::lock(hc.ctx, hc.tx, account).await?;
        let live = acc.state.as_deref().is_none_or(|st| st == "Active") && acc.expires_on.is_none_or(|e| e >= on);
        let take = if live { want.min(acc.balance()) } else { Decimal::ZERO };
        if take < want {
            set(p, "amount", money(take));
            short.push((want - take, account));
        }
    }
    // A card that held nothing leaves no payment, only its shortfall.
    payments.retain(|p| !(s(p, "mode_type").and_then(Kind::parse) == Some(Kind::StoredValue) && d(p, "amount").is_zero()));
    set(doc, "payments", crate::rows_value(payments));
    Ok(short)
}

/// After the sale's own invoice (credit note) is made: each card tender pays it from the card, or,
/// on a return, puts the refund onto the card (a new one for a code not known yet), by a submitted
/// payment entry; the row keeps the payment and what is left on the card.
pub(crate) async fn settle(hc: &mut HookCtx<'_>, doc: &Doc, invoice: Uuid) -> Result<()> {
    let ret = b(doc, "is_return");
    let sctx = elevated(hc.ctx);
    for p in rows(doc, "payments") {
        if s(&p, "mode_type").and_then(Kind::parse) != Some(Kind::StoredValue) {
            continue;
        }
        let amount = d(&p, "amount").abs();
        if amount.is_zero() {
            continue;
        }
        let mode = get(hc.kernel, hc.ctx, hc.tx, "ModeOfPayment", id(&p, "mode_of_payment").unwrap_or_default()).await?;
        let account = id(&p, "stored_value_account");
        let mut v = json!({"company": doc.get("company"), "posting_date": doc.get("posting_date"), "customer": doc.get("customer"),
            "payment_type": if ret { "Pay" } else { "Receive" }, "is_refund": ret, "paid_amount": amount.to_string(),
            "references": [{"invoice": invoice.to_string(), "allocated_amount": amount.to_string()}],
            "remarks": format!("Register sale {}", s(doc, "number").unwrap_or_default())});
        match account {
            Some(a) => v["stored_value_account"] = json!(a.to_string()),
            None => v["stored_value_kind"] = mode.get("stored_value_kind").cloned().unwrap_or(Value::Null),
        }
        let draft = hc.kernel.insert_tx(&sctx, hc.tx, "PaymentEntry", v.as_object().cloned().unwrap_or_default()).await?;
        let pid = id(&draft, "id").ok_or_else(|| Error::internal("no id"))?;
        if account.is_none() {
            // A new card: its code reaches the payment as the till kept it (its hash), never typed again.
            sqlx::query("update e_payment_entry set stored_value_code = $3, stored_value_secret = $4 where tenant_id = $1 and id = $2")
                .bind(hc.ctx.tenant)
                .bind(pid)
                .bind(p.get("stored_value_code").and_then(Value::as_str))
                .bind(p.get("stored_value_secret").and_then(Value::as_str))
                .execute(&mut **hc.tx)
                .await?;
        }
        hc.kernel.submit_tx(&sctx, hc.tx, "PaymentEntry", pid, None).await?;
        let (acc, left): (Uuid, Decimal) = sqlx::query_as(
            "select a.id, coalesce(a.balance, 0) from stored_value_entry e join e_stored_value_account a on a.tenant_id = e.tenant_id and a.id = e.account_id \
             where e.tenant_id = $1 and e.source_entity = 'PaymentEntry' and e.source_id = $2 order by e.created_at desc limit 1",
        )
        .bind(hc.ctx.tenant)
        .bind(pid)
        .fetch_one(&mut **hc.tx)
        .await?;
        sqlx::query(
            "update e_pos_invoice__payments set stored_value_payment = $3, stored_value_account = $4, stored_value_balance = $5 where tenant_id = $1 and id = $2",
        )
        .bind(hc.ctx.tenant)
        .bind(id(&p, "id"))
        .bind(pid)
        .bind(acc)
        .bind(left)
        .execute(&mut **hc.tx)
        .await?;
    }
    Ok(())
}
