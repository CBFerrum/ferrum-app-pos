// Taking payment: how the tenders typed in add up to the bill, the same way the server settles a
// sale (`settle_sale`): tenders must cover it, a small shortfall inside the register's write-off
// limit is forgiven, and only cash can be more than what is due (the rest goes back as change).

import { t } from "@ferrum/client";
export interface Paid {
  kind: string;
  amount: number;
}

export interface Tally {
  tendered: number;
  /** Still to take, when the tenders do not cover the bill. */
  left: number;
  /** Cash to hand back. */
  change: number;
  /** A shortfall small enough for the register to forgive. */
  writeOff: number;
  /** Why the sale cannot be completed with these tenders, when more than "still due". */
  problem: string | null;
}

/** Rounds half away from zero, as the server does; the nudge makes up for the digits a binary
 *  double cannot hold (1.005 is really 1.00499999999999989…). Never minus zero. */
export function round(n: number, precision = 2): number {
  const scaled = Math.abs(n) * 10 ** precision * (1 + Number.EPSILON);
  return (Math.sign(n) * Math.round(scaled)) / 10 ** precision || 0;
}

export function tally(due: number, paid: Paid[], writeOffLimit = 0, precision = 2): Tally {
  const sum = (rows: Paid[]) => round(rows.reduce((s, p) => s + (p.amount > 0 ? p.amount : 0), 0), precision);
  const tendered = sum(paid);
  const short = round(due - tendered, precision);
  if (short > 0) return short <= writeOffLimit ? { tendered, left: 0, change: 0, writeOff: short, problem: null } : { tendered, left: short, change: 0, writeOff: 0, problem: null };
  const other = sum(paid.filter((p) => p.kind !== "Cash"));
  if (other > due) return { tendered, left: 0, change: 0, writeOff: 0, problem: t("Only cash can come to more than the bill. Lower the card or other amounts.") };
  return { tendered, left: 0, change: round(tendered - due, precision), writeOff: 0, problem: null };
}

/** What a method added next should start at: what is still due after the others. */
export function stillDue(due: number, paid: Paid[], precision = 2): number {
  return Math.max(0, round(due - paid.reduce((s, p) => s + (p.amount > 0 ? p.amount : 0), 0), precision));
}

/** Points redeemed, worth `points × factor` rounded half away from zero to the currency's
 *  places, as the server values them. */
export function pointsValue(points: number, factor: number, precision = 2): number {
  return round(points * factor, precision);
}

/** Points a customer can redeem now: all earned, less the earnings past their expiry date that
 *  the server has not expired yet (`remaining` is what of an earning is still unused). */
export function pointsAvailable(entries: { points?: number | null; remaining?: number | null; expiry_date?: string | null }[], today: string): number {
  return entries.reduce((s, e) => s + (e.points ?? 0) - (e.expiry_date && e.expiry_date < today ? (e.remaining ?? 0) : 0), 0);
}

/** The most points that can pay `amount`: whole points whose value does not pass it. */
export function pointsFor(amount: number, available: number, factor: number, precision = 2): number {
  if (!(factor > 0) || !(amount > 0)) return 0;
  let points = Math.min(Math.max(0, Math.floor(available)), Math.floor(amount / factor + 1e-9));
  while (points > 0 && pointsValue(points, factor, precision) > amount) points--;
  return points;
}

/** What each tender came to: what was handed over, what of it pays the bill, and the change handed back. Only cash is
 *  handed back (the last cash tender gives it, as the server nets change off cash). */
export function perTender(due: number, paid: Paid[], precision = 2): { tendered: number; taken: number; change: number }[] {
  const { change } = tally(due, paid, 0, precision);
  const lastCash = paid.map((p) => p.kind).lastIndexOf("Cash");
  return paid.map((p, i) => {
    const tendered = p.amount > 0 ? round(p.amount, precision) : 0;
    const back = i === lastCash ? Math.min(change, tendered) : 0;
    return { tendered, taken: round(tendered - back, precision), change: back };
  });
}

/** What is left on a stored-value card once `amount` is taken from the `balance` it holds (never below nothing). */
export const leftOnCard = (balance: number, amount: number, precision = 2): number => Math.max(0, round(balance - amount, precision));
