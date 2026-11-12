// The register's pure parts: the cart, tender arithmetic, and the outbox of sales made while the
// connection was down (or the session had ended). Prices, taxes and totals come from the server
// (`_calc`), or offline from the register's price book with the server's own engine (offline.ts);
// a queued sale carries its idempotency key and its own id, so sending it again can never sell
// twice, and the person who made it, so it is sent in their name.

import { formatDecimal, t as tr } from "@ferrum/client";
import type { Doc } from "@ferrum/records";

export interface CartLine {
  key: string;
  item: string;
  item_name: string;
  qty: number;
  /** Percent the cashier typed; left out, the pricing rules decide. */
  discount?: string;
  /** Price the cashier typed; left out, the price list decides. */
  price?: string;
  note?: string;
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

/** Changes what the cashier typed on a line; an empty value takes it off again. */
export function adjustLine(lines: CartLine[], key: string, patch: Partial<Pick<CartLine, "discount" | "price" | "note">>): CartLine[] {
  return lines.map((l) => {
    if (l.key !== key) return l;
    const next = { ...l, ...patch };
    for (const k of ["discount", "price", "note"] as const) if (!next[k]?.trim()) delete next[k];
    return next;
  });
}

/** What the scan box holds: "3*8901234" is three of that code, anything else is the code itself. */
export function parseScan(text: string): { qty: number; code: string } {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[*×]\s*(\S.*?)\s*$/.exec(text);
  const qty = m ? Number(m[1]) : 0;
  return qty > 0 && m ? { qty, code: m[2] } : { qty: 1, code: text.trim() };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export interface Tender {
  mode_of_payment: string;
  amount: string;
  /** A card approval code, a UPI reference. */
  reference_no?: string;
  /** Points redeemed with a Loyalty Points method: the server works out their amount. */
  loyalty_points?: number;
  /** A card's code and PIN (stored value): held in memory for the one request, never queued or kept. */
  stored_value_code?: string;
  stored_value_pin?: string;
}

/** Tendered amounts that count (positive numbers), as the invoice's payment rows. */
export function paymentRows(tenders: Tender[]): Doc[] {
  return tenders.flatMap((t): Doc[] => {
    const points = Number(t.loyalty_points ?? 0);
    if (points > 0) return [{ mode_of_payment: t.mode_of_payment, loyalty_points: points }];
    if (!(Number(t.amount) > 0)) return [];
    const reference = t.reference_no?.trim();
    const code = t.stored_value_code?.trim();
    const pin = t.stored_value_pin?.trim();
    return [
      {
        mode_of_payment: t.mode_of_payment,
        amount: String(Number(t.amount)),
        ...(reference ? { reference_no: reference } : {}),
        ...(code ? { stored_value_code: code, ...(pin ? { stored_value_pin: pin } : {}) } : {}),
      },
    ];
  });
}

/** A sale the till could not send, as it is kept and sent later: marked sold offline, with the total it took payment for and, when this device
 *  priced it from its snapshot, that snapshot's version (the server prices it again with exactly it). A sale the server priced before the connection
 *  was lost names no snapshot: only the total is checked. */
export function offlineSale(sale: Doc, o: { total: number | string; snapshot?: string | null }): Doc {
  return { ...sale, sold_offline: true, till_total: String(o.total), ...(o.snapshot ? { price_snapshot: o.snapshot } : {}) };
}

/** The registration a buyer gave: its number and, for a customer made from it, their name. */
export interface Buyer {
  taxId: string;
  name?: string;
}

/** A line taken off the sale after it was rung (`voided_lines`): what, how many, its amount, and the reason (a `PosReason`). */
export interface Voided {
  item: string;
  item_name: string;
  qty: number;
  amount: string;
  reason: string;
}

/** The code (and PIN) of a card sold or topped up on a line, by the line's key: in memory, for the
 *  requests of this sale only. */
export type LineCards = Record<string, { code: string; pin?: string }>;

/** Whether a body carries a card's code or PIN, which must never be queued or kept. */
export const carriesCard = (body: Doc): boolean =>
  [...((body.items as Doc[] | undefined) ?? []), ...((body.payments as Doc[] | undefined) ?? [])].some((r) => r.stored_value_code || r.stored_value_pin);

/** What is still owed (positive) or handed back (negative) after `tendered`, to the cent. */
export function balance(due: number, tendered: number): number {
  return Math.round((due - tendered) * 100) / 100 || 0; // never -0
}

/** Cash a cashier would likely be handed for `due`: exact, then round amounts above it, going up
 *  by the steps of the currency's notes. */
export function quickCash(due: number, steps: number[] = [10, 50, 100, 500, 2000]): number[] {
  if (!(due > 0)) return [];
  const out = [Math.round(due * 100) / 100];
  for (const step of steps) {
    const up = Math.round(Math.ceil(due / step) * step * 100) / 100;
    if (up > out[out.length - 1] && out.length < 4) out.push(up);
  }
  return out;
}

/** The POS invoice the till sends (for `_calc` and for the sale itself). `id` is the sale's own,
 *  made on the device: with it a sale sent twice can never be sold twice, however long it waited. */
export function invoiceBody(o: {
  id?: string;
  profile: string;
  session: string;
  customer: string | null;
  lines: CartLine[];
  tenders: Tender[];
  /** Approvals by another person (ids), each used once by this sale. */
  approvals?: string[];
  voided?: Voided[];
  invoiceNow?: boolean;
  cards?: LineCards;
  /** A buyer who gave a tax registration (`buyer_tax_id`, with a name for a customer made from it): the server finds or makes the customer. */
  buyer?: Buyer | null;
  /** Promotion codes the buyer gave (`promotion_codes`, space separated): the server checks them. */
  codes?: string[];
}): Doc {
  return {
    ...(o.id ? { id: o.id } : {}),
    pos_profile: o.profile,
    pos_opening_entry: o.session,
    customer: o.customer,
    items: o.lines.map((l) => ({
      item: l.item,
      qty: String(l.qty),
      ...(l.discount ? { discount_percent: l.discount } : {}),
      ...(l.price ? { manual_rate: l.price } : {}),
      ...(l.note ? { note: l.note } : {}),
      ...(o.cards?.[l.key]?.code ? { stored_value_code: o.cards[l.key].code, ...(o.cards[l.key].pin ? { stored_value_pin: o.cards[l.key].pin } : {}) } : {}),
    })),
    payments: paymentRows(o.tenders),
    ...(o.approvals?.length ? { approvals: o.approvals.map((approval) => ({ approval })) } : {}),
    ...(o.voided?.length ? { voided_lines: o.voided.map((v) => ({ item: v.item, qty: String(v.qty), amount: v.amount, reason: v.reason })) } : {}),
    ...(o.invoiceNow ? { invoice_now: true } : {}),
    ...(o.buyer?.taxId.trim() ? { buyer_tax_id: o.buyer.taxId.trim(), ...(o.buyer.name?.trim() ? { buyer_name: o.buyer.name.trim() } : {}) } : {}),
    ...(o.codes?.length ? { promotion_codes: o.codes.join(" ") } : {}),
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

/** Keeps the queue on this device; false when the device refuses (storage full or blocked), so
 *  the till can say the sale is not safe instead of pretending it is. */
export function saveOutbox(list: QueuedSale[], storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): boolean {
  try {
    if (!storage) return false;
    storage.setItem(OUTBOX, JSON.stringify(list));
    return true;
  } catch {
    return false;
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
 * kept for the next one. A refusal is first checked with `recorded`: a sale an earlier try got
 * through (the answer was lost on the way back) is in the books, so it leaves the queue too.
 */
export async function flushOutbox(
  list: QueuedSale[],
  send: (s: QueuedSale) => Promise<void>,
  recorded?: (s: QueuedSale) => Promise<boolean>,
): Promise<QueuedSale[]> {
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
      if (isTransient(e)) {
        offline = true;
        left.push(sale);
      } else if (!(await recorded?.(sale).catch(() => false))) {
        left.push({ ...sale, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return left;
}

/** A sale as the server answers a save carries no link titles: name its payment methods from the
 *  register's own, so the receipt says Cash, not an id. */
export function withMethodNames(profile: Doc, sale: Doc): Doc {
  const title = (d: Doc) => String((d._titles as Record<string, unknown> | undefined)?.mode_of_payment ?? "");
  const names = new Map(((profile.payments as Doc[] | undefined) ?? []).map((r) => [String(r.mode_of_payment), title(r)] as const));
  const payments = ((sale.payments as Doc[] | undefined) ?? []).map((p) => ({ ...p, _titles: { mode_of_payment: title(p) || names.get(String(p.mode_of_payment)) || "" } }));
  return { ...sale, payments };
}

/** The receipt of a sale kept on the device until it can be sent: the priced lines (names, rates,
 *  amounts) come from the totals the till worked out, what was paid from the sale itself; the
 *  server numbers the sale when it arrives, so it says so. */
export function keptReceipt(profile: Doc, priced: Doc | null, sale: Doc, o: { customer?: string; due: number; change: number }): Doc {
  return withMethodNames(profile, {
    ...(priced ?? {}),
    ...(o.customer ? { customer_name: o.customer } : {}),
    payments: sale.payments,
    posting_date: sale.posting_date,
    number: tr("Not sent yet"),
    rounded_total: String(o.due),
    change_amount: String(o.change),
    pending: true,
  });
}

export const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
/** Escapes a value for printing: nothing a sale or a person wrote becomes markup. */
export const esc = (s: unknown) => str(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A page to print (thermal 80 or 58 mm, or A4, as the register says) around `body`, which has
 *  escaped everything it holds. */
export function printPage(profile: Doc, title: string, body: string): string {
  const wide = str(profile.print_format) === "A4" ? "190mm" : str(profile.print_format) === "Thermal 58mm" ? "48mm" : "72mm";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body{font:12px/1.35 ui-monospace,Menlo,monospace;width:${wide};margin:0 auto;padding:4mm 0;color:#000}${""/* ui-lint-allow raw-color: a printed receipt is its own document, black on paper, not interface */}
    table{width:100%;border-collapse:collapse}td{vertical-align:top;padding:1px 0}.r{text-align:right}
    hr{border:0;border-top:1px dashed #000;margin:6px 0}h1{font-size:14px;text-align:center;margin:0 0 4px}p{margin:2px 0;text-align:center;white-space:pre-line}${""/* ui-lint-allow raw-color: a printed receipt is its own document, black on paper, not interface */}
  </style></head><body>${body}</body></html>`;
}

/** The till's own receipt, for when the server's cannot be had (no connection, or a sale not yet sent): it says so
 *  on its face, because it is not the register's numbered receipt (its template, tax by rate, registrations);
 *  every value is escaped. The server's template is the receipt (`GET /receipt/{sale}`, `POST /reprint`). */
export function fallbackReceiptHtml(profile: Doc, sale: Doc): string {
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const money = (v: unknown) => formatDecimal(v ?? 0, 2);
  const titleOf = (d: Doc | undefined, field: string) => str((d?._titles as Record<string, unknown> | undefined)?.[field]) || str(d?.[field]);
  const rows = ((sale.items as Doc[] | undefined) ?? [])
    .map(
      (r) =>
        `<tr><td>${esc(r.item_name)}<br><small>${esc(r.qty)} × ${esc(money(r.rate))}</small>${r.note ? `<br><small>${esc(r.note)}</small>` : ""}</td><td class="r">${esc(money(r.amount))}</td></tr>`,
    )
    .join("");
  const pays = ((sale.payments as Doc[] | undefined) ?? [])
    .map((p) => `<tr><td>${esc(titleOf(p, "mode_of_payment"))}</td><td class="r">${esc(money(p.amount))}</td></tr>`)
    .join("");
  const line = (label: string, v: unknown) => `<tr><td>${esc(label)}</td><td class="r">${esc(money(v))}</td></tr>`;
  return printPage(
    profile,
    str(sale.number),
    `
    <p><b>${esc(tr("Printed on this device: not the register's receipt"))}</b></p>
    <h1>${esc(profile.profile_name)}</h1>${profile.receipt_header ? `<p>${esc(profile.receipt_header)}</p>` : ""}
    <p>${sale.is_return ? `<b>${esc(tr("RETURN"))}</b>${sale.against ? tr(" of {value}", { value: esc(sale.against) }) : ""}<br>` : ""}${esc(sale.number)} · ${esc(sale.posting_date)}${sale.customer_name ? `<br>${esc(sale.customer_name)}` : ""}</p><hr>
    <table>${rows}</table><hr>
    <table>${line(tr("Subtotal"), sale.total)}${num(sale.discount_amount) ? line(tr("Discount"), -num(sale.discount_amount)) : ""}${line(tr("Taxes"), sale.total_taxes)}${num(sale.rounding_adjustment) ? line(tr("Rounding"), sale.rounding_adjustment) : ""}
    <tr><td><b>${esc(tr("Total"))}</b></td><td class="r"><b>${esc(money(sale.rounded_total ?? sale.grand_total))}</b></td></tr></table><hr>
    <table>${pays}${num(sale.change_amount) ? line(tr("Change"), sale.change_amount) : ""}</table>
    ${profile.receipt_footer ? `<hr><p>${esc(profile.receipt_footer)}</p>` : ""}
  `,
  );
}
