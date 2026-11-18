//! Register set-up: payment methods, profiles, barcodes, and the read-only points ledger; and the sales a till sets aside.

use crate::{Mode, Profile, is_manager};
use async_trait::async_trait;
use ferrum_domain::util::{b, get, id, rows, s, set};
use ferrum_kernel::{Doc, DocHook, Error, FieldError, HookCtx, Result};
use serde_json::Value;
use std::collections::HashSet;
use uuid::Uuid;

/// Accounts on another company's books can never be posted to (the journal refuses them), so
/// catch the mistake when the master is saved instead of at the first closing.
async fn same_company(hc: &mut HookCtx<'_>, entity: &str, record: uuid::Uuid, company: Option<uuid::Uuid>) -> Result<bool> {
    let doc = get(hc.kernel, hc.ctx, hc.tx, entity, record).await?;
    Ok(id(&doc, "company") == company)
}

pub struct ModeOfPaymentHook;

#[async_trait]
impl DocHook for ModeOfPaymentHook {
    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let mut errors = Vec::new();
        let mut companies = HashSet::new();
        for (i, r) in rows(doc, "accounts").iter().enumerate() {
            // One row per company: ERP's instrument accounts and the till's account are read from the first.
            let Some(company) = id(r, "company") else { continue };
            if !companies.insert(company) {
                errors.push(FieldError::new("company", "one account per company").in_row("accounts", i));
            } else if let Some(account) = id(r, "account")
                && !same_company(hc, "Account", account, Some(company)).await?
            {
                errors.push(FieldError::new("account", "belongs to another company").in_row("accounts", i));
            }
        }
        if errors.is_empty() { Ok(()) } else { Err(Error::Validation(errors)) }
    }
}

pub struct PosProfileHook;

#[async_trait]
impl DocHook for PosProfileHook {
    async fn before_validate(&self, _hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        if let Some(p) = s(doc, "invoice_prefix").map(|p| p.trim().to_uppercase()) {
            set(doc, "invoice_prefix", p);
        }
        Ok(())
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let company = id(doc, "company");
        let mut errors = Vec::new();
        if let Some(w) = id(doc, "warehouse")
            && !same_company(hc, "Warehouse", w, company).await?
        {
            errors.push(FieldError::new("warehouse", "belongs to another company"));
        }
        if let Some(t) = id(doc, "tax_template")
            && !same_company(hc, "TaxTemplate", t, company).await?
        {
            errors.push(FieldError::new("tax_template", "belongs to another company"));
        }
        for f in ["write_off_account", "cash_difference_account"] {
            if let Some(a) = id(doc, f)
                && !same_company(hc, "Account", a, company).await?
            {
                errors.push(FieldError::new(f, "belongs to another company"));
            }
        }
        if s(doc, "invoice_prefix").is_some_and(|p| !p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/'))) {
            errors.push(FieldError::new("invoice_prefix", "use letters, digits, '-', '_' or '/'"));
        }
        let mut seen = HashSet::new();
        let mut defaults = 0;
        for (i, r) in rows(doc, "payments").iter().enumerate() {
            let Some(m) = id(r, "mode_of_payment") else { continue };
            if !seen.insert(m) {
                errors.push(FieldError::new("mode_of_payment", "listed twice").in_row("payments", i));
                continue;
            }
            let mode = Mode::load(hc.kernel, hc.ctx, hc.tx, m).await?;
            if b(&mode.doc, "disabled") {
                errors.push(FieldError::new("mode_of_payment", format!("{} is disabled", mode.name)).in_row("payments", i));
            }
            if b(r, "is_default") {
                defaults += 1;
                if !mode.kind.is_money() {
                    errors.push(FieldError::new("is_default", "the default must be cash, a card or another money tender").in_row("payments", i));
                }
            }
        }
        if defaults > 1 {
            errors.push(FieldError::new("payments", "only one payment method can be the default"));
        }
        if errors.is_empty() { Ok(()) } else { Err(Error::Validation(errors)) }
    }

    /// `set_pin`: the caller sets their own till PIN (limits.rs).
    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, _doc: &Doc, params: &Value) -> Result<Option<Value>> {
        if name != "set_pin" {
            return Ok(None);
        }
        crate::limits::set_pin(hc, params).await.map(Some)
    }
}

pub struct ItemBarcodeHook;

#[async_trait]
impl DocHook for ItemBarcodeHook {
    async fn before_validate(&self, _hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        if let Some(code) = s(doc, "barcode").map(|c| c.trim().to_string()) {
            set(doc, "barcode", code);
        }
        Ok(())
    }

    /// A scan must resolve to one item: the code may not be another item's own barcode or code.
    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let (Some(code), Some(item)) = (s(doc, "barcode"), id(doc, "item")) else { return Ok(()) };
        let clash: Option<String> =
            sqlx::query_scalar("select item_code from e_item where tenant_id = $1 and id <> $2 and (barcode = $3 or item_code = $3) limit 1")
                .bind(hc.ctx.tenant)
                .bind(item)
                .bind(code)
                .fetch_optional(&mut **hc.tx)
                .await?;
        match clash {
            Some(other) => Err(Error::field("barcode", format!("already identifies item {other}"))),
            None => Ok(()),
        }
    }
}

/// Loyalty points move only with the sales, returns and expiry that cause them.
pub struct PointEntryHook;

fn engine_only(hc: &HookCtx<'_>) -> Result<()> {
    if hc.ctx.is_system { Ok(()) } else { Err(Error::Forbidden("loyalty points are posted by sales, returns and expiry; they cannot be edited".into())) }
}

#[async_trait]
impl DocHook for PointEntryHook {
    async fn validate(&self, hc: &mut HookCtx<'_>, _doc: &Doc) -> Result<()> {
        engine_only(hc)
    }

    async fn before_delete(&self, hc: &mut HookCtx<'_>, _doc: &Doc) -> Result<()> {
        engine_only(hc)
    }
}

/// One row per role for every register, and one per role and register, so which applies is never
/// in doubt.
pub struct RoleLimitHook;

#[async_trait]
impl DocHook for RoleLimitHook {
    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let role = s(doc, "role").unwrap_or_default().trim().to_string();
        let register = id(doc, "pos_profile");
        let twin: Option<Uuid> = sqlx::query_scalar(
            "select id from e_pos_role_limit where tenant_id = $1 and lower(trim(role)) = lower($2) and pos_profile is not distinct from $3 and id <> $4 limit 1",
        )
        .bind(hc.ctx.tenant)
        .bind(&role)
        .bind(register)
        .bind(id(doc, "id"))
        .fetch_optional(&mut **hc.tx)
        .await?;
        if twin.is_none() {
            return Ok(());
        }
        let place = match register {
            Some(p) => format!("register {}", s(&get(hc.kernel, hc.ctx, hc.tx, "PosProfile", p).await?, "profile_name").unwrap_or_default()),
            None => "every register".to_string(),
        };
        Err(Error::field("role", format!("{role} already has limits for {place}: change that row instead of adding another")))
    }
}

/// Records only the engine writes (approvals at the till).
pub struct EngineOnly;

#[async_trait]
impl DocHook for EngineOnly {
    async fn validate(&self, hc: &mut HookCtx<'_>, _doc: &Doc) -> Result<()> {
        if hc.ctx.is_system { Ok(()) } else { Err(Error::Forbidden("written by the till itself; it cannot be edited".into())) }
    }

    async fn before_delete(&self, hc: &mut HookCtx<'_>, _doc: &Doc) -> Result<()> {
        if hc.ctx.is_system { Ok(()) } else { Err(Error::Forbidden("written by the till itself; it cannot be deleted".into())) }
    }
}

/// The most lines a held basket keeps, and the most it may weigh.
const HELD_LINES: usize = 500;
const HELD_BYTES: usize = 262_144;

/// A sale set aside at a till (`PosHeldSale`): the holder is the caller, whatever was sent; the register must admit them
/// (or they are a POS Manager); the basket is bounded and never holds a card's code or PIN. It is made and deleted, never
/// edited. An erasure blanks its basket without these checks (`set_values`).
pub struct HeldSaleHook;

#[async_trait]
impl DocHook for HeldSaleHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        set(doc, "cashier", hc.ctx.email.to_lowercase());
        let lines = doc.get("cart").and_then(|c| c.get("lines")).and_then(serde_json::Value::as_array).map_or(0, Vec::len);
        set(doc, "line_count", lines as i64);
        Ok(())
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let profile = Profile::load(hc.kernel, hc.ctx, hc.tx, id(doc, "pos_profile").ok_or_else(|| Error::field("pos_profile", "is required"))?).await?;
        if !profile.admits(&hc.ctx.email) && !is_manager(hc.ctx) {
            return Err(Error::Forbidden(format!("{} is not allowed at register {}", hc.ctx.email, profile.name())));
        }
        let cart = doc.get("cart").filter(|c| !c.is_null()).ok_or_else(|| Error::field("cart", "is required"))?;
        let qty = |l: &Value| {
            l.get("qty").filter(|q| !q.is_null()).and_then(|q| ferrum_kernel::value::parse_decimal(q).ok()).is_some_and(|q| q > rust_decimal::Decimal::ZERO)
        };
        let item = |l: &Value| l.get("item").and_then(Value::as_str).is_some_and(|i| !i.trim().is_empty());
        let lines = cart.get("lines").and_then(Value::as_array).filter(|ls| (1..=HELD_LINES).contains(&ls.len()));
        if !lines.is_some_and(|ls| ls.iter().all(|l| l.is_object() && item(l) && qty(l))) {
            return Err(Error::field("cart", format!("a basket of 1 to {HELD_LINES} lines, each an item and a quantity above zero")));
        }
        if serde_json::to_vec(cart).map_or(true, |b| b.len() > HELD_BYTES) {
            return Err(Error::field("cart", "is too large to keep"));
        }
        let card = |l: &Value| ["stored_value_code", "stored_value_pin"].iter().any(|f| l.get(f).is_some_and(|v| !v.is_null() && v != ""));
        if lines.is_some_and(|ls| ls.iter().any(card)) {
            return Err(Error::field("cart", "a card's code is never held"));
        }
        Ok(())
    }
}
