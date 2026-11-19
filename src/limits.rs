//! What a person may do at a register on their own (`PosRoleLimit`, R-1 to R-6): the rows of their
//! roles, a register's own row before the row for every register, the most generous role winning.
//! Someone none of whose roles has a row keeps what the register itself allowed before these rows
//! existed (its discount and price settings; a POS Manager, everything), so nothing changes on
//! upgrade until a business writes its rows.

use crate::logic::{Act, Limits};
use crate::{Profile, is_manager};
use ferrum_domain::util::{b, d, elevated, id, s, sys};
use ferrum_kernel::{Ctx, Doc, Error, HookCtx, Kernel, Result, Tx};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

fn cap(doc: &Doc, f: &str) -> Option<Decimal> {
    crate::opt_dec(doc, f)
}

fn of_row(r: &Doc) -> Limits {
    Limits {
        discount_percent: d(r, "discount_percent"),
        discount_amount: cap(r, "discount_amount"),
        change_price: b(r, "change_price"),
        void_line: b(r, "void_line"),
        void_sale: b(r, "void_sale"),
        refund: cap(r, "refund_limit"),
        return_without_receipt: b(r, "return_without_receipt"),
        open_drawer: b(r, "open_drawer"),
        reprint: b(r, "reprint"),
    }
}

/// What the register allowed everyone before role limits: its discount and price settings, voiding
/// lines and reprints; voiding sales and the rest were a manager's.
fn register_default(profile: &Doc) -> Limits {
    let discount = b(profile, "allow_discount_change");
    Limits {
        discount_percent: if discount { d(profile, "max_discount") } else { Decimal::ZERO },
        discount_amount: None,
        change_price: b(profile, "allow_rate_change"),
        void_line: true,
        void_sale: false,
        refund: None,
        return_without_receipt: false,
        open_drawer: false,
        reprint: true,
    }
}

/// The limits of `roles` (a POS manager's flag apart) at `profile`, from the rows read.
pub(crate) fn resolve(rows: &[Doc], roles: &[String], manager: bool, profile: &Profile) -> Limits {
    let mut by_role: HashMap<&str, &Doc> = HashMap::new();
    for r in rows {
        let Some(role) = s(r, "role").filter(|role| roles.iter().any(|x| x.eq_ignore_ascii_case(role))) else { continue };
        let here = s(r, "pos_profile") == Some(profile.id.to_string().as_str());
        // The register's own row wins over the row for every register.
        if here || !by_role.contains_key(role) {
            by_role.insert(role, r);
        }
    }
    match Limits::widest(by_role.values().map(|r| of_row(r))) {
        Some(l) => l,
        None if manager => Limits::unlimited(),
        None => register_default(&profile.doc),
    }
}

/// The limits of the person `ctx` at `profile` now.
pub(crate) async fn of(ctx: &Ctx, tx: &mut Tx, profile: &Profile) -> Result<Limits> {
    if ctx.is_system {
        return Ok(Limits::unlimited());
    }
    let rows = rows_for(tx, ctx.tenant, profile.id).await?;
    Ok(resolve(&rows, &ctx.roles, is_manager(ctx), profile))
}

/// Every row that may apply at a register.
pub(crate) async fn rows_for(tx: &mut Tx, tenant: Uuid, profile: Uuid) -> Result<Vec<Doc>> {
    let found: Vec<serde_json::Value> =
        sqlx::query_scalar("select to_jsonb(r) from e_pos_role_limit r where tenant_id = $1 and (pos_profile is null or pos_profile = $2)")
            .bind(tenant)
            .bind(profile)
            .fetch_all(&mut **tx)
            .await?;
    Ok(found.into_iter().filter_map(|v| v.as_object().cloned()).collect())
}

// ───────────────────────────── PINs and approvals ─────────────────────────────
//
// Approval at the till (PS-21): someone whose limits allow it types their PIN on the cashier's till,
// without the cashier signing out. Both halves are declared operations, as an agent or an API client
// asks them too: `set_pin` of a register (a person sets their own PIN) and `approve` of the cashier's
// open session. The PIN is kept only as an argon2id hash (`pos_staff_pin`), five wrong tries lock it
// for fifteen minutes, and it never reaches a record, a log or a receipt: it is the actions' secret
// parameter, which the platform keeps out of the audit entry, the receipt and error texts. An approval is a
// record (`PosApproval`) for one act on one sale (or draft, by the id the till gives it; none for
// opening the drawer) in one session, at most the amount approved, used once, and only within the
// register's Approval Lasts minutes and while that session is open: handing the till over is closing
// one session and opening another, so it lapses then too. Offline there is no approval: a till cannot check a PIN without
// keeping something on the device that a short PIN's few thousand values would give away to
// whoever holds it, so an act beyond the cashier's own limits waits for the connection.

const WRONG_PINS: i32 = 5;
const LOCKED_MINUTES: i32 = 15;

/// A PIN as people type it: four to twelve digits.
fn check_pin_shape(pin: &str) -> Result<()> {
    if (4..=12).contains(&pin.len()) && pin.chars().all(|c| c.is_ascii_digit()) { Ok(()) } else { Err(Error::field("pin", "a PIN is four to twelve digits")) }
}

/// A text parameter of an action as given, trimmed; none when missing, empty or not text.
fn param<'a>(params: &'a Value, name: &str) -> Option<&'a str> {
    params.get(name).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
}

/// `set_pin` of a register: the caller's own PIN, kept as a hash, its wrong tries and any lock forgotten, in the
/// action's transaction.
pub(crate) async fn set_pin(hc: &mut HookCtx<'_>, params: &Value) -> Result<Value> {
    let pin = param(params, "pin").unwrap_or_default();
    check_pin_shape(pin)?;
    let ctx = hc.ctx;
    if ctx.email.is_empty() || ctx.outside {
        return Err(Error::Forbidden("only a member of the workspace sets a PIN".into()));
    }
    let hash = ferrum_kernel::auth::hash_password(pin.to_string()).await?;
    sqlx::query(
        "insert into pos_staff_pin (tenant_id, email, pin_hash) values ($1, lower($2), $3) \
         on conflict (tenant_id, email) do update set pin_hash = excluded.pin_hash, failures = 0, locked_until = null, set_at = now()",
    )
    .bind(ctx.tenant)
    .bind(&ctx.email)
    .bind(hash)
    .execute(&mut **hc.tx)
    .await?;
    Ok(json!({"ok": true}))
}

/// The person `email` proved by `pin`: their context, or a refusal that counts a wrong try (kept
/// whatever becomes of the caller's transaction) and locks the PIN after too many.
async fn prove(k: &Kernel, tenant: Uuid, email: &str, pin: &str) -> Result<Ctx> {
    let wrong = || Error::invalid("that person's PIN does not match");
    let mut sys = k.db.system_tx().await?;
    let user: Option<(Uuid, bool)> = sqlx::query_as("select id, is_active from app_user where tenant_id = $1 and email = lower($2)")
        .bind(tenant)
        .bind(email.trim())
        .fetch_optional(&mut *sys)
        .await?;
    let row: Option<(String, bool)> =
        sqlx::query_as("select pin_hash, coalesce(locked_until > now(), false) from pos_staff_pin where tenant_id = $1 and email = lower($2)")
            .bind(tenant)
            .bind(email.trim())
            .fetch_optional(&mut *sys)
            .await?;
    sys.commit().await?;
    let (Some((user, true)), Some((hash, locked))) = (user, row) else {
        // As long as a real check, so a refusal does not say whether the person has a PIN.
        ferrum_kernel::auth::verify_password(
            pin.to_string(),
            "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$ZmVycnVtLWR1bW15LWhhc2gtZm9yLXRpbWluZw".into(),
        )
        .await;
        return Err(wrong());
    };
    if locked {
        return Err(Error::TooManyRequests(format!("too many wrong PINs for {email}: try again in {LOCKED_MINUTES} minutes")));
    }
    let right = ferrum_kernel::auth::verify_password(pin.to_string(), hash).await;
    let mut sys = k.db.system_tx().await?;
    if right {
        sqlx::query("update pos_staff_pin set failures = 0 where tenant_id = $1 and email = lower($2)")
            .bind(tenant)
            .bind(email.trim())
            .execute(&mut *sys)
            .await?;
    } else {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "update pos_staff_pin set failures = case when failures + 1 >= {WRONG_PINS} then 0 else failures + 1 end, \
             locked_until = case when failures + 1 >= {WRONG_PINS} then now() + interval '{LOCKED_MINUTES} minutes' else locked_until end \
             where tenant_id = $1 and email = lower($2)"
        )))
        .bind(tenant)
        .bind(email.trim())
        .execute(&mut *sys)
        .await?;
    }
    sys.commit().await?;
    if !right {
        return Err(wrong());
    }
    k.load_ctx(tenant, user, None, "pos-approval".into()).await
}

/// What a till asks to have approved: the `approve` action's parameters, each checked where it enters.
struct Ask<'a> {
    approver: &'a str,
    pin: &'a str,
    act: Act,
    amount: Option<Decimal>,
    reason: &'a str,
    /// The sale or draft it is for; none only for opening the drawer.
    sale: Option<Uuid>,
}

impl<'a> Ask<'a> {
    fn parse(params: &'a Value) -> Result<Ask<'a>> {
        let need = |f: &'static str| param(params, f).ok_or_else(|| Error::field(f, "is required"));
        let act = Act::parse(need("act")?).ok_or_else(|| Error::field("act", "is not something that is approved"))?;
        let amount = match params.get("amount") {
            None | Some(Value::Null) => None,
            Some(Value::String(a)) if a.trim().is_empty() => None,
            Some(Value::String(a)) => Some(a.trim().parse::<Decimal>().map_err(|_| Error::field("amount", "is a number"))?),
            Some(Value::Number(a)) => Some(a.to_string().parse::<Decimal>().map_err(|_| Error::field("amount", "is a number"))?),
            Some(_) => return Err(Error::field("amount", "is a number")),
        };
        let reason = param(params, "reason").ok_or_else(|| Error::field("reason", "say why"))?;
        let sale = param(params, "sale").map(|s| s.parse::<Uuid>().map_err(|_| Error::field("sale", "is the sale's id"))).transpose()?;
        if sale.is_none() && act != Act::NoSale {
            return Err(Error::field("sale", "name the sale (or draft) it is for"));
        }
        Ok(Ask { approver: need("approver")?, pin: need("pin")?, act, amount, reason, sale })
    }
}

/// `approve` of the cashier's open session: one act beyond the cashier's limits, approved by another person's PIN when
/// that person's own limits at the session's register allow it. The kernel has checked the caller may write the session
/// and that it is submitted and open, and holds its row. Answers the approval, who approved and the act.
pub(crate) async fn approve(hc: &mut HookCtx<'_>, session: &Doc, params: &Value) -> Result<Value> {
    let ask = Ask::parse(params)?;
    let ctx = hc.ctx;
    let me = ctx.email.to_lowercase();
    let not_you = || Error::field("approver", "someone else approves what is beyond your own limits");
    // The person serving at the till (`take_over`) is not someone else either.
    let serving = s(session, "operator").map(str::to_lowercase);
    if ask.approver.to_lowercase() == me || serving.as_deref() == Some(ask.approver.to_lowercase().as_str()) {
        return Err(not_you());
    }
    // A manager may write anyone's session; an approval is still the cashier's own to ask.
    if s(session, "user").is_none_or(|u| u.to_lowercase() != me) {
        return Err(Error::Forbidden("an approval is asked in your own session".into()));
    }
    let profile = Profile::load(hc.kernel, ctx, hc.tx, id(session, "pos_profile").ok_or_else(|| Error::internal("a session without a register"))?).await?;
    // Its own short transactions: a wrong PIN stays counted when this action fails.
    let approver = prove(hc.kernel, ctx.tenant, ask.approver, ask.pin).await?;
    if approver.user == ctx.user || serving.as_deref() == Some(approver.email.to_lowercase().as_str()) {
        return Err(not_you());
    }
    let theirs = of(&approver, hc.tx, &profile).await?;
    if !theirs.allows(ask.act, ask.amount.unwrap_or_default()) {
        return Err(Error::Forbidden(format!("{} may not approve this either", approver.email)));
    }
    let row = json!({
        "pos_profile": profile.id, "pos_opening_entry": id(session, "id"), "cashier": me, "approver": approver.email.to_lowercase(),
        "action": ask.act.label(), "amount": ask.amount.map(|a| a.normalize().to_string()), "reason": ask.reason,
        "limits": theirs, "approved_at": chrono::Utc::now().to_rfc3339(), "sale": ask.sale.map(|s| s.to_string()),
        "expires_at": (chrono::Utc::now() + chrono::Duration::minutes(minutes(&profile.doc))).to_rfc3339(),
    });
    let made = hc.kernel.insert_tx(&elevated(ctx), hc.tx, "PosApproval", row.as_object().cloned().unwrap_or_default()).await?;
    Ok(json!({"approval": made.get("id"), "approver": approver.email, "action": ask.act.label()}))
}

// ───────────────────────────── someone else serving at the till ─────────────────────────────
//
// POS-12. The till stays signed in as the cashier whose session is open, who answers for the drawer. Someone else serves
// at it by their PIN (`take_over`, the same proof as an approval): the session names them (`operator`) with what they may
// do at the register as they took over, a sale made online is theirs (`served_by`, `invoice.rs`) and is held to the
// narrower of their limits and the cashier's (`for_sale`, `at_till`), so serving never lends the cashier's rights and
// claiming to be someone can only lose rights. `hand_back` takes the cashier's own PIN, as it gives the cashier's rights
// back. Offline nothing switches: a sale made offline is the cashier's own.

/// The caller's email when the session is their own: a till is handed over and back only by its session's cashier (a
/// manager may write anyone's session, not hand over their till).
fn own_session(ctx: &Ctx, session: &Doc) -> Result<String> {
    let me = ctx.email.to_lowercase();
    match s(session, "user") {
        Some(u) if u.to_lowercase() == me => Ok(me),
        _ => Err(Error::Forbidden("only the session's cashier hands its till over".into())),
    }
}

/// `take_over` of the cashier's open session: `operator`, proved by their PIN and working this register, serves at its
/// till from now. The kernel has checked the caller may write the session and that it is submitted and open, and holds
/// its row. Answers who serves and since when.
pub(crate) async fn take_over(hc: &mut HookCtx<'_>, session: &Doc, params: &Value) -> Result<Value> {
    let operator = param(params, "operator").ok_or_else(|| Error::field("operator", "is required"))?;
    let pin = param(params, "pin").ok_or_else(|| Error::field("pin", "is required"))?;
    let ctx = hc.ctx;
    let me = own_session(ctx, session)?;
    let yours = || Error::field("operator", "you answer for this session already: hand it back instead");
    if operator.to_lowercase() == me {
        return Err(yours());
    }
    let sid = id(session, "id").ok_or_else(|| Error::internal("a session without an id"))?;
    let profile = Profile::load(hc.kernel, ctx, hc.tx, id(session, "pos_profile").ok_or_else(|| Error::internal("a session without a register"))?).await?;
    let barred = |email: &str| Error::Forbidden(format!("{email} is not allowed at register {}", profile.name()));
    if !profile.admits(operator) {
        return Err(barred(operator));
    }
    // Its own short transactions: a wrong PIN stays counted when this action fails.
    let who = prove(hc.kernel, ctx.tenant, operator, pin).await?;
    if who.user == ctx.user {
        return Err(yours());
    }
    // Someone who works a till: a cashier or a manager (a PIN outlives a role taken away).
    if !(who.has_role("Cashier") || is_manager(&who)) {
        return Err(barred(&who.email));
    }
    let theirs = of(&who, hc.tx, &profile).await?;
    let email = who.email.to_lowercase();
    let since = chrono::Utc::now().to_rfc3339();
    let v = json!({"operator": email, "operator_since": since, "operator_limits": theirs});
    hc.kernel.set_values_tx(&sys(ctx), hc.tx, "PosOpeningEntry", sid, v.as_object().cloned().unwrap_or_default()).await?;
    Ok(json!({"operator": email, "since": since}))
}

/// `hand_back` of the cashier's open session: nobody else serves at its till from now. It gives the cashier's own rights
/// back, so it takes the cashier's own PIN, counted as any, whether or not someone was serving.
pub(crate) async fn hand_back(hc: &mut HookCtx<'_>, session: &Doc, params: &Value) -> Result<Value> {
    let pin = param(params, "pin").ok_or_else(|| Error::field("pin", "is required"))?;
    let ctx = hc.ctx;
    let me = own_session(ctx, session)?;
    let back = prove(hc.kernel, ctx.tenant, &me, pin).await?;
    if back.user != ctx.user {
        return Err(Error::Forbidden("only the session's cashier hands its till over".into()));
    }
    if s(session, "operator").is_some() {
        let sid = id(session, "id").ok_or_else(|| Error::internal("a session without an id"))?;
        let v = json!({"operator": null, "operator_since": null, "operator_limits": null});
        hc.kernel.set_values_tx(&sys(ctx), hc.tx, "PosOpeningEntry", sid, v.as_object().cloned().unwrap_or_default()).await?;
    }
    Ok(json!({"operator": null}))
}

/// What a sale at `profile` is held to: the caller's limits, narrowed by those of whoever serves at its session's till when
/// it is made online. A sale made offline is the cashier's own: nothing switches offline.
pub(crate) async fn for_sale(ctx: &Ctx, tx: &mut Tx, profile: &Profile, sale: &Doc) -> Result<Limits> {
    match id(sale, "pos_opening_entry") {
        Some(sid) if !b(sale, "sold_offline") => at_till(ctx, tx, profile, sid).await,
        _ => of(ctx, tx, profile).await,
    }
}

/// What the caller may do at session `sid`'s till now: their limits, narrowed by those of whoever serves at it.
pub(crate) async fn at_till(ctx: &Ctx, tx: &mut Tx, profile: &Profile, sid: Uuid) -> Result<Limits> {
    let own = of(ctx, tx, profile).await?;
    let found: Option<(Option<String>, Option<Value>)> =
        sqlx::query_as(r#"select "operator", operator_limits from e_pos_opening_entry where tenant_id = $1 and id = $2"#)
            .bind(ctx.tenant)
            .bind(sid)
            .fetch_optional(&mut **tx)
            .await?;
    match found {
        Some((Some(_), Some(theirs))) => {
            let theirs: Limits = serde_json::from_value(theirs).map_err(|e| Error::internal(format!("the limits of the person serving: {e}")))?;
            Ok(own.narrower(&theirs))
        }
        // Someone serves and nothing says what they may do: refused, never the cashier's rights.
        Some((Some(_), None)) => Err(Error::internal("the person serving at this till has no limits kept")),
        _ => Ok(own),
    }
}

/// How long an approval lasts at a register (its setting; five minutes when unset).
fn minutes(profile: &Doc) -> i64 {
    profile.get("approval_minutes").and_then(serde_json::Value::as_i64).filter(|m| *m > 0).unwrap_or(5)
}

/// Whether approval `approval` covers `act` at `figure` for the act or sale `used_for`, by
/// `cashier` in `session`: given for that sale, not lapsed, the session still open, the approver's
/// limits as they approved and the amount approved. `money` says a discount's figure is the sale's
/// amount rather than a line's percent.
pub(crate) async fn covers(
    tx: &mut Tx,
    tenant: Uuid,
    approval: Uuid,
    at: (&str, Uuid),
    act: Act,
    figure: Decimal,
    money: bool,
    used_for: Uuid,
) -> Result<bool> {
    let (cashier, session) = at;
    type Row = (Option<String>, Option<Uuid>, Option<String>, Option<Decimal>, Option<Value>, Option<String>, Option<String>, bool);
    let found: Option<Row> = sqlx::query_as(
        "select a.cashier, a.pos_opening_entry, a.action, a.amount, a.limits, a.used_for, a.sale, \
         coalesce(a.expires_at > now(), false) and coalesce(o.status = 'Open', false) \
         from e_pos_approval a left join e_pos_opening_entry o on o.tenant_id = a.tenant_id and o.id = a.pos_opening_entry \
         where a.tenant_id = $1 and a.id = $2",
    )
    .bind(tenant)
    .bind(approval)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((who, sess, action, amount, limits, used, sale, live)) = found else { return Ok(false) };
    if !live || !who.is_some_and(|w| w.eq_ignore_ascii_case(cashier)) || sess != Some(session) || action.as_deref() != Some(act.label()) {
        return Ok(false);
    }
    if sale.is_some_and(|s| s != used_for.to_string()) {
        return Ok(false);
    }
    if used.is_some_and(|u| u != used_for.to_string()) {
        return Ok(false);
    }
    let Some(theirs) = limits.and_then(|l| serde_json::from_value::<Limits>(l).ok()) else { return Ok(false) };
    Ok(if money { theirs.discount_amount.is_none_or(|c| figure <= c) } else { theirs.allows(act, figure) && amount.is_none_or(|a| figure <= a) })
}

/// Marks approvals used by `used_for`, refusing one another act took meanwhile (the rows locked).
pub(crate) async fn use_approvals(tx: &mut Tx, tenant: Uuid, approvals: &[Uuid], used_for: Uuid) -> Result<()> {
    for a in approvals {
        let taken: Option<(Option<String>, bool)> =
            sqlx::query_as("select used_for, coalesce(expires_at > now(), false) from e_pos_approval where tenant_id = $1 and id = $2 for update")
                .bind(tenant)
                .bind(a)
                .fetch_optional(&mut **tx)
                .await?;
        match taken {
            Some((Some(u), _)) if u != used_for.to_string() => return Err(Error::invalid("that approval was already used; ask again")),
            Some((None, false)) => return Err(Error::invalid("that approval has lapsed; ask again")),
            Some(_) => {}
            None => return Err(Error::invalid("no such approval")),
        }
        sqlx::query("update e_pos_approval set used_for = $3, updated_at = now() where tenant_id = $1 and id = $2")
            .bind(tenant)
            .bind(a)
            .bind(used_for.to_string())
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}
