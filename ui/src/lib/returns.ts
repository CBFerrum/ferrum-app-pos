// Taking goods back: what the returns desk shows and sends. The server answers what is left on a
// sale and what each way of paying can still give back (`/api/app/pos/returns`, which shares its
// arithmetic with the return's own check); this turns that into a plan for the refund, "the way it
// was paid", and tells the cashier early what the server would refuse: what the customer still owes
// is cancelled first, points go back as points, and only what came in as money goes back as money.

import { formatDecimal, t } from "@ferrum/client";
import type { Doc } from "@ferrum/records";
import { pointsValue, round } from "./pay";

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

type PlanInput = Pick<Sheet, "paid_with" | "methods" | "refundable" | "loyalty">;

/**
 * How to refund `total` (a positive amount): the customer's debt first, points back as points in
 * their share of the bill, and the rest as money through the ways it came in, in the order they
 * were used; what a way cannot take (a method this register no longer offers, or a write-off the
 * sale was short by) goes to cash. The cashier may change any of it; `checkRefund` says whether
 * the server would accept it.
 */
export function refundPlan(total: number, s: PlanInput, precision = 2): { rows: RefundRow[]; problem: string | null } {
  const rows: RefundRow[] = [];
  const left = {
    money: Math.max(0, Number(s.refundable.money)),
    loyalty: Math.max(0, Number(s.refundable.loyalty)),
    credit: Math.max(0, Number(s.refundable.credit)),
    stored: Math.max(0, Number(s.refundable.stored_value ?? 0)),
  };
  const usable = (...kinds: string[]) => s.methods.filter((m) => m.usable && kinds.includes(m.kind ?? ""));
  const add = (mode: string, amount: number, points?: number) => {
    const at = rows.find((r) => r.mode === mode);
    if (at) {
      at.amount = round(at.amount + amount, precision);
      if (points) at.points = (at.points ?? 0) + points;
    } else rows.push({ mode, amount: round(amount, precision), ...(points ? { points } : {}) });
  };
  let rest = round(total, precision);

  const owed = Math.min(rest, left.credit);
  if (owed > 0) {
    const credit = usable("Credit")[0];
    if (!credit) return { rows, problem: t("This register has no Credit method to cancel what the customer still owes.") };
    add(credit.mode, owed);
    rest = round(rest - owed, precision);
  }
  if (!(rest > 0)) return { rows, problem: null };

  const points = usable("Loyalty Points")[0];
  if (s.loyalty && points && left.loyalty > 0) {
    const factor = Number(s.loyalty.factor);
    const lo = Math.max(0, round(rest - left.money, precision));
    const hi = Math.min(rest, left.loyalty);
    const share = Math.min(Math.max((rest * left.loyalty) / (left.loyalty + left.money), lo), hi);
    const value = (p: number) => pointsValue(p, factor, precision);
    const near = Math.round(share / factor);
    const ok = (p: number) => p >= 0 && p <= s.loyalty!.points_left && value(p) >= lo && value(p) <= hi;
    let pick = [near, near - 1, near + 1, near - 2, near + 2].filter(ok).sort((a, b) => Math.abs(value(a) - share) - Math.abs(value(b) - share))[0];
    // Whole points may not hit the amount that must go back as points: take the first that covers it.
    if (pick === undefined && lo > 0) pick = Math.min(s.loyalty.points_left, Math.ceil(lo / factor));
    if (pick) {
      add(points.mode, value(pick), pick);
      rest = round(rest - value(pick), precision);
    }
  }

  // What a card paid goes back onto stored value (the same card's method first).
  const cards = usable("Stored Value");
  for (const w of s.paid_with) {
    const via = cards.find((m) => m.mode === w.mode);
    const take = Math.min(rest, Number(w.left), left.stored);
    if (via && take > 0) {
      add(via.mode, take);
      left.stored = round(left.stored - take, precision);
      rest = round(rest - take, precision);
    }
  }

  const money = usable(...MONEY);
  for (const w of s.paid_with) {
    const via = money.find((m) => m.mode === w.mode);
    const take = Math.min(rest, Number(w.left));
    if (via && take > 0) {
      add(via.mode, take);
      rest = round(rest - take, precision);
    }
  }
  if (rest > 0) {
    const via = money.find((m) => m.kind === "Cash") ?? money[0];
    if (!via) return { rows, problem: t("This register has no cash, card or other way to refund money.") };
    add(via.mode, rest);
  }
  return { rows, problem: null };
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

/** An exchange (`logic::exchange`): what came back is worth `back`, what goes out `out` (both
 *  positive); what came back pays for what goes out, and the customer pays the rest or is refunded it. */
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
