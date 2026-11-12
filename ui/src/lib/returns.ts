// Taking goods back: what the returns desk shows and sends. The server answers what is left on a
// sale and what each way of paying can still give back (`/api/app/pos/returns`, which shares its
// arithmetic with the return's own check); the plan for the refund, "the way it was paid", is the server's too
// (`POST /returns/{sale}/plan`, with `out` for an exchange): the till shows it and tells the cashier early what
// the server would refuse of a change they make: what the customer still owes is cancelled first, points go back
// as points, and only what came in as money goes back as money.

import { formatDecimal, t } from "@ferrum/client";
import type { Doc } from "@ferrum/records";
import { pointsFor, pointsValue, round } from "./pay";
import type { RefundProposal } from "./server";

export interface Found {
  id: string;
  number: string | null;
  posting_date: string;
  posting_time: string | null;
  customer: string | null;
  cashier: string | null;
  register: string | null;
  total: string | null;
  status: string | null;
  left_qty: string;
  /** Why it cannot be returned here yet. */
  blocked: string | null;
  /** The last day it comes back, when the register's return policy has a window. */
  returns_until?: string | null;
}

export interface SaleLine {
  id: string;
  item: string;
  item_name: string;
  sold: string;
  returned: string;
  left: string;
  rate: string | null;
  amount: string | null;
  serials: string[];
  batch_no?: string | null;
  note?: string | null;
}

export interface Method {
  mode: string;
  name: string;
  kind: string | null;
  usable: boolean;
  why?: string | null;
}

export interface Sheet {
  sale: { id: string; number: string | null; posting_date: string; customer: string | null; customer_name: string | null; cashier: string | null; register: string | null; total: string | null };
  blocked: string | null;
  /** The last day it comes back, when the register's return policy has a window. */
  returns_until?: string | null;
  lines: SaleLine[];
  /** What each way of paying took in (cash net of change), refunded so far, and has left. */
  paid_with: { mode: string; paid: string; refunded: string; left: string }[];
  methods: Method[];
  refundable: { money: string; loyalty: string; credit: string; /** Paid with stored value: it goes back onto stored value, never out as money. */ stored_value?: string };
  loyalty: { factor: string; points_left: number } | null;
  receipt: Doc;
}

/** The lines being taken back: line id → how many, and which serials. */
export type Picks = Record<string, { qty: number; serials: string[] }>;

export const REASONS = ["Faulty", "Wrong item", "Changed their mind", "Not as described"];

const MONEY = ["Cash", "Bank", "General"];

/** The return's lines, each against the sale's line it comes back from. */
export function returnItems(sheet: Pick<Sheet, "lines">, picks: Picks): Doc[] {
  return sheet.lines.flatMap((l): Doc[] => {
    const p = picks[l.id];
    const qty = p ? Math.min(p.qty, Number(l.left)) : 0;
    if (!(qty > 0)) return [];
    return [{ item: l.item, qty: String(-qty), original_line: l.id, ...(p.serials.length ? { serial_no: p.serials.join("\n") } : {}) }];
  });
}

export interface RefundRow {
  mode: string;
  amount: number;
  /** Points handed back (a Loyalty Points method): the server values them. */
  points?: number;
}

/** The refunds the register proposed (`POST /returns/{sale}/plan`) as the desk starts them. What no way of paying could take back is
 *  what the sale was paid for in points: it goes back as points, as many as cover it; what is still left is said. */
export function refundsFromProposal(p: RefundProposal, s: Pick<Sheet, "methods" | "loyalty">, precision = 2): { rows: RefundRow[]; problem: string | null } {
  const rows: RefundRow[] = p.refunds.filter((r) => Number(r.amount) > 0).map((r) => ({ mode: r.mode, amount: Number(r.amount) }));
  let rest = Number(p.unplaced);
  const via = s.methods.find((m) => m.kind === "Loyalty Points" && m.usable);
  if (rest > 0 && s.loyalty && via) {
    const factor = Number(s.loyalty.factor);
    const n = pointsFor(rest, s.loyalty.points_left, factor, precision);
    if (n > 0) {
      rows.push({ mode: via.mode, amount: pointsValue(n, factor, precision), points: n });
      rest = Math.max(0, round(rest - pointsValue(n, factor, precision), precision));
    }
  }
  return { rows, problem: rest > 0 ? t("{rest} of this refund has no way back through this register.", { rest: formatDecimal(rest, precision) }) : null };
}

/** What the server would refuse about these refunds, in the order it checks, or null. */
export function checkRefund(total: number, rows: RefundRow[], s: Pick<Sheet, "methods" | "refundable">, precision = 2): string | null {
  const method = (mode: string) => s.methods.find((m) => m.mode === mode);
  const sum = (f: (kind: string) => boolean) => round(rows.filter((r) => f(method(r.mode)?.kind ?? "")).reduce((a, r) => a + r.amount, 0), precision);
  const fmt = (n: number) => formatDecimal(n, precision);
  const unusable = rows.find((r) => r.amount > 0 && !method(r.mode)?.usable);
  if (unusable) return t("{value} cannot refund returns at this register.", { value: method(unusable.mode)?.name ?? t("That method") });
  const all = sum(() => true);
  if (all !== round(total, precision)) return t("The refunds add up to {all} of {total}.", { all: fmt(all), total: fmt(total) });
  const owed = round(Math.max(0, Math.min(total, Number(s.refundable.credit))), precision);
  if (sum((k) => k === "Credit") !== owed) {
    return owed > 0 ? t("{owed} of this refund must go to Credit: the customer still owes that much on the sale.", { owed: fmt(owed) }) : t("The sale was paid in full: refund through cash or another way of paying, not Credit.");
  }
  const loyalty = Number(s.refundable.loyalty);
  if (sum((k) => k === "Loyalty Points") > loyalty) return t("At most {loyalty} can go back as loyalty points.", { loyalty: fmt(loyalty) });
  const money = Number(s.refundable.money);
  const cash = sum((k) => MONEY.includes(k));
  if (cash > money) return t("At most {money} can be refunded in cash or to cards: that is what the sale was paid with.", { money: fmt(money) });
  // Money may go back as stored value (store credit); stored value never comes back as money.
  const room = money + Number(s.refundable.stored_value ?? 0);
  if (cash + sum((k) => k === "Stored Value") > room) return t("At most {stored} can go back onto stored value.", { stored: fmt(round(room - cash, precision)) });
  return null;
}

/** A card's code and PIN, typed or made for one send: kept in memory only, never in the till's storage. */
export interface CardProof {
  code: string;
  pin?: string;
}

/** The refunds as the return's payment rows: negative amounts, points as points, a card's code
 *  (the server makes a new card for a code it does not know) only where the server's rows take it. */
export function refundPayments(rows: RefundRow[], reference: Record<string, string> = {}, cards: Record<string, CardProof> = {}): Doc[] {
  return rows.flatMap((r): Doc[] => {
    if (r.points) return [{ mode_of_payment: r.mode, loyalty_points: r.points }];
    const ref = reference[r.mode]?.trim();
    const card = cards[r.mode];
    const proof = card?.code.trim() ? { stored_value_code: card.code.trim(), ...(card.pin?.trim() ? { stored_value_pin: card.pin.trim() } : {}) } : {};
    return r.amount > 0 ? [{ mode_of_payment: r.mode, amount: String(-r.amount), ...(ref ? { reference_no: ref } : {}), ...proof }] : [];
  });
}

/** The return the till sends (for its preview and for the return itself). */
export function returnBody(o: { id?: string; profile: string; session: string; sale: string; reason?: string; items: Doc[]; payments?: Doc[]; approvals?: string[] }): Doc {
  return {
    ...(o.id ? { id: o.id } : {}),
    ...(o.approvals?.length ? { approvals: o.approvals.map((approval) => ({ approval })) } : {}),
    pos_profile: o.profile,
    pos_opening_entry: o.session,
    is_return: true,
    return_against: o.sale,
    ...(o.reason?.trim() ? { return_reason: o.reason.trim() } : {}),
    items: o.items,
    payments: o.payments ?? [],
  };
}

// ── returns without a receipt and exchanges (src/logic.rs; the server prices, the till shows) ──

export type Condition = "Resaleable" | "Damaged" | "Scrap";
export const CONDITIONS: Condition[] = ["Resaleable", "Damaged", "Scrap"];

/** A register's return policy (`PosReturnPolicy`) as the desk needs it. */
export interface Policy {
  price_basis: "Current Price" | "Lowest Price in Window" | "Entered";
  window_days: number;
  store_credit: string | null;
  refund_modes: string[];
  fees: { condition: string; fee_percent: number }[];
  exchange_mode: string | null;
}

export function parsePolicy(doc: Doc): Policy {
  const rows = (v: unknown) => (Array.isArray(v) ? (v as Doc[]) : []);
  const basis = String(doc.price_basis ?? "");
  return {
    price_basis: basis === "Lowest Price in Window" || basis === "Entered" ? basis : "Current Price",
    window_days: Number(doc.window_days ?? 0) || 0,
    store_credit: doc.store_credit ? String(doc.store_credit) : null,
    refund_modes: rows(doc.refund_modes).map((r) => String(r.mode_of_payment)),
    fees: rows(doc.fees).map((f) => ({ condition: String(f.condition), fee_percent: Number(f.fee_percent) || 0 })),
    exchange_mode: doc.exchange_mode ? String(doc.exchange_mode) : null,
  };
}

/** The restocking fee kept back from goods coming back in `condition`, in percent (`restocking_fee`). */
export function restockingFee(fees: Policy["fees"], condition: string): number {
  return fees.find((f) => f.condition === condition)?.fee_percent ?? 0;
}

/** Whether the price a return without a receipt comes back at is settled by what the cashier types
 *  (`return_price`): today's and the lowest-in-window prices are the server's to find. */
export function enteredPriceProblem(basis: Policy["price_basis"], entered: string | undefined): string | null {
  return basis === "Entered" && !(Number(entered) > 0) ? t("Type the price it comes back at.") : null;
}

/** An exchange with no receipt (`logic::exchange`): what came back is worth `back`, what goes out `out` (both
 *  positive); what came back pays for what goes out, and the customer pays the rest or is refunded it. Only the desk
 *  for goods with no receipt still adds this up: the server's plan names a sale (`/returns/{sale}/plan`) and there is
 *  none; a route that plans an exchange with no receipt would end it. */
export function exchange(back: number, out: number, precision = 2): { carried: number; due: number; refund: number } {
  const carried = Math.max(Math.min(back, out), 0);
  return { carried, due: round(out - carried, precision), refund: round(back - carried, precision) };
}

/** What comes back without a receipt: item, how many, in what condition, and the price typed (basis Entered). */
export interface BackLine {
  key: string;
  item: string;
  item_name: string;
  qty: number;
  condition: Condition;
  price?: string;
}

export function backItems(lines: BackLine[], basis: Policy["price_basis"]): Doc[] {
  return lines.map((l) => ({
    item: l.item,
    qty: String(-l.qty),
    condition: l.condition,
    ...(basis === "Entered" && l.price?.trim() ? { manual_rate: l.price.trim() } : {}),
  }));
}

/** A return that names no sale. `reason` is one of the business's return reasons (a `PosReason`). */
export function unreceiptedBody(o: { id?: string; profile: string; session: string; customer: string | null; reason: string; items: Doc[]; payments?: Doc[]; approvals?: string[] }): Doc {
  return {
    ...(o.id ? { id: o.id } : {}),
    pos_profile: o.profile,
    pos_opening_entry: o.session,
    is_return: true,
    without_receipt: true,
    ...(o.customer ? { customer: o.customer } : {}),
    ...(o.reason ? { reason: o.reason } : {}),
    items: o.items,
    payments: o.payments ?? [],
    ...(o.approvals?.length ? { approvals: o.approvals.map((approval) => ({ approval })) } : {}),
  };
}
