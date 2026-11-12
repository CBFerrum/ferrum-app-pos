//! What a person may do at a register on their own (`PosRoleLimit`, R-1 to R-6): the rows of their
//! roles, a register's own row before the row for every register, the most generous role winning.
//! Someone none of whose roles has a row keeps what the register itself allowed before these rows
//! existed (its discount and price settings; a POS Manager, everything), so nothing changes on
//! upgrade until a business writes its rows.

use crate::logic::{Act, Limits};
use crate::{Profile, is_manager};
use ferrum_domain::util::{b, d, elevated, s};
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, Tx};
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
// without the cashier signing out. The PIN is kept only as an argon2id hash (`pos_staff_pin`), five
// wrong tries lock it for fifteen minutes, and it never reaches a record, a log or an action's
// audited parameters: it travels only in the body of the register's own endpoints. An approval is a
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

/// Sets the signed-in person's own PIN (kept as a hash; any wrong tries are forgotten).
pub(crate) async fn set_pin(k: &Kernel, ctx: &Ctx, pin: &str) -> Result<()> {
    check_pin_shape(pin)?;
    if ctx.email.is_empty() || ctx.outside {
        return Err(Error::Forbidden("only a member of the workspace sets a PIN".into()));
    }
    let hash = ferrum_kernel::auth::hash_password(pin.to_string()).await?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    sqlx::query(
        "insert into pos_staff_pin (tenant_id, email, pin_hash) values ($1, lower($2), $3) \
         on conflict (tenant_id, email) do update set pin_hash = excluded.pin_hash, failures = 0, locked_until = null, set_at = now()",
    )
    .bind(ctx.tenant)
    .bind(&ctx.email)
    .bind(hash)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
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

/// What a till asks to have approved.
pub(crate) struct Ask<'a> {
    pub profile: Uuid,
    pub approver: &'a str,
    pub pin: &'a str,
    pub act: Act,
    pub amount: Option<Decimal>,
    pub reason: &'a str,
    /// The sale or draft it is for; none only for opening the drawer.
    pub sale: Option<Uuid>,
}

/// Approves one act for the signed-in cashier in their open session at the register, by another
/// person's PIN, when that person's own limits allow it: the approval's id.
pub(crate) async fn approve(k: &Kernel, ctx: &Ctx, ask: Ask<'_>) -> Result<Value> {
    if ask.reason.trim().is_empty() {
        return Err(Error::field("reason", "say why"));
    }
    if ask.sale.is_none() && ask.act != Act::NoSale {
        return Err(Error::field("sale", "name the sale (or draft) it is for"));
    }
    if ask.approver.trim().eq_ignore_ascii_case(&ctx.email) {
        return Err(Error::field("approver", "someone else approves what is beyond your own limits"));
    }
    k.get(ctx, "PosProfile", ask.profile, false).await?;
    let approver = prove(k, ctx.tenant, ask.approver, ask.pin).await?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let profile = Profile::load(k, ctx, &mut tx, ask.profile).await?;
    let session = crate::open_session_in(&mut tx, ctx.tenant, ask.profile, &ctx.email)
        .await?
        .ok_or_else(|| Error::invalid(format!("open your session at {} first", profile.name())))?;
    let theirs = of(&approver, &mut tx, &profile).await?;
    if !theirs.allows(ask.act, ask.amount.unwrap_or_default()) {
        return Err(Error::Forbidden(format!("{} may not approve this either", approver.email)));
    }
    let row = json!({
        "pos_profile": profile.id, "pos_opening_entry": session, "cashier": ctx.email.to_lowercase(), "approver": approver.email.to_lowercase(),
        "action": ask.act.label(), "amount": ask.amount.map(|a| a.normalize().to_string()), "reason": ask.reason.trim(),
        "limits": theirs, "approved_at": chrono::Utc::now().to_rfc3339(), "sale": ask.sale.map(|s| s.to_string()),
        "expires_at": (chrono::Utc::now() + chrono::Duration::minutes(minutes(&profile.doc))).to_rfc3339(),
    });
    let made = k.insert_tx(&elevated(ctx), &mut tx, "PosApproval", row.as_object().cloned().unwrap_or_default()).await?;
    tx.commit().await?;
    Ok(json!({"approval": made.get("id"), "approver": approver.email, "action": ask.act.label()}))
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
