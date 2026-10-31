// The register's pure parts: the cart, tender arithmetic, and the outbox of sales made while the
// connection was down (or the session had ended). Prices, taxes and totals come from the server
// (`_calc`), or offline from the register's price book with the server's own engine (offline.ts);
// a queued sale carries its idempotency key, so sending it again can never sell twice, and the
// person who made it, so it is sent in their name.

import { formatDecimal } from "@ferrum/client";
import type { Doc } from "@ferrum/records";

export interface CartLine {
  key: string;
  item: string;
  item_name: string;
  qty: number;
}

/** Adds `qty` of an item: onto its existing line, or as a new line at the end. */
export function addItem(lines: CartLine[], item: { id: string; name: string }, qty = 1, key = item.id): CartLine[] {
  const at = lines.findIndex((l) => l.item === item.id);
  if (at < 0) return [...lines, { key, item: item.id, item_name: item.name, qty }];
  return lines.map((l, i) => (i === at ? { ...l, qty: round(l.qty + qty) } : l));
}

/** Sets a line's quantity; zero or less removes the line. */
export function setQty(lines: CartLine[], key: string, qty: number): CartLine[] {
  if (!(qty > 0)) return lines.filter((l) => l.key !== key);
  return lines.map((l) => (l.key === key ? { ...l, qty: round(qty) } : l));
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export interface Tender {
  mode_of_payment: string;
  amount: string;
}

/** Tendered amounts that count (positive numbers), as the invoice's payment rows. */
export function paymentRows(tenders: Tender[]): Tender[] {
  return tenders.filter((t) => Number(t.amount) > 0).map((t) => ({ mode_of_payment: t.mode_of_payment, amount: String(Number(t.amount)) }));
}

/** What is still owed (positive) or handed back (negative) after `tendered`, to the cent. */
export function balance(due: number, tendered: number): number {
  return Math.round((due - tendered) * 100) / 100 || 0; // never -0
}

/** Cash notes a cashier would likely be handed for `due`: exact, then round amounts above it. */
export function quickCash(due: number): number[] {
  if (!(due > 0)) return [];
  const out = [Math.round(due * 100) / 100];
  for (const step of [10, 50, 100, 500, 2000]) {
    const up = Math.ceil(due / step) * step;
    if (up > out[out.length - 1] && out.length < 4) out.push(up);
  }
  return out;
}

/** The POS invoice the till sends (for `_calc` and for the sale itself). */
export function invoiceBody(o: { profile: string; session: string; customer: string | null; lines: CartLine[]; tenders: Tender[] }): Doc {
  return {
    pos_profile: o.profile,
    pos_opening_entry: o.session,
    customer: o.customer,
    items: o.lines.map((l) => ({ item: l.item, qty: String(l.qty) })),
    payments: paymentRows(o.tenders),
  };
}

// ── outbox ──

export interface QueuedSale {
  key: string;
  body: Doc;
  at: string;
  /** Who made the sale (their email): it is sent only while they are signed in. */
  by?: string;
  /** What the till took for it (offline: priced from the price book). */
  total?: string;
  /** The last refusal from the server, when it answered (the sale then needs a person). */
  error?: string;
}

const OUTBOX = "ferrum.pos.outbox";

export function loadOutbox(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): QueuedSale[] {
  try {
    const v: unknown = JSON.parse(storage?.getItem(OUTBOX) ?? "[]");
    return Array.isArray(v) ? (v as QueuedSale[]).filter((s) => typeof s?.key === "string" && typeof s.body === "object") : [];
  } catch {
    return [];
  }
}

export function saveOutbox(list: QueuedSale[], storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(OUTBOX, JSON.stringify(list));
  } catch {
    // Storage full or blocked: the sale stays on screen with its error instead.
  }
}

/** Whether a failed send should wait — for the connection, or for the person to sign in again
 *  (401) — (true) or needs a person (false). */
export function isTransient(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  return status === undefined || status === 0 || status === 401 || status === 408 || status === 429 || status >= 500;
}

/**
 * Sends queued sales oldest first. Sent ones leave the queue; ones the server refuses keep its
 * message and wait for a person (retry or discard); a lost connection stops the run, so order is
 * kept for the next one.
 */
export async function flushOutbox(list: QueuedSale[], send: (s: QueuedSale) => Promise<void>): Promise<QueuedSale[]> {
  const left: QueuedSale[] = [];
  let offline = false;
  for (const sale of list) {
    if (offline || sale.error) {
      left.push(sale);
      continue;
    }
    try {
      await send(sale);
    } catch (e) {
      if (isTransient(e)) offline = true;
      left.push(isTransient(e) ? sale : { ...sale, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return left;
}

/** A receipt to print (thermal 80 or 58 mm, or A4, as the profile says); every value is escaped. */
export function receiptHtml(profile: Doc, sale: Doc): string {
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const money = (v: unknown) => formatDecimal(v ?? 0, 2);
  const titleOf = (d: Doc | undefined, field: string) => str((d?._titles as Record<string, unknown> | undefined)?.[field]) || str(d?.[field]);
  const esc = (s: unknown) => str(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const wide = str(profile.print_format) === "A4" ? "190mm" : str(profile.print_format) === "Thermal 58mm" ? "48mm" : "72mm";
  const rows = ((sale.items as Doc[] | undefined) ?? [])
    .map((r) => `<tr><td>${esc(r.item_name)}<br><small>${esc(r.qty)} × ${esc(money(r.rate))}</small></td><td class="r">${esc(money(r.amount))}</td></tr>`)
    .join("");
  const pays = ((sale.payments as Doc[] | undefined) ?? [])
    .map((p) => `<tr><td>${esc(titleOf(p, "mode_of_payment"))}</td><td class="r">${esc(money(p.amount))}</td></tr>`)
    .join("");
  const line = (label: string, v: unknown) => `<tr><td>${label}</td><td class="r">${esc(money(v))}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(sale.number)}</title><style>
    body{font:12px/1.35 ui-monospace,Menlo,monospace;width:${wide};margin:0 auto;padding:4mm 0;color:#000}
    table{width:100%;border-collapse:collapse}td{vertical-align:top;padding:1px 0}.r{text-align:right}
    hr{border:0;border-top:1px dashed #000;margin:6px 0}h1{font-size:14px;text-align:center;margin:0 0 4px}p{margin:2px 0;text-align:center;white-space:pre-line}
  </style></head><body>
    <h1>${esc(profile.profile_name)}</h1>${profile.receipt_header ? `<p>${esc(profile.receipt_header)}</p>` : ""}
    <p>${esc(sale.number)} · ${esc(sale.posting_date)}${sale.customer_name ? `<br>${esc(sale.customer_name)}` : ""}</p><hr>
    <table>${rows}</table><hr>
    <table>${line("Subtotal", sale.total)}${num(sale.discount_amount) ? line("Discount", -num(sale.discount_amount)) : ""}${line("Taxes", sale.total_taxes)}
    <tr><td><b>Total</b></td><td class="r"><b>${esc(money(sale.rounded_total ?? sale.grand_total))}</b></td></tr></table><hr>
    <table>${pays}${num(sale.change_amount) ? line("Change", sale.change_amount) : ""}</table>
    ${profile.receipt_footer ? `<hr><p>${esc(profile.receipt_footer)}</p>` : ""}
  </body></html>`;
}
