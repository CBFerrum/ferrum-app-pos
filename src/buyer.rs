//! The buyer's tax registration on a sale (PS-54, PS-55): a buyer who gives a registration number
//! gets a full invoice of their own at once instead of a simplified receipt consolidated at closing.
//!
//! Nothing here knows a country. Which fields of a customer hold a registration, and whether a
//! customer holding one is a registered business, are what the installed countries say through
//! ERP's localization seam (`tax_ids`, `registered_business`): a field is a registration field when
//! a customer holding only a value there shows that value among its `tax_ids`; a number makes a
//! registered buyer when the countries say so of a customer holding it (some need a category beside
//! the number: the select field's other options are tried, as a person would).

use crate::Profile;
use ferrum_app_erp::localization::{registered_business, tax_ids};
use ferrum_domain::util::{b, elevated, id, s, set};
use ferrum_kernel::{Ctx, Doc, Error, Filter, HookCtx, ListQuery, Op, Result};
use ferrum_meta::FieldType;
use serde_json::{Value, json};
use uuid::Uuid;

/// The customer fields the installed countries keep registrations in, in the schema's order.
pub fn registration_fields(ctx: &Ctx) -> Vec<String> {
    let Some(customer) = ctx.schema.entity("Customer") else { return Vec::new() };
    let probe = "REG-PROBE-0";
    customer
        .def
        .fields
        .iter()
        .filter(|f| matches!(f.ftype, FieldType::Data | FieldType::Text))
        .filter(|f| {
            let mut doc = Doc::new();
            doc.insert(f.name.clone(), json!(probe));
            tax_ids(ctx, "Customer", &doc).iter().any(|t| t.value == probe)
        })
        .map(|f| f.name.clone())
        .collect()
}

/// A customer's other fields, as a new one is made with the number in `field`, such that the
/// countries hold it for a registered business: the number alone when that does, else with one
/// select field set to the first option that does. `None` when no way makes it registered.
fn registered_as(ctx: &Ctx, field: &str, number: &str) -> Option<Doc> {
    let mut base = Doc::new();
    base.insert(field.into(), json!(number));
    let customer = ctx.schema.entity("Customer")?;
    // As the kernel would default it: a select's default stands until a person sets another.
    for f in customer.def.fields.iter().filter(|f| f.ftype == FieldType::Select) {
        if let Some(d) = f.default.clone().filter(|d| !d.is_null()) {
            base.insert(f.name.clone(), d);
        }
    }
    if registered_business(ctx, "Customer", &base) {
        return Some(base);
    }
    for f in customer.def.fields.iter().filter(|f| f.ftype == FieldType::Select && f.options.len() <= 12) {
        for o in &f.options {
            let mut trial = base.clone();
            trial.insert(f.name.clone(), json!(o));
            if registered_business(ctx, "Customer", &trial) {
                return Some(trial);
            }
        }
    }
    None
}

/// The number as it is compared: no spaces, capitals.
fn norm(n: &str) -> String {
    n.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_uppercase()
}

/// The customers holding `number` in one of `fields`, as typed or in its compared form.
async fn holders(hc: &mut HookCtx<'_>, fields: &[String], number: &str) -> Result<Vec<Uuid>> {
    let system = elevated(hc.ctx);
    let mut found: Vec<Uuid> = Vec::new();
    for f in fields {
        for value in [number.to_string(), norm(number)] {
            let q = ListQuery {
                filters: vec![Filter { field: f.clone(), op: Op::Eq, value: json!(value) }],
                fields: Some(vec!["id".into()]),
                limit: Some(3),
                ..Default::default()
            };
            for r in hc.kernel.list(&system, "Customer", &q).await?.rows {
                if let Some(c) = id(&r, "id")
                    && !found.contains(&c)
                {
                    found.push(c);
                }
            }
        }
    }
    Ok(found)
}

/// What a sale's buyer came to: the customer, and whether they get a tax invoice.
pub(crate) struct Buyer {
    pub tax_invoice: bool,
}

/// Settles the buyer a sale names by tax registration: finds the customer holding it (or makes one
/// as the register says), sets the sale's customer, and says whether the buyer is a registered
/// business. Serialised per number, so two tills never make the same customer twice.
pub(crate) async fn resolve(hc: &mut HookCtx<'_>, doc: &mut Doc, profile: &Profile) -> Result<Option<Buyer>> {
    let Some(raw) = s(doc, "buyer_tax_id").map(str::trim).filter(|n| !n.is_empty()).map(str::to_string) else { return Ok(None) };
    if b(doc, "is_return") {
        return Err(Error::field("buyer_tax_id", "a return names its sale, not a buyer"));
    }
    set(doc, "buyer_tax_id", raw.clone());
    let fields = registration_fields(hc.ctx);
    // Countries that keep registrations of their own say so; without any, the core's tax id field is the place.
    let place: Vec<String> = if fields.is_empty() { vec!["tax_id".to_string()] } else { fields.clone() };
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 0))").bind(format!("{}:buyer:{}", hc.ctx.tenant, norm(&raw))).execute(&mut **hc.tx).await?;
    let found = holders(hc, &place, &raw).await?;
    let customer = match found.as_slice() {
        [one] => *one,
        [_, _, ..] => return Err(Error::field("buyer_tax_id", format!("{raw} is held by more than one customer; choose the customer"))),
        [] => {
            if s(&profile.doc, "buyer_customer") == Some("Find Only") {
                return Err(Error::field("buyer_tax_id", format!("no customer holds {raw}: ask someone to add the customer, or pick them")));
            }
            make(hc, doc, profile, &place, &raw).await?
        }
    };
    let rec = hc.kernel.get_tx(&elevated(hc.ctx), hc.tx, "Customer", customer, false).await?;
    // Without a country keeping registrations a number is a number; with one, its verdict stands.
    let registered = fields.is_empty() || registered_business(hc.ctx, "Customer", &rec);
    if !fields.is_empty() && !registered {
        return Err(Error::field("buyer_tax_id", format!("{raw} is not a registration the country rules accept for a business")));
    }
    set(doc, "customer", customer.to_string());
    set(doc, "customer_name", rec.get("customer_name").cloned().unwrap_or(Value::Null));
    let full = s(&profile.doc, "registered_buyer") != Some("Simplified Receipt");
    Ok(Some(Buyer { tax_invoice: registered && full }))
}

/// A customer for a registration nobody holds: named as given (else by the number), in the
/// register's group for customers made at the till, holding the number where the countries read it.
async fn make(hc: &mut HookCtx<'_>, doc: &Doc, profile: &Profile, place: &[String], number: &str) -> Result<Uuid> {
    let fields = registration_fields(hc.ctx);
    let (field, mut cust) = if fields.is_empty() {
        let mut d = Doc::new();
        d.insert("tax_id".into(), json!(number));
        ("tax_id".to_string(), d)
    } else {
        let mut chosen = None;
        // The register's company decides between countries: the field it holds a registration in itself.
        let company = hc.kernel.get_tx(&elevated(hc.ctx), hc.tx, "Company", id(doc, "company").unwrap_or_default(), false).await?;
        let mut order: Vec<&String> = place.iter().collect();
        order.sort_by_key(|f| company.get(f.as_str()).is_none_or(|v| v.is_null() || v == ""));
        for f in order {
            if let Some(d) = registered_as(hc.ctx, f, number) {
                chosen = Some((f.clone(), d));
                break;
            }
        }
        chosen.ok_or_else(|| Error::field("buyer_tax_id", format!("{number} is not a registration the country rules accept for a business")))?
    };
    let _ = field;
    let name = s(doc, "buyer_name").map(str::trim).filter(|n| !n.is_empty()).unwrap_or(number);
    cust.insert("customer_name".into(), json!(name));
    if let Some(g) = id(&profile.doc, "buyer_group") {
        cust.insert("customer_group".into(), json!(g.to_string()));
    }
    let made = hc.kernel.insert_tx(&elevated(hc.ctx), hc.tx, "Customer", cust).await?;
    id(&made, "id").ok_or_else(|| Error::internal("a customer without an id"))
}
