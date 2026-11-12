//! The receipt (PS-10, PS-53, PS-54, PS-57, PS-58): the sale's first printing, copies marked and counted, gift
//! receipts, and the receipt sent to the buyer as a message. What the paper says is the document template
//! (`pos.receipt`, `pos.receipt_gift`) and the message template (`pos.receipt_sent`) the workspace edits; this
//! module decides who may have one and keeps the record of it.
//!
//! The first printing is once per sale (an atomic mark under the sale's lock, so two tills never print two
//! originals); everything after is a copy: who asked, when, for what reason and by whose approval is a
//! `PosReceiptEvent`, the sale counts its copies (`reprints`), and the copy says so on its face.

use crate::logic::Act;
use crate::site::param;
use crate::{Profile, is_manager, open_session_in};
use ferrum_domain::util::{b, elevated, get, id, s, sys};
use ferrum_kernel::documents::{Generate, generate};
use ferrum_kernel::messages::{self, Message, Recipient};
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, SiteRequest, SiteResponse};
use serde_json::{Map, Value, json};
use uuid::Uuid;

const RECEIPT: &str = "pos.receipt";
const GIFT: &str = "pos.receipt_gift";
const MESSAGE: &str = "pos.receipt_sent";

fn body(req: &SiteRequest) -> Result<Value> {
    serde_json::from_slice(&req.body).map_err(|_| Error::invalid("send a JSON object"))
}

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty())
}

fn uuid_of(v: &Value, key: &str) -> Result<Uuid> {
    text(v, key).and_then(|x| x.parse().ok()).ok_or_else(|| Error::field(key.to_string(), "is required"))
}

/// The page or file `key` renders for `sale`, as the response to the till.
async fn render(k: &Kernel, ctx: &Ctx, key: &str, sale: Uuid, language: Option<&str>, pdf: bool, headers: Vec<(String, String)>) -> Result<SiteResponse> {
    let r = k.render_document(&elevated(ctx), key, sale, language, pdf && k.pdf_enabled()).await?;
    Ok(SiteResponse { status: 200, content_type: r.content_type, headers, body: r.bytes })
}

/// The register, for a person who works at it.
async fn register(k: &Kernel, ctx: &Ctx, tx: &mut ferrum_kernel::Tx, profile: Uuid) -> Result<Profile> {
    ctx.require("PosInvoice", ferrum_kernel::Action::Create)?;
    k.get(ctx, "PosProfile", profile, false).await?;
    let profile = Profile::load(k, ctx, tx, profile).await?;
    if !profile.admits(&ctx.email) && !is_manager(ctx) {
        return Err(Error::Forbidden(format!("{} is not allowed at register {}", ctx.email, profile.name())));
    }
    Ok(profile)
}

/// A submitted sale of the register's company, locked.
async fn sale_of(k: &Kernel, ctx: &Ctx, tx: &mut ferrum_kernel::Tx, profile: &Profile, sale: Uuid) -> Result<Doc> {
    let doc = k.get_tx(&sys(ctx), tx, "PosInvoice", sale, true).await.map_err(|_| Error::NotFound("sale".into()))?;
    if doc.get("docstatus").and_then(Value::as_i64) != Some(1) || id(&doc, "company") != id(&profile.doc, "company") {
        return Err(Error::NotFound("sale".into()));
    }
    Ok(doc)
}

fn own_sale(ctx: &Ctx, sale: &Doc) -> bool {
    s(sale, "cashier").is_some_and(|c| c.eq_ignore_ascii_case(&ctx.email))
}

/// `GET /receipt/{sale}?profile=&format=pdf&language=`: the sale's first receipt, once. The cashier who made the sale
/// (or a manager) has it; a second ask is a copy, which has its own request and its record.
pub async fn first(k: &Kernel, ctx: &Ctx, req: &SiteRequest, sale: Uuid) -> Result<SiteResponse> {
    let profile: Uuid = param(req, "profile").and_then(|v| v.parse().ok()).ok_or_else(|| Error::field("profile", "is required"))?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let reg = register(k, ctx, &mut tx, profile).await?;
    let doc = sale_of(k, ctx, &mut tx, &reg, sale).await?;
    if !own_sale(ctx, &doc) && !is_manager(ctx) {
        return Err(Error::Forbidden("the receipt is printed at the till that made the sale; another asks for a copy".into()));
    }
    if b(&doc, "receipt_printed") {
        return Err(Error::invalid("this receipt was printed already: ask for a copy"));
    }
    let mut mark = Doc::new();
    mark.insert("receipt_printed".into(), json!(true));
    k.set_values_tx(&elevated(ctx), &mut tx, "PosInvoice", sale, mark).await?;
    tx.commit().await?;
    render(k, ctx, RECEIPT, sale, param(req, "language"), param(req, "format") == Some("pdf"), vec![]).await
}

/// What reprints are given, as the business has them: when it has reasons, one of them is chosen.
async fn reason_of(tx: &mut ferrum_kernel::Tx, tenant: Uuid, given: Option<&str>) -> Result<Option<String>> {
    let reasons: Vec<(Uuid, String)> =
        sqlx::query_as("select id, reason from e_pos_reason where tenant_id = $1 and applies_to = 'Reprint' and not coalesce(disabled, false)")
            .bind(tenant)
            .fetch_all(&mut **tx)
            .await?;
    if reasons.is_empty() {
        return Ok(given.map(str::to_string));
    }
    let given = given.ok_or_else(|| Error::field("reason", "choose one of the business's reasons for a copy"))?;
    reasons
        .into_iter()
        .find(|(i, r)| i.to_string() == given || r.eq_ignore_ascii_case(given))
        .map(|(_, r)| Some(r))
        .ok_or_else(|| Error::field("reason", "choose one of the business's reasons for a copy"))
}

/// `POST /reprint` `{profile, sale, kind: copy | gift, reason?, approval?, format?, language?}`: a copy of the receipt (marked
/// and counted) or a gift receipt (no prices), by someone whose limits let them reprint or with another person's approval.
pub async fn reprint(k: &Kernel, ctx: &Ctx, req: &SiteRequest) -> Result<SiteResponse> {
    let v = body(req)?;
    let (profile, sale) = (uuid_of(&v, "profile")?, uuid_of(&v, "sale")?);
    let gift = match text(&v, "kind") {
        Some("copy") | None => false,
        Some("gift") => true,
        Some(_) => return Err(Error::field("kind", "is copy or gift")),
    };
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let reg = register(k, ctx, &mut tx, profile).await?;
    let doc = sale_of(k, ctx, &mut tx, &reg, sale).await?;
    let event = Uuid::now_v7();
    let approval = match text(&v, "approval").and_then(|a| a.parse::<Uuid>().ok()) {
        Some(a) => Some(a),
        None if text(&v, "approval").is_some() => return Err(Error::field("approval", "is an approval's id")),
        None => None,
    };
    if !crate::limits::of(ctx, &mut tx, &reg).await?.reprint {
        let session = open_session_in(&mut tx, ctx.tenant, profile, &ctx.email).await?;
        let covered = match (approval, session) {
            (Some(a), Some(sess)) => {
                crate::limits::covers(&mut tx, ctx.tenant, a, (&ctx.email, sess), Act::Reprint, rust_decimal::Decimal::ZERO, false, sale).await?
            }
            _ => false,
        };
        if !covered {
            return Err(Error::Forbidden("you may not reprint receipts; ask someone who may to approve it".into()));
        }
        // Used once: the next copy asks again.
        crate::limits::use_approvals(&mut tx, ctx.tenant, &[approval.unwrap_or_default()], event).await?;
    }
    let reason = reason_of(&mut tx, ctx.tenant, text(&v, "reason")).await?;
    let copies = doc.get("reprints").and_then(Value::as_i64).unwrap_or(0) + i64::from(!gift);
    if !gift {
        let mut count = Doc::new();
        count.insert("reprints".into(), json!(copies));
        k.set_values_tx(&elevated(ctx), &mut tx, "PosInvoice", sale, count).await?;
    }
    let row = json!({
        "id": event.to_string(), "pos_invoice": sale, "company": id(&doc, "company"), "kind": if gift { "Gift" } else { "Copy" },
        "copy_no": (!gift).then_some(copies), "cashier": ctx.email.to_lowercase(), "printed_at": chrono::Utc::now().to_rfc3339(), "reason": reason, "approval": approval,
    });
    k.insert_tx(&elevated(ctx), &mut tx, "PosReceiptEvent", row.as_object().cloned().unwrap_or_default()).await?;
    tx.commit().await?;
    let headers = vec![("x-pos-receipt-event".to_string(), event.to_string()), ("x-pos-copy".to_string(), copies.to_string())];
    render(k, ctx, if gift { GIFT } else { RECEIPT }, sale, text(&v, "language"), text(&v, "format") == Some("pdf"), headers).await
}

/// The first field of the customer record of a type: where an address or a number the buyer opts to leave is kept.
fn contact_field(ctx: &Ctx, ftype: ferrum_meta::FieldType) -> Option<String> {
    ctx.schema.entity("Customer")?.def.fields.iter().find(|f| f.ftype == ftype).map(|f| f.name.clone())
}

/// `POST /send` `{profile, sale, to, consent: once | opt_in, language?}`: the receipt to an address or number the buyer
/// gives, by the message template and the channels the workspace has. The buyer's consent is for this one message
/// unless they opt in to more; the address is kept in the message log (and goes with an erasure), never on the sale.
/// A buyer who opts in and is a named customer without that contact has it added to their record.
pub async fn send(k: &Kernel, ctx: &Ctx, req: &SiteRequest) -> Result<Value> {
    let v = body(req)?;
    let (profile, sale) = (uuid_of(&v, "profile")?, uuid_of(&v, "sale")?);
    let to = text(&v, "to").ok_or_else(|| Error::field("to", "is an address or a number"))?;
    let opt_in = match text(&v, "consent") {
        Some("once") | None => false,
        Some("opt_in") => true,
        Some(_) => return Err(Error::field("consent", "is once or opt_in")),
    };
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let reg = register(k, ctx, &mut tx, profile).await?;
    let doc = sale_of(k, ctx, &mut tx, &reg, sale).await?;
    if !own_sale(ctx, &doc) && !crate::limits::of(ctx, &mut tx, &reg).await?.reprint {
        return Err(Error::Forbidden("you may send the receipts of your own sales; ask someone who may reprint for another's".into()));
    }
    let system = elevated(ctx);
    let company = get(k, &system, &mut tx, "Company", id(&doc, "company").unwrap_or_default()).await?;
    let language = text(&v, "language");
    // The receipt goes as a file with the message; a workspace with no file storage sends the message alone.
    let ask = Generate {
        template: RECEIPT.into(),
        record: sale,
        name: Some(format!("Receipt {}", s(&doc, "number").unwrap_or_default())),
        language: language.map(str::to_string),
        replace: true,
        values: Map::new(),
    };
    let made = match generate(k, &mut tx, &system, &ask).await {
        Ok(g) => Some(g.file),
        Err(Error::Unavailable(_)) => None,
        Err(e) => return Err(e),
    };
    let mut values = Map::new();
    values.insert("company".into(), company.get("company_name").cloned().unwrap_or(Value::Null));
    let (code, _) = ferrum_domain::util::currency(k, &system, &mut tx, id(&company, "default_currency").unwrap_or_default()).await?;
    values.insert("currency".into(), json!(code));
    let sent = messages::send(
        k,
        &mut tx,
        &system,
        &Message {
            template: MESSAGE.into(),
            entity: Some("PosInvoice".into()),
            record: Some(sale),
            to: vec![Recipient::address(to)],
            values,
            attachments: made.into_iter().collect(),
            ..Default::default()
        },
    )
    .await?;
    let channel = sent.first().map(|x| x.channel.clone());
    let row = json!({
        "pos_invoice": sale, "company": id(&doc, "company"), "kind": "Message", "cashier": ctx.email.to_lowercase(), "printed_at": chrono::Utc::now().to_rfc3339(),
        "channel": channel, "consent": if opt_in { "Opted In" } else { "This Receipt Only" },
    });
    let event = k.insert_tx(&system, &mut tx, "PosReceiptEvent", row.as_object().cloned().unwrap_or_default()).await?;
    // Opted in, and a customer of the shop's own: the contact goes on their record when it has none.
    if opt_in && let Some(c) = id(&doc, "customer").filter(|c| Some(*c) != id(&reg.doc, "customer")) {
        let field = if to.contains('@') { contact_field(ctx, ferrum_meta::FieldType::Email) } else { contact_field(ctx, ferrum_meta::FieldType::Phone) };
        let customer = get(k, &system, &mut tx, "Customer", c).await?;
        if let Some(f) = field.filter(|f| customer.get(f).is_none_or(|x| x.is_null() || x == "")) {
            let mut change = Doc::new();
            change.insert(f, json!(to));
            k.set_values_tx(&system, &mut tx, "Customer", c, change).await?;
        }
    }
    tx.commit().await?;
    Ok(json!({"event": event.get("id"), "sent": sent, "receipt": made}))
}
