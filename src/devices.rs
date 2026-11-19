//! A register's devices (S16, POS-DEV): its receipt printers and the cash drawer each may open, a scale, a customer
//! display. The till reaches a device from the browser (WebUSB, Web Serial) or on a second screen; through an IoT Edge
//! gateway comes later. The server decides when the drawer opens and records each opening (`PosDrawerEvent`): for a sale
//! paid in cash, once, when its original goes to a printer with a drawer (`receipt.rs`); without a sale (No Sale) only
//! with the right to or another person's approval, and one of the business's reasons. A tampered till could still send
//! a drawer's bytes itself: what the server guarantees is that every opening it causes is recorded with who and why.
//!
//! The fiscal seam: a register that names a fiscal device's operation (a country's add-on) sends each sale to it once,
//! after the sale commits (`Fiscalise`), and the sale's receipt waits for the device's answer.

use crate::Profile;
use crate::logic::Act;
use ferrum_domain::util::{b, d, elevated, id, rows, s, sys};
use ferrum_kernel::capability::Invocation;
use ferrum_kernel::jobs::{Job, JobHandler, NewJob};
use ferrum_kernel::{Doc, Error, FieldError, HookCtx, Kernel, Result};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use uuid::Uuid;

/// A register's device (`PosDevice`): its kind and the way the till reaches it hold together.
pub struct DeviceHook;

#[async_trait::async_trait]
impl ferrum_kernel::DocHook for DeviceHook {
    async fn validate(&self, _hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let mut errors = Vec::new();
        let kind = s(doc, "kind").unwrap_or_default();
        let route = s(doc, "route").unwrap_or_default();
        // A second screen shows a customer display; printers and scales are reached over USB or serial.
        let fits = match kind {
            "Customer Display" => matches!(route, "Second Screen" | "Browser Serial"),
            "Scale" => route == "Browser Serial",
            _ => matches!(route, "Browser USB" | "Browser Serial"),
        };
        if !fits {
            errors.push(FieldError::new("route", format!("a {} is not reached this way", kind.to_lowercase())));
        }
        if kind != "Receipt Printer" && s(doc, "cash_drawer").is_some_and(|c| c != "None") {
            errors.push(FieldError::new("cash_drawer", "only a receipt printer opens a cash drawer"));
        }
        if errors.is_empty() { Ok(()) } else { Err(Error::Validation(errors)) }
    }
}

/// A receipt printer of a register, in use, and whether it opens a drawer.
pub(crate) struct Printer {
    pub(crate) id: Uuid,
    pub(crate) drawer: bool,
}

/// The receipt printer `given` names, of register `reg`; refused when it is not one.
pub(crate) async fn printer(hc: &mut HookCtx<'_>, reg: &Profile, given: &str) -> Result<Printer> {
    let bad = || Error::field("device", "is not a receipt printer of this register");
    let pid: Uuid = given.parse().map_err(|_| bad())?;
    let dev = hc.kernel.get_tx(&sys(hc.ctx), hc.tx, "PosDevice", pid, false).await.map_err(|_| bad())?;
    if id(&dev, "profile") != Some(reg.id) || s(&dev, "kind") != Some("Receipt Printer") || b(&dev, "disabled") {
        return Err(bad());
    }
    Ok(Printer { id: pid, drawer: s(&dev, "cash_drawer").is_some_and(|c| c != "None") })
}

/// Whether a sale took cash: a positive payment by a method of type Cash.
pub(crate) fn cash_taken(sale: &Doc) -> bool {
    rows(sale, "payments").iter().any(|p| s(p, "mode_type") == Some("Cash") && d(p, "amount") > Decimal::ZERO)
}

/// Records that the drawer opens for `sale`, paid in cash, through printer `device`, as its original `event` is issued:
/// once per sale (the sale's row is held). Answers whether it opens now.
pub(crate) async fn opened_for_sale(hc: &mut HookCtx<'_>, sale: &Doc, session: Uuid, device: Uuid, event: &Value) -> Result<bool> {
    let sid = id(sale, "id").ok_or_else(|| Error::internal("a sale without an id"))?;
    let before: Option<Uuid> = sqlx::query_scalar("select id from e_pos_drawer_event where tenant_id = $1 and pos_invoice = $2 and kind = 'Sale'")
        .bind(hc.ctx.tenant)
        .bind(sid)
        .fetch_optional(&mut **hc.tx)
        .await?;
    if before.is_some() {
        return Ok(false);
    }
    let row = json!({"pos_opening_entry": session, "company": id(sale, "company"), "kind": "Sale", "pos_invoice": sid, "receipt_event": event,
                     "cashier": hc.ctx.email.to_lowercase(), "opened_at": chrono::Utc::now().to_rfc3339(), "device": device});
    hc.kernel.insert_tx(&elevated(hc.ctx), hc.tx, "PosDrawerEvent", row.as_object().cloned().unwrap_or_default()).await?;
    Ok(true)
}

/// `open_drawer` of the caller's own open session (No Sale): with one of the business's reasons, by someone whose limits
/// at this till let them, or with another person's approval for it in this session (used once). Recorded before the till
/// opens it; answers the record and `kick` (the till sends the drawer's bytes through its printer).
pub(crate) async fn open_drawer(hc: &mut HookCtx<'_>, session: &Doc, params: &Value) -> Result<Value> {
    let ctx = hc.ctx;
    let me = ctx.email.to_lowercase();
    // A manager may write anyone's session; the drawer is still opened in one's own.
    if s(session, "user").is_none_or(|u| u.to_lowercase() != me) {
        return Err(Error::Forbidden("the drawer is opened in your own session".into()));
    }
    let sid = id(session, "id").ok_or_else(|| Error::internal("a session without an id"))?;
    let reg = Profile::load(hc.kernel, ctx, hc.tx, id(session, "pos_profile").ok_or_else(|| Error::internal("a session without a register"))?).await?;
    let text = |k: &str| params.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
    let reason = crate::receipt::reason_of(hc.tx, ctx.tenant, "No Sale", text("reason"), "choose one of the business's reasons for opening the drawer").await?;
    let device = match text("device") {
        Some(given) => Some(printer(hc, &reg, given).await?.id),
        None => None,
    };
    let approval = text("approval").map(|a| a.parse::<Uuid>().map_err(|_| Error::field("approval", "is an approval's id"))).transpose()?;
    let event = Uuid::now_v7();
    let mut used = None;
    if !crate::limits::at_till(ctx, hc.tx, &reg, sid).await?.open_drawer {
        let covered = match approval {
            Some(a) => crate::limits::covers(hc.tx, ctx.tenant, a, (&me, sid), Act::NoSale, Decimal::ZERO, false, event).await?,
            None => false,
        };
        if !covered {
            return Err(Error::Forbidden("you may not open the drawer without a sale; ask someone who may to approve it".into()));
        }
        crate::limits::use_approvals(hc.tx, ctx.tenant, &approval.into_iter().collect::<Vec<_>>(), event).await?;
        used = approval;
    }
    let row = json!({"id": event, "pos_opening_entry": sid, "company": id(session, "company"), "kind": "No Sale", "cashier": me,
                     "opened_at": chrono::Utc::now().to_rfc3339(), "reason": reason, "approval": used, "device": device});
    hc.kernel.insert_tx(&elevated(ctx), hc.tx, "PosDrawerEvent", row.as_object().cloned().unwrap_or_default()).await?;
    Ok(json!({"event": event, "kick": true}))
}

/// What the fiscal device's job is called.
pub(crate) const FISCALISE: &str = "pos.fiscalise";

/// Queues a sale for its register's fiscal device, once (the job's key is the sale's), in the sale's transaction.
pub(crate) async fn queue_fiscal(hc: &mut HookCtx<'_>, reg: &Profile, sale: Uuid) -> Result<()> {
    if s(&reg.doc, "fiscal_operation").is_none() {
        return Ok(());
    }
    let mut job = NewJob::new(FISCALISE, json!({"sale": sale}));
    job.dedupe_key = Some(format!("pos.fiscal:{sale}"));
    ferrum_kernel::jobs::enqueue(hc.tx, hc.ctx.tenant, Some(hc.ctx.user), job).await?;
    Ok(())
}

/// A sale's turn at its register's fiscal device: the operation the register names, with the sale, as the person who sold
/// it, once per sale (its key); the answer is kept on the sale, where the receipt waits for it. An operation no add-on
/// offers (removed) ends the job with the gate's words, and the receipt keeps waiting.
pub struct Fiscalise;

#[async_trait::async_trait]
impl JobHandler for Fiscalise {
    fn kind(&self) -> &'static str {
        FISCALISE
    }

    fn title(&self) -> &'static str {
        "A sale to the fiscal device"
    }

    async fn run(&self, k: &Kernel, job: &Job) -> Result<Value> {
        let sale: Uuid =
            job.payload.get("sale").and_then(Value::as_str).and_then(|v| v.parse().ok()).ok_or_else(|| Error::invalid("a fiscal job without its sale"))?;
        let system = job.system(k).await?;
        let doc = k.get(&system, "PosInvoice", sale, false).await?;
        if doc.get("fiscal").is_some_and(Value::is_object) {
            return Ok(json!({"done": true}));
        }
        let reg = k.get(&system, "PosProfile", id(&doc, "pos_profile").ok_or_else(|| Error::invalid("a sale without its register"))?, false).await?;
        let Some(operation) = s(&reg, "fiscal_operation") else { return Ok(json!({"no_device": true})) };
        let seller = job.creator(k).await?;
        let answer = k.invoke(&seller, Invocation::new(operation, json!({"sale": sale})).key(format!("pos.fiscal:{sale}"))).await?.result;
        let mut v = Doc::new();
        v.insert("fiscal".into(), answer.clone());
        let mut tx = k.db.tenant_tx(job.tenant_id).await?;
        k.set_values_tx(&system, &mut tx, "PosInvoice", sale, v).await?;
        tx.commit().await?;
        Ok(answer)
    }
}
