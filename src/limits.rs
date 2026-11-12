//! What a person may do at a register on their own (`PosRoleLimit`, R-1 to R-6): the rows of their
//! roles, a register's own row before the row for every register, the most generous role winning.
//! Someone none of whose roles has a row keeps what the register itself allowed before these rows
//! existed (its discount and price settings; a POS Manager, everything), so nothing changes on
//! upgrade until a business writes its rows.

use crate::logic::Limits;
use crate::{Profile, is_manager};
use ferrum_domain::util::{b, d, s};
use ferrum_kernel::{Ctx, Doc, Result, Tx};
use rust_decimal::Decimal;
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
