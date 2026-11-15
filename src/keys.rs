//! Point of Sale's handle on the vault (Ferrum docs/operations.md, "The vault"). A till's offline snapshot is signed with
//! a key derived from Point of Sale's own key in the workspace for that snapshot, kept nowhere (`snapshot.rs`). Until
//! 0.7.5 it was the server's key (`FERRUM_SECRET_KEY`) that signed it. Nothing checks a signature yet (a till keeps it,
//! only the server could check it), so nothing signed the old way needs that key again.

use ferrum_kernel::vault::{Scope, Vault};
use ferrum_kernel::{Error, Kernel, Result, Site};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// Each registration's handle, by the site it registered: one process may hold kernels of several registries (a test's
/// side by side), and each kernel accepts only the handle its own registry gave.
static HANDLES: Mutex<Vec<(usize, Vault)>> = Mutex::new(Vec::new());

fn address(site: &Arc<dyn Site>) -> usize {
    Arc::as_ptr(site) as *const () as usize
}

/// Keeps the handle Point of Sale's registration was given, beside the site it registered with it.
pub(crate) fn remember(site: &Arc<dyn Site>, v: Vault) {
    HANDLES.lock().unwrap_or_else(|e| e.into_inner()).push((address(site), v));
}

fn handle(k: &Kernel) -> Result<Vault> {
    let missing = || Error::Unavailable("Point of Sale was registered without its vault handle: register it as the server does, hooks.app(\"pos\", …)".into());
    let at = address(k.hooks.site("pos").ok_or_else(missing)?);
    let held = HANDLES.lock().unwrap_or_else(|e| e.into_inner());
    held.iter().rev().find(|(a, _)| *a == at).map(|(_, v)| v.clone()).ok_or_else(missing)
}

/// What [`snapshot_signature`] derives its key for: the register and the version, digested to fit a purpose.
pub(crate) fn purpose(profile: Uuid, version: &str) -> String {
    format!("snapshot:{}", hex::encode(Sha256::digest(format!("{profile}:{version}"))))
}

/// The signature of `version` of `profile`'s snapshot in `tenant`: 64 hexadecimal digits of a key derived for it from
/// Point of Sale's key in the workspace (HKDF, keyed by that key, so nobody without it can make it). None while the
/// vault is closed (said in the log): the snapshot goes unsigned, as on a server without a key before.
pub(crate) async fn snapshot_signature(k: &Kernel, tenant: Uuid, profile: Uuid, version: &str) -> Result<Option<String>> {
    match handle(k)?.derive(k, Scope::Workspace(tenant), &purpose(profile, version)).await {
        Ok(key) => Ok(Some(hex::encode(key.bytes()))),
        Err(Error::Unavailable(why)) => {
            tracing::warn!(%profile, "a till's snapshot goes unsigned: {why}");
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_snapshots_purpose_is_one_the_vault_takes() {
        let p = super::purpose(uuid::Uuid::nil(), &"f".repeat(64));
        assert!(p.len() <= 100 && p.starts_with("snapshot:") && p.bytes().skip(9).all(|b| b.is_ascii_hexdigit()), "{p}");
    }
}
