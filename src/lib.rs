//! Point of sale: profiles, opening and closing, fast offline-tolerant invoices with split payments, consolidation into the books.
//!
//! A register (`PosProfile`) is worked in cashier sessions (`PosOpeningEntry` → `PosClosingEntry`).
//! POS invoices are priced by the selling engine, take their stock out at once and settle
//! their tenders on the spot; closing a session consolidates them into sales invoices, credit
//! notes and one settlement entry per closing, so the books see one invoice per customer
//! instead of every receipt. Loyalty points are a ledger of their own (`LoyaltyPointEntry`).

mod closing;
mod invoice;
mod logic;
mod loyalty;
mod masters;
mod reports;
mod session;
pub mod site;

pub use logic::Kind;

use ferrum_domain::reports::ReportSource;
use ferrum_domain::util::{Company, b, get, id, rows, s};
use ferrum_kernel::{Ctx, Doc, Error, HookCtx, HookRegistry, Kernel, Result, Tx};
use serde_json::Value;
use std::sync::Arc;
use uuid::Uuid;

/// Registers this package's document hooks.
pub fn register(h: &mut HookRegistry) {
    h.register("ModeOfPayment", Arc::new(masters::ModeOfPaymentHook))
        .register("PosProfile", Arc::new(masters::PosProfileHook))
        .register("ItemBarcode", Arc::new(masters::ItemBarcodeHook))
        .register("LoyaltyPointEntry", Arc::new(masters::PointEntryHook))
        .register("PosOpeningEntry", Arc::new(session::OpeningHook))
        .register("PosCashMovement", Arc::new(session::CashMovementHook))
        .register("PosInvoice", Arc::new(invoice::PosInvoiceHook))
        .register("PosClosingEntry", Arc::new(closing::ClosingHook))
        .register("SalesInvoice", Arc::new(closing::ConsolidatedGuard))
        .add_site("pos", Arc::new(site::PosSite));
}

/// This package's reports.
pub fn reports() -> Vec<Arc<dyn ReportSource>> {
    vec![Arc::new(reports::PosReports)]
}

/// Periodic upkeep: every minute, on one replica at a time (advisory lock); must be idempotent and cheap.
pub async fn maintenance(k: &Kernel) -> Result<()> {
    loyalty::expire_points(k).await
}

/// POS managers (and engine contexts) may exceed cashier limits and act in anyone's session.
pub(crate) fn is_manager(ctx: &Ctx) -> bool {
    ctx.is_system || ctx.has_role("POS Manager")
}

/// A mode of payment as the register uses it.
#[derive(Debug, Clone)]
pub(crate) struct Mode {
    pub id: Uuid,
    pub name: String,
    pub kind: Kind,
    pub doc: Doc,
}

impl Mode {
    pub async fn load(k: &Kernel, ctx: &Ctx, tx: &mut Tx, mode: Uuid) -> Result<Mode> {
        let doc = get(k, ctx, tx, "ModeOfPayment", mode).await?;
        let kind = s(&doc, "mode_type").and_then(Kind::parse).ok_or_else(|| Error::invalid("mode of payment without a valid type"))?;
        Ok(Mode { id: mode, name: s(&doc, "mode_name").unwrap_or_default().to_string(), kind, doc })
    }

    /// The account this mode settles into for `co`: its row for the company, else the company's
    /// cash or bank account for those types. Credit and loyalty points have none of their own.
    pub fn account(&self, co: &Company) -> Result<Uuid> {
        let own = rows(&self.doc, "accounts").iter().find(|r| id(r, "company") == Some(co.id)).and_then(|r| id(r, "account"));
        let fallback = match self.kind {
            Kind::Cash => co.account("default_cash_account"),
            Kind::Bank => co.account("default_bank_account"),
            _ => None,
        };
        own.or(fallback).ok_or_else(|| {
            Error::invalid(format!("set the account of payment method {} for company {} (Mode of Payment → Accounts per Company)", self.name, co.name()))
        })
    }
}

/// A register profile with its payment methods.
#[derive(Debug, Clone)]
pub(crate) struct Profile {
    pub id: Uuid,
    pub doc: Doc,
    pub warehouse: Uuid,
    /// `(mode, allowed in returns)` in profile order.
    pub modes: Vec<(Mode, bool)>,
}

impl Profile {
    pub async fn load(k: &Kernel, ctx: &Ctx, tx: &mut Tx, profile: Uuid) -> Result<Profile> {
        let doc = get(k, ctx, tx, "PosProfile", profile).await?;
        let warehouse = id(&doc, "warehouse").ok_or_else(|| Error::invalid("the POS profile has no warehouse"))?;
        let mut modes = Vec::new();
        for r in rows(&doc, "payments") {
            if let Some(m) = id(&r, "mode_of_payment") {
                modes.push((Mode::load(k, ctx, tx, m).await?, b(&r, "allow_in_returns")));
            }
        }
        Ok(Profile { id: profile, doc, warehouse, modes })
    }

    pub fn mode(&self, mode: Uuid) -> Option<&(Mode, bool)> {
        self.modes.iter().find(|(m, _)| m.id == mode)
    }

    /// The drawer's cash mode: the first Cash-type payment method.
    pub fn cash_mode(&self) -> Option<&Mode> {
        self.modes.iter().map(|(m, _)| m).find(|m| m.kind == Kind::Cash)
    }

    pub fn name(&self) -> &str {
        s(&self.doc, "profile_name").unwrap_or_default()
    }

    /// Whether `email` may work this register (an empty user list admits every cashier).
    pub fn admits(&self, email: &str) -> bool {
        let users = rows(&self.doc, "users");
        users.is_empty() || users.iter().any(|u| s(u, "user").is_some_and(|x| x.eq_ignore_ascii_case(email)))
    }
}

/// `Some(decimal)` when the field holds a value (null and missing are `None`).
pub(crate) fn opt_dec(doc: &Doc, k: &str) -> Option<rust_decimal::Decimal> {
    doc.get(k).filter(|v| !v.is_null()).and_then(|v| ferrum_kernel::value::parse_decimal(v).ok())
}

pub(crate) fn rows_value(rows: Vec<Doc>) -> Value {
    Value::Array(rows.into_iter().map(Value::Object).collect())
}

/// The id of the user's session, if open, at `profile`.
pub(crate) async fn open_session(hc: &mut HookCtx<'_>, profile: Uuid, user: &str) -> Result<Option<Uuid>> {
    let found: Option<Uuid> = sqlx::query_scalar(
        "select id from e_pos_opening_entry where tenant_id = $1 and pos_profile = $2 and lower(\"user\") = lower($3) and docstatus = 1 and status = 'Open' limit 1",
    )
    .bind(hc.ctx.tenant)
    .bind(profile)
    .bind(user)
    .fetch_optional(&mut **hc.tx)
    .await?;
    Ok(found)
}

/// Loads a session, locking its row when the caller is about to change what belongs to it, and
/// checks it is open: sales, cash movements and the closing serialize on this lock, so nothing
/// can slip into a session while it is being closed.
pub(crate) async fn live_session(hc: &mut HookCtx<'_>, session: Uuid, lock: bool) -> Result<Doc> {
    let doc = hc.kernel.get_tx(&ferrum_domain::util::sys(hc.ctx), hc.tx, "PosOpeningEntry", session, lock).await?;
    if s(&doc, "status") != Some("Open") {
        return Err(Error::field(
            "pos_opening_entry",
            format!("session {} is {}; open a new session", s(&doc, "number").unwrap_or_default(), s(&doc, "status").unwrap_or("not open").to_lowercase()),
        ));
    }
    Ok(doc)
}

include!(concat!(env!("OUT_DIR"), "/packages.rs"));
include!(concat!(env!("OUT_DIR"), "/ui.rs"));

/// This app's manifest (`app.yaml`).
pub const MANIFEST: &str = include_str!("../app.yaml");

/// This app's metadata packages, embedded at build time.
pub fn packages() -> std::result::Result<Vec<ferrum_meta::Package>, ferrum_meta::MetaError> {
    ferrum_meta::catalog::load_embedded(EMBEDDED)
}
