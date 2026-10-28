//! Register set-up: payment methods, profiles, barcodes, and the read-only points ledger.

use crate::Mode;
use async_trait::async_trait;
use ferrum_domain::util::{b, get, id, rows, s, set};
use ferrum_kernel::{Doc, DocHook, Error, FieldError, HookCtx, Result};
use std::collections::HashSet;

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
            let (Some(company), Some(account)) = (id(r, "company"), id(r, "account")) else { continue };
            if !companies.insert(company) {
                errors.push(FieldError::new("company", "one account per company").in_row("accounts", i));
            } else if !same_company(hc, "Account", account, Some(company)).await? {
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
