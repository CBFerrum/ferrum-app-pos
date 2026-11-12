//! Stock a till sold while it was offline beyond what the warehouse held (FEO-026). The sale stands,
//! as the customer paid and took the goods; the shortfall is recorded when it arrives
//! (`invoice::record_shortfalls`) and waits until someone puts it right (counts, moves stock in or
//! writes it off) and says how.

use async_trait::async_trait;
use chrono::Utc;
use ferrum_domain::util::{elevated, id};
use ferrum_kernel::{Doc, DocHook, Error, HookCtx, Result};
use serde_json::{Value, json};

pub struct ShortfallHook;

#[async_trait]
impl DocHook for ShortfallHook {
    fn name(&self) -> &'static str {
        "pos.shortfall"
    }

    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, params: &Value) -> Result<Option<Value>> {
        if name != "resolve" {
            return Ok(None);
        }
        let how =
            params["resolution"].as_str().map(str::trim).filter(|r| !r.is_empty()).ok_or_else(|| Error::field("resolution", "say how it was put right"))?;
        let shortfall = id(doc, "id").ok_or_else(|| Error::internal("a shortfall without an id"))?;
        let by = if hc.ctx.email.is_empty() { hc.ctx.user.to_string() } else { hc.ctx.email.clone() };
        let mut change = Doc::new();
        for (k, v) in [("status", json!("Put Right")), ("resolution", json!(how)), ("resolved_by", json!(by)), ("resolved_at", json!(Utc::now().to_rfc3339()))]
        {
            change.insert(k.into(), v);
        }
        hc.kernel.set_values_tx(&elevated(hc.ctx), hc.tx, "PosStockShortfall", shortfall, change).await?;
        Ok(Some(json!({"status": "Put Right"})))
    }
}

/// A price difference of a sale made offline is looked at by a person, who says what was found.
pub struct DifferenceHook;

#[async_trait]
impl DocHook for DifferenceHook {
    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, params: &Value) -> Result<Option<Value>> {
        if name != "review" {
            return Ok(None);
        }
        let found =
            params["resolution"].as_str().map(str::trim).filter(|r| !r.is_empty()).ok_or_else(|| Error::field("resolution", "say what was found and done"))?;
        let by = if hc.ctx.email.is_empty() { hc.ctx.user.to_string() } else { hc.ctx.email.clone() };
        let mut change = Doc::new();
        for (k, v) in [("status", json!("Reviewed")), ("resolution", json!(found)), ("resolved_by", json!(by)), ("resolved_at", json!(Utc::now().to_rfc3339()))]
        {
            change.insert(k.into(), v);
        }
        hc.kernel.set_values_tx(&elevated(hc.ctx), hc.tx, "PosPriceDifference", id(doc, "id").unwrap_or_default(), change).await?;
        Ok(Some(json!({"status": "Reviewed"})))
    }
}
