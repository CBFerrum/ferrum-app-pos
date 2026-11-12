// Pricing a basket on this device with ERP's pricing crate built for the browser (vendor/pricing/, see its README): the same code the
// server prices an offline sale again with, so the totals agree. It is loaded only when a sale is priced offline, and its two files are
// kept by the till's worker (see `warmPricing`) so it is there with no network. Money travels as decimal strings, never floats.

import { t } from "@ferrum/client";

/** The snapshot schema this build of the engine reads (ERP's docs/pricing.md). Any other is refused, never guessed at. */
export const PRICING_SCHEMA = 1;

/** Said where the till has no offline prices: nothing kept, or what is kept is of a shape this till cannot read (a snapshot of 0.7.1, or of a newer schema). It never guesses. */
export const notAvailable = () => t("Offline pricing is not available on this device yet: it needs one connection to load this register's prices.");

export interface BasketLine {
  item: string;
  qty: string;
  uom?: string | null;
  /** Typed by the cashier: stands in for the price list's. */
  price?: string | null;
  /** Typed by the cashier: stands in for the pricing rule's. */
  discount_percent?: string | null;
}

export interface Basket {
  lines: BasketLine[];
  /** `YYYY-MM-DD HH:MM`, in the snapshot's time zone (`momentIn`). */
  at: string;
  customer?: string | null;
  customer_group?: string | null;
  discount_percent?: string;
}

/** What the till reads of ERP's snapshot (the rest is the engine's). `schema` is the only thing checked before the engine is asked. */
export interface PricingSnapshot {
  schema: number;
  valid_from: string;
  valid_until: string;
  time_zone: string | null;
  currency: string;
  precision: number;
  [engine: string]: unknown;
}

export interface PricedLine {
  key: string;
  item: string;
  qty: string;
  uom: string | null;
  conversion_factor: string;
  stock_qty: string;
  price_list_rate: string;
  discount_percent: string;
  promotion_percent: string;
  added_by_promotion: string | null;
  tax_rates: Record<string, string>;
}

export interface Priced {
  schema: number;
  lines: PricedLine[];
  /** Each promotion's part of each line (`line` is a line's `key`). */
  applied: { promotion: string; title: string; line: string; amount: string; code: string | null }[];
  totals: {
    lines: { key: string; rate: string; amount: string; net_amount: string; taxes: string[] }[];
    taxes: { key: string; tax_amount: string; deduct: boolean; reverse_charge: boolean; total: string }[];
    total: string;
    discount_amount: string;
    net_total: string;
    total_taxes: string;
    grand_total: string;
    rounding_adjustment: string;
    rounded_total: string;
  };
  tax_summary: { tax: string; description: string | null; account: string | null; category: string | null; rate: string; exemption_reason: string | null; taxable_amount: string; tax_amount: string }[];
}

type Glue = typeof import("../vendor/pricing/ferrum_erp_pricing.js");
let loading: Promise<Glue> | null = null;

/** Loads the engine once (about 650 KB of WebAssembly, in its own file, fetched and compiled here and not before). A failed load is tried again. */
export function loadPricing(source?: BufferSource): Promise<Glue> {
  const now =
    loading ??
    import("../vendor/pricing/ferrum_erp_pricing.js").then(async (glue) => {
      await glue.default(source ? { module_or_path: source } : undefined);
      return glue;
    });
  loading = now.catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** Brings the engine's two files to this device's cache (through the worker) without running it: the glue is fetched as a module, the WebAssembly by its address. */
export function warmPricing(): Promise<unknown> {
  const wasm = new URL("../vendor/pricing/ferrum_erp_pricing_bg.wasm", import.meta.url).href;
  return Promise.allSettled([import("../vendor/pricing/ferrum_erp_pricing.js"), fetch(wasm)]);
}

/** The moment `at` in a time zone as the engine reads it (`YYYY-MM-DD HH:MM`); the device's own when the snapshot names none. */
export function momentIn(timeZone: string | null | undefined, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || undefined, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// The engine reads the whole snapshot each time: its JSON is made once per snapshot, not once per change of the cart.
// ponytail: a book of tens of thousands of items parses on every pricing; a lookup kept in the engine would be the upgrade.
const text = new WeakMap<object, string>();
const TILL_ONLY = new Set(["catalog", "barcodes", "unpriced", "truncated", "buyer", "profile", "version", "signature", "built_at"]);

function snapshotText(snapshot: PricingSnapshot): string {
  let s = text.get(snapshot);
  if (s === undefined) {
    s = JSON.stringify(Object.fromEntries(Object.entries(snapshot).filter(([k]) => !TILL_ONLY.has(k))));
    text.set(snapshot, s);
  }
  return s;
}

/** The basket priced with the snapshot: promotions, taxes, rounding and totals as ERP gives them. Throws a snapshot of a schema it does not
 *  know, and the engine's own refusal (an item it was not given, a day it does not price). */
export async function priceBasket({ snapshot, basket }: { snapshot: PricingSnapshot; basket: Basket }): Promise<Priced> {
  if (snapshot.schema !== PRICING_SCHEMA) throw new Error(notAvailable());
  const glue = await loadPricing();
  const out = JSON.parse(glue.priceBasket(`{"snapshot":${snapshotText(snapshot)},"basket":${JSON.stringify(basket)}}`)) as Priced | { error: string };
  if ("error" in out) throw new Error(out.error);
  return out;
}
