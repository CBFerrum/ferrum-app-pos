//! Cashier sessions and the cash that moves in and out of the drawer during them.

use crate::{Kind, Mode, Profile, is_manager, open_session};
use async_trait::async_trait;
use ferrum_app_erp::ledger::{self, Entry, Line};
use ferrum_domain::util::{company, d, date, get, id, rows, s, set, sys};
use ferrum_kernel::{Doc, DocHook, Error, FieldError, HookCtx, Result};
use serde_json::{Value, json};

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The unique `open_key` index lets one session be open per register and cashier, even when
/// two devices open at the same moment.
pub(crate) fn open_key(profile: &str, user: &str) -> String {
    format!("{profile}:{}", user.to_lowercase())
}

pub struct OpeningHook;

#[async_trait]
impl DocHook for OpeningHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        if s(doc, "user").is_none() {
            set(doc, "user", hc.ctx.email.to_lowercase());
        }
        if d(doc, "docstatus").is_zero() {
            set(doc, "status", "Draft");
        }
        Ok(())
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let profile = Profile::load(hc.kernel, hc.ctx, hc.tx, id(doc, "pos_profile").ok_or_else(|| Error::field("pos_profile", "is required"))?).await?;
        let user = s(doc, "user").unwrap_or_default();
        let mut errors = Vec::new();
        if ferrum_domain::util::b(&profile.doc, "disabled") {
            errors.push(FieldError::new("pos_profile", "this register is disabled"));
        }
        if !user.eq_ignore_ascii_case(&hc.ctx.email) && !is_manager(hc.ctx) {
            errors.push(FieldError::new("user", "only a POS Manager can open a session for someone else"));
        }
        if !profile.admits(user) {
            errors.push(FieldError::new("user", format!("{user} is not allowed at register {}", profile.name())));
        }
        for (i, r) in rows(doc, "balance_details").iter().enumerate() {
            let ok = id(r, "mode_of_payment").and_then(|m| profile.mode(m)).is_some_and(|(m, _)| m.kind.is_money());
            if !ok {
                errors.push(FieldError::new("mode_of_payment", "not a cash or card payment method of this register").in_row("balance_details", i));
            }
        }
        if errors.is_empty() { Ok(()) } else { Err(Error::Validation(errors)) }
    }

    async fn before_submit(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        let profile = s(doc, "pos_profile").unwrap_or_default().to_string();
        let user = s(doc, "user").unwrap_or_default().to_string();
        if let Some(open) = open_session(hc, profile.parse().map_err(|_| Error::field("pos_profile", "is required"))?, &user).await?
            && Some(open) != id(doc, "id")
        {
            return Err(Error::invalid(format!("{user} already has an open session at this register; close it first")));
        }
        set(doc, "open_key", open_key(&profile, &user));
        set(doc, "status", "Open");
        set(doc, "period_start", now());
        Ok(())
    }

    async fn before_cancel(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        if s(doc, "status") == Some("Closed") {
            return Err(Error::invalid("this session is closed; cancel its closing entry first"));
        }
        let busy: bool = sqlx::query_scalar(
            "select exists(select 1 from e_pos_invoice where tenant_id = $1 and pos_opening_entry = $2 and docstatus = 1) \
             or exists(select 1 from e_pos_cash_movement where tenant_id = $1 and pos_opening_entry = $2 and docstatus = 1)",
        )
        .bind(hc.ctx.tenant)
        .bind(id(doc, "id"))
        .fetch_one(&mut **hc.tx)
        .await?;
        if busy {
            return Err(Error::invalid("this session has sales or cash movements; close it with a closing entry instead"));
        }
        Ok(())
    }

    async fn on_cancel(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let mut v = Doc::new();
        v.insert("status".into(), json!("Cancelled"));
        v.insert("open_key".into(), Value::Null);
        hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "PosOpeningEntry", id(doc, "id").unwrap_or_default(), v).await
    }
}

pub struct CashMovementHook;

impl CashMovementHook {
    async fn mode(hc: &mut HookCtx<'_>, doc: &Doc) -> Result<Mode> {
        let m = id(doc, "mode_of_payment").ok_or_else(|| Error::field("mode_of_payment", "is required"))?;
        Mode::load(hc.kernel, hc.ctx, hc.tx, m).await
    }
}

#[async_trait]
impl DocHook for CashMovementHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        if id(doc, "mode_of_payment").is_none()
            && let Some(sid) = id(doc, "pos_opening_entry")
        {
            let session = get(hc.kernel, hc.ctx, hc.tx, "PosOpeningEntry", sid).await?;
            if let Some(p) = id(&session, "pos_profile") {
                let profile = Profile::load(hc.kernel, hc.ctx, hc.tx, p).await?;
                if let Some(cash) = profile.cash_mode() {
                    set(doc, "mode_of_payment", cash.id.to_string());
                }
            }
        }
        Ok(())
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let sid = id(doc, "pos_opening_entry").ok_or_else(|| Error::field("pos_opening_entry", "is required"))?;
        let session = crate::live_session(hc, sid, false).await?;
        if !s(&session, "user").is_some_and(|u| u.eq_ignore_ascii_case(&hc.ctx.email)) && !is_manager(hc.ctx) {
            return Err(Error::Forbidden("only the session's cashier or a POS Manager can move cash in this drawer".into()));
        }
        if Self::mode(hc, doc).await?.kind != Kind::Cash {
            return Err(Error::field("mode_of_payment", "cash movements are for cash payment methods"));
        }
        if let Some(a) = id(doc, "account") {
            let acc = get(hc.kernel, hc.ctx, hc.tx, "Account", a).await?;
            if id(&acc, "company") != id(doc, "company") {
                return Err(Error::field("account", "belongs to another company"));
            }
        }
        Ok(())
    }

    async fn before_submit(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        crate::live_session(hc, id(doc, "pos_opening_entry").unwrap_or_default(), true).await.map(|_| ())
    }

    /// Cash In: drawer debit, counter account credit; Cash Out the reverse.
    async fn on_submit(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let co = company(hc.kernel, hc.ctx, hc.tx, id(doc, "company").unwrap_or_default()).await?;
        let drawer = Self::mode(hc, doc).await?.account(&co)?;
        let counter = id(doc, "account").ok_or_else(|| Error::field("account", "is required"))?;
        let amount = if s(doc, "movement_type") == Some("Cash Out") { -d(doc, "amount") } else { d(doc, "amount") };
        let on = date(doc, "posting_date")?;
        let mut entry = Entry::new(co.id, on, "PosCashMovement", id(doc, "id").unwrap_or_default(), s(doc, "number").map(str::to_string));
        entry.memo = s(doc, "reason").map(str::to_string);
        entry.lines.push(Line::new(drawer, amount, &co.currency_code));
        entry.lines.push(Line::new(counter, -amount, &co.currency_code).cost_center(id(doc, "cost_center")));
        ledger::post(hc.tx, hc.ctx, entry, co.precision).await?;
        Ok(())
    }

    /// The closing counts on these amounts, so they are fixed once the session is closed.
    async fn before_cancel(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        crate::live_session(hc, id(doc, "pos_opening_entry").unwrap_or_default(), true).await.map(|_| ())
    }

    async fn on_cancel(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let co = company(hc.kernel, hc.ctx, hc.tx, id(doc, "company").unwrap_or_default()).await?;
        let (on, _) = ledger::reversal_point(hc.tx, hc.ctx.tenant, co.id, doc).await?;
        ledger::reverse(hc.tx, hc.ctx, "PosCashMovement", id(doc, "id").unwrap_or_default(), on, co.precision).await?;
        Ok(())
    }
}
