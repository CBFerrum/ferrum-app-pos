//! The receipt (PS-10, PS-53, PS-54, PS-57, PS-58): the sale's first printing, copies marked and counted, gift
//! receipts, and the receipt sent to the buyer as a message, each an action of the caller's own open session naming the
//! sale (`print_receipt`, `reprint`, `send_receipt`) and kept as a `PosReceiptEvent`; the page of an event is a read
//! (`GET /paper/{event}`). What the paper says is the document template (`pos.receipt`, `pos.receipt_gift`) and the
//! message template (`pos.receipt_sent`) the workspace edits; this module decides who may have one and keeps the record.
//!
//! The first printing is once per sale (an atomic mark under the sale's lock, so two tills never print two
//! originals); everything after is a copy: who asked, when, for what reason and by whose approval is a
//! `PosReceiptEvent`, the sale counts its copies (`reprints`), and the copy says so on its face.

use crate::logic::Act;
use crate::site::param;
use crate::{Profile, is_manager};
use ferrum_domain::util::{b, elevated, get, id, s, sys};
use ferrum_kernel::documents::{Generate, generate};
use ferrum_kernel::messages::{self, Message, Recipient};
use ferrum_kernel::{Ctx, Doc, Error, HookCtx, Kernel, Result, SiteRequest, SiteResponse};
use serde_json::{Map, Value, json};
use uuid::Uuid;

const RECEIPT: &str = "pos.receipt";
/// The receipt as lines for a receipt printer (the till encodes them).
const RECEIPT_TEXT: &str = "pos.receipt_text";
const GIFT: &str = "pos.receipt_gift";
const MESSAGE: &str = "pos.receipt_sent";

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty())
}

fn uuid_of(v: &Value, key: &str) -> Result<Uuid> {
    text(v, key).and_then(|x| x.parse().ok()).ok_or_else(|| Error::field(key.to_string(), "is required"))
}

/// The page or file `key` renders for `sale`, as the response to the till.
async fn render(k: &Kernel, ctx: &Ctx, key: &str, sale: Uuid, language: Option<&str>, pdf: bool) -> Result<SiteResponse> {
    let r = k.render_document(&elevated(ctx), key, sale, language, pdf && k.pdf_enabled()).await?;
    Ok(SiteResponse { status: 200, content_type: r.content_type, headers: vec![], body: r.bytes })
}

/// The register, for a person who works at it.
async fn register(hc: &mut HookCtx<'_>, profile: Uuid) -> Result<Profile> {
    let ctx = hc.ctx;
    ctx.require("PosInvoice", ferrum_kernel::Action::Create)?;
    hc.kernel.get_tx(ctx, hc.tx, "PosProfile", profile, false).await?;
    let profile = Profile::load(hc.kernel, ctx, hc.tx, profile).await?;
    if !profile.admits(&ctx.email) && !is_manager(ctx) {
        return Err(Error::Forbidden(format!("{} is not allowed at register {}", ctx.email, profile.name())));
    }
    Ok(profile)
}

/// A submitted sale of the register's company, locked.
async fn sale_of(hc: &mut HookCtx<'_>, profile: &Profile, sale: Uuid) -> Result<Doc> {
    let doc = hc.kernel.get_tx(&sys(hc.ctx), hc.tx, "PosInvoice", sale, true).await.map_err(|_| Error::NotFound("sale".into()))?;
    if doc.get("docstatus").and_then(Value::as_i64) != Some(1) || id(&doc, "company") != id(&profile.doc, "company") {
        return Err(Error::NotFound("sale".into()));
    }
    Ok(doc)
}

fn own_sale(ctx: &Ctx, sale: &Doc) -> bool {
    s(sale, "cashier").is_some_and(|c| c.eq_ignore_ascii_case(&ctx.email))
}

/// What each receipt action starts from: the caller's own open session (the kernel has checked it is open and holds its
/// row), the register it is at, and the sale named, locked.
async fn start(hc: &mut HookCtx<'_>, session: &Doc, params: &Value) -> Result<(Profile, Doc, Uuid)> {
    // A manager may write anyone's session; a receipt is still given in one's own.
    if s(session, "user").is_none_or(|u| u.to_lowercase() != hc.ctx.email.to_lowercase()) {
        return Err(Error::Forbidden("receipts are given in your own session".into()));
    }
    let sale = uuid_of(params, "sale")?;
    let reg = register(hc, id(session, "pos_profile").ok_or_else(|| Error::internal("a session without a register"))?).await?;
    let doc = sale_of(hc, &reg, sale).await?;
    Ok((reg, doc, sale))
}

/// Keeps a receipt event of the sale `doc` by the caller, with `more` (its kind and what else it says): its id.
async fn record(hc: &mut HookCtx<'_>, doc: &Doc, more: Value) -> Result<Value> {
    let mut row = json!({"pos_invoice": id(doc, "id"), "company": id(doc, "company"), "cashier": hc.ctx.email.to_lowercase(), "printed_at": chrono::Utc::now().to_rfc3339()});
    if let (Some(r), Some(m)) = (row.as_object_mut(), more.as_object()) {
        r.extend(m.clone());
    }
    let made = hc.kernel.insert_tx(&elevated(hc.ctx), hc.tx, "PosReceiptEvent", row.as_object().cloned().unwrap_or_default()).await?;
    Ok(made.get("id").cloned().unwrap_or(Value::Null))
}

/// `print_receipt` of the caller's open session: the sale's original receipt, once (the sale's row is held). The cashier who
/// made the sale (or a manager) has it; a second ask is a copy, which is `reprint`. Through the browser's dialog it is
/// printed now; to a register's printer (`device`) it is issued until the till settles what came out (`settle`), and a
/// sale paid in cash opens that printer's drawer once. A register with a fiscal device prints the device's answer, so
/// the receipt waits for it; a device that printed it itself makes it printed.
pub(crate) async fn print(hc: &mut HookCtx<'_>, session: &Doc, params: &Value) -> Result<Value> {
    let (reg, doc, sale) = start(hc, session, params).await?;
    if !own_sale(hc.ctx, &doc) && !is_manager(hc.ctx) {
        return Err(Error::Forbidden("the receipt is printed at the till that made the sale; another asks for a copy".into()));
    }
    let device = match text(params, "device") {
        Some(given) => Some(crate::devices::printer(hc, &reg, given).await?),
        None => None,
    };
    let fiscal = doc.get("fiscal").filter(|f| f.is_object());
    if s(&reg.doc, "fiscal_operation").is_some() && fiscal.is_none() {
        return Err(Error::invalid("waiting for the fiscal device: the receipt prints once it has answered"));
    }
    if b(&doc, "receipt_printed") {
        return Err(Error::invalid("this receipt was printed already: ask for a copy"));
    }
    let mut mark = Doc::new();
    mark.insert("receipt_printed".into(), json!(true));
    hc.kernel.set_values_tx(&elevated(hc.ctx), hc.tx, "PosInvoice", sale, mark).await?;
    let by_device = fiscal.is_some_and(|f| f.get("printed_by_device") == Some(&Value::Bool(true)));
    let state = if device.is_some() && !by_device { "Issued" } else { "Printed" };
    let event = record(hc, &doc, json!({"kind": "Original", "state": state, "device": device.as_ref().map(|p| p.id)})).await?;
    let drawer = match &device {
        Some(p) if p.drawer && crate::devices::cash_taken(&doc) => {
            crate::devices::opened_for_sale(hc, &doc, id(session, "id").unwrap_or_default(), p.id, &event).await?
        }
        _ => false,
    };
    Ok(json!({"event": event, "kind": "Original", "state": state, "drawer": drawer}))
}

/// The receipt event's actions (`settle`); the event itself is written by the engine only (`masters::EngineOnly`).
pub struct ReceiptEventHook;

#[async_trait::async_trait]
impl ferrum_kernel::DocHook for ReceiptEventHook {
    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, params: &Value) -> Result<Option<Value>> {
        match name {
            "settle" => settle(hc, doc, params).await.map(Some),
            _ => Ok(None),
        }
    }
}

/// `settle` of an original issued to a printer: what came out, said by the till or, for one in doubt, by a person. Printed;
/// Unknown until a person says; or, when nothing left the till (`not_sent`) or it did not print (`not_printed`), the sale
/// has its original back under the sale's own lock, and for `not_sent` the drawer's opening goes too (no byte was sent).
/// The cashier who issued it or a manager settles it, from Issued or Unknown only, the event's row held.
async fn settle(hc: &mut HookCtx<'_>, event: &Doc, params: &Value) -> Result<Value> {
    let ctx = hc.ctx;
    if !s(event, "cashier").is_some_and(|c| c.eq_ignore_ascii_case(&ctx.email)) && !is_manager(ctx) {
        return Err(Error::Forbidden("a receipt is settled by the cashier who printed it or a manager".into()));
    }
    let eid = id(event, "id").ok_or_else(|| Error::internal("an event without an id"))?;
    let now: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select kind, state from e_pos_receipt_event where tenant_id = $1 and id = $2 for update")
            .bind(ctx.tenant)
            .bind(eid)
            .fetch_optional(&mut **hc.tx)
            .await?;
    let Some((Some(kind), state)) = now else { return Err(Error::NotFound("receipt".into())) };
    if kind != "Original" || !matches!(state.as_deref(), Some("Issued" | "Unknown")) {
        return Err(Error::invalid("This receipt is settled already"));
    }
    let outcome = text(params, "outcome").unwrap_or_default();
    let state = match outcome {
        "printed" => "Printed",
        "unknown" => "Unknown",
        "not_sent" | "not_printed" => {
            let sale = id(event, "pos_invoice").ok_or_else(|| Error::internal("a receipt without its sale"))?;
            // The sale's lock, as issuing takes it: its original goes back to be printed again.
            hc.kernel.get_tx(&sys(ctx), hc.tx, "PosInvoice", sale, true).await?;
            let mut back = Doc::new();
            back.insert("receipt_printed".into(), json!(false));
            hc.kernel.set_values_tx(&elevated(ctx), hc.tx, "PosInvoice", sale, back).await?;
            if outcome == "not_sent" {
                sqlx::query("delete from e_pos_drawer_event where tenant_id = $1 and receipt_event = $2")
                    .bind(ctx.tenant)
                    .bind(eid)
                    .execute(&mut **hc.tx)
                    .await?;
            }
            "Not Printed"
        }
        _ => return Err(Error::field("outcome", "is printed, not_sent, unknown or not_printed")),
    };
    let mut v = Doc::new();
    v.insert("state".into(), json!(state));
    if state != "Unknown" {
        v.insert("settled_by".into(), json!(ctx.email.to_lowercase()));
    }
    hc.kernel.set_values_tx(&elevated(ctx), hc.tx, "PosReceiptEvent", eid, v).await?;
    Ok(json!({"state": state, "original": state == "Not Printed"}))
}

/// `GET /paper/{event}?language=&format=pdf`: the page of a receipt event (the first receipt, a copy, a gift receipt), for the
/// person who asked for it or someone who may read the event as themselves. A message has no paper. Nothing changes.
pub async fn paper(k: &Kernel, ctx: &Ctx, req: &SiteRequest, event: Uuid) -> Result<SiteResponse> {
    let nothing = || Error::NotFound("page".into());
    let ev = k.get(&sys(ctx), "PosReceiptEvent", event, false).await.map_err(|_| nothing())?;
    // `format=text`: the lines a receipt printer prints (the till encodes them).
    let key = match (s(&ev, "kind"), param(req, "format")) {
        (Some("Original" | "Copy"), Some("text")) => RECEIPT_TEXT,
        (Some("Original" | "Copy"), _) => RECEIPT,
        (Some("Gift"), _) => GIFT,
        _ => return Err(nothing()),
    };
    let asked = s(&ev, "cashier").is_some_and(|c| c.eq_ignore_ascii_case(&ctx.email));
    if !asked && k.get(ctx, "PosReceiptEvent", event, false).await.is_err() {
        return Err(nothing());
    }
    let sale = id(&ev, "pos_invoice").ok_or_else(nothing)?;
    render(k, ctx, key, sale, param(req, "language"), param(req, "format") == Some("pdf")).await
}

/// Why something is done, as the business has its reasons for it (`applies_to`): when it has some, one of them is chosen
/// (`ask` says so otherwise).
pub(crate) async fn reason_of(tx: &mut ferrum_kernel::Tx, tenant: Uuid, applies_to: &str, given: Option<&str>, ask: &str) -> Result<Option<String>> {
    let reasons: Vec<(Uuid, String)> =
        sqlx::query_as("select id, reason from e_pos_reason where tenant_id = $1 and applies_to = $2 and not coalesce(disabled, false)")
            .bind(tenant)
            .bind(applies_to)
            .fetch_all(&mut **tx)
            .await?;
    if reasons.is_empty() {
        return Ok(given.map(str::to_string));
    }
    let given = given.ok_or_else(|| Error::field("reason", ask))?;
    reasons.into_iter().find(|(i, r)| i.to_string() == given || r.eq_ignore_ascii_case(given)).map(|(_, r)| Some(r)).ok_or_else(|| Error::field("reason", ask))
}

/// `reprint` of the caller's open session: a copy of the receipt (marked and counted) or a gift receipt (no prices), by someone
/// whose limits let them reprint, or with another person's approval for a reprint of this sale in this session (used once).
pub(crate) async fn reprint(hc: &mut HookCtx<'_>, session: &Doc, params: &Value) -> Result<Value> {
    let gift = match text(params, "kind") {
        Some("copy") => false,
        Some("gift") => true,
        _ => return Err(Error::field("kind", "is copy or gift")),
    };
    let approval = text(params, "approval").map(|a| a.parse::<Uuid>().map_err(|_| Error::field("approval", "is an approval's id"))).transpose()?;
    let (reg, doc, sale) = start(hc, session, params).await?;
    let ctx = hc.ctx;
    let event = Uuid::now_v7();
    let sid = id(session, "id").unwrap_or_default();
    if !crate::limits::at_till(ctx, hc.tx, &reg, sid).await?.reprint {
        let here = (ctx.email.as_str(), sid);
        let covered = match approval {
            Some(a) => crate::limits::covers(hc.tx, ctx.tenant, a, here, Act::Reprint, rust_decimal::Decimal::ZERO, false, sale).await?,
            None => false,
        };
        if !covered {
            return Err(Error::Forbidden("you may not reprint receipts; ask someone who may to approve it".into()));
        }
        // Used once: the next copy asks again.
        crate::limits::use_approvals(hc.tx, ctx.tenant, &[approval.unwrap_or_default()], event).await?;
    }
    let reason = reason_of(hc.tx, ctx.tenant, "Reprint", text(params, "reason"), "choose one of the business's reasons for a copy").await?;
    let copies = doc.get("reprints").and_then(Value::as_i64).unwrap_or(0) + i64::from(!gift);
    if !gift {
        let mut count = Doc::new();
        count.insert("reprints".into(), json!(copies));
        hc.kernel.set_values_tx(&elevated(hc.ctx), hc.tx, "PosInvoice", sale, count).await?;
    }
    let kind = if gift { "Gift" } else { "Copy" };
    let copy_no = (!gift).then_some(copies);
    record(hc, &doc, json!({"id": event.to_string(), "kind": kind, "copy_no": copy_no, "reason": reason, "approval": approval})).await?;
    Ok(json!({"event": event.to_string(), "kind": kind, "copy_no": copy_no}))
}

/// The first field of the customer record of a type: where an address or a number the buyer opts to leave is kept.
fn contact_field(ctx: &Ctx, ftype: ferrum_meta::FieldType) -> Option<String> {
    ctx.schema.entity("Customer")?.def.fields.iter().find(|f| f.ftype == ftype).map(|f| f.name.clone())
}

/// `send_receipt` of the caller's open session: the receipt to an address or number the buyer gives, by the message template
/// and the channels the workspace has. The buyer's consent is for this one message unless they opt in to more; the address
/// is a secret parameter, kept in the message log (and gone with an erasure), never on the sale, its event, the action's audit
/// entry or its receipt. A buyer who opts in and is a named customer without that contact has it added to their record.
pub(crate) async fn send(hc: &mut HookCtx<'_>, session: &Doc, params: &Value) -> Result<Value> {
    let to = text(params, "to").ok_or_else(|| Error::field("to", "is an address or a number"))?;
    let opt_in = match text(params, "consent") {
        Some("once") => false,
        Some("opt_in") => true,
        _ => return Err(Error::field("consent", "is once or opt_in")),
    };
    let (reg, doc, sale) = start(hc, session, params).await?;
    if !own_sale(hc.ctx, &doc) && !crate::limits::at_till(hc.ctx, hc.tx, &reg, id(session, "id").unwrap_or_default()).await?.reprint {
        return Err(Error::Forbidden("you may send the receipts of your own sales; ask someone who may reprint for another's".into()));
    }
    let (k, ctx) = (hc.kernel, hc.ctx);
    let system = elevated(ctx);
    let company = get(k, &system, hc.tx, "Company", id(&doc, "company").unwrap_or_default()).await?;
    // The receipt goes as a file with the message; a workspace with no file storage sends the message alone.
    let ask = Generate {
        template: RECEIPT.into(),
        record: sale,
        name: Some(format!("Receipt {}", s(&doc, "number").unwrap_or_default())),
        language: text(params, "language").map(str::to_string),
        replace: true,
        values: Map::new(),
    };
    let made = match generate(k, hc.tx, &system, &ask).await {
        Ok(g) => Some(g.file),
        Err(Error::Unavailable(_)) => None,
        Err(e) => return Err(e),
    };
    let mut values = Map::new();
    values.insert("company".into(), company.get("company_name").cloned().unwrap_or(Value::Null));
    let (code, _) = ferrum_domain::util::currency(k, &system, hc.tx, id(&company, "default_currency").unwrap_or_default()).await?;
    values.insert("currency".into(), json!(code));
    let message = Message {
        template: MESSAGE.into(),
        entity: Some("PosInvoice".into()),
        record: Some(sale),
        to: vec![Recipient::address(to)],
        values,
        attachments: made.into_iter().collect(),
        ..Default::default()
    };
    let sent = messages::send(k, hc.tx, &system, &message).await?;
    let channels: Vec<String> = sent.iter().map(|x| x.channel.clone()).collect();
    let consent = if opt_in { "Opted In" } else { "This Receipt Only" };
    let event = record(hc, &doc, json!({"kind": "Message", "channel": channels.first(), "consent": consent})).await?;
    // Opted in, and a customer of the shop's own: the contact goes on their record when it has none.
    if opt_in && let Some(c) = id(&doc, "customer").filter(|c| Some(*c) != id(&reg.doc, "customer")) {
        let field = if to.contains('@') { contact_field(ctx, ferrum_meta::FieldType::Email) } else { contact_field(ctx, ferrum_meta::FieldType::Phone) };
        let customer = get(k, &system, hc.tx, "Customer", c).await?;
        if let Some(f) = field.filter(|f| customer.get(f).is_none_or(|x| x.is_null() || x == "")) {
            let mut change = Doc::new();
            change.insert(f, json!(to));
            k.set_values_tx(&system, hc.tx, "Customer", c, change).await?;
        }
    }
    Ok(json!({"event": event, "channels": channels, "attached": !message.attachments.is_empty()}))
}
