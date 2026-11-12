// What the person at the till may do on their own. The server holds the rules (`src/limits.rs`
// reads a person's role limits, `src/logic.rs` has `beyond`/`allows` that the sale is held to) and
// refuses what is beyond them without another person's approval; this is the same sum, done before
// they type, so the limit is shown and the approval asked for instead of met as an error. The
// limits come from `GET /api/app/pos/limits` and are kept with the shift's data for offline.
// Before they are known (a device that has never read them) the register's own switches answer, as
// the server's does for a person none of whose roles has a limits row.

import type { Doc } from "@ferrum/records";
import { t } from "@ferrum/client";

/** Something a person may do on their own only within their limits (`Act::label` on the server). */
export type Act = "Discount" | "Price Change" | "Void Line" | "Void Sale" | "Refund" | "Return Without Receipt" | "No Sale" | "Reprint";

/** `GET /limits`: what one person may do at one register without someone else. `null` caps are no cap. */
export interface Limits {
  /** The largest saving on a line against its list price, in percent, beyond what pricing rules gave. */
  discount_percent: number;
  /** The largest saving on a whole sale, in money, beyond what pricing rules gave. */
  discount_amount: number | null;
  change_price: boolean;
  void_line: boolean;
  void_sale: boolean;
  /** The largest return refunded. */
  refund: number | null;
  return_without_receipt: boolean;
  open_drawer: boolean;
  reprint: boolean;
}

/** No limit at all (a POS manager with no limits record). */
export const UNLIMITED: Limits = {
  discount_percent: 100,
  discount_amount: null,
  change_price: true,
  void_line: true,
  void_sale: true,
  refund: null,
  return_without_receipt: true,
  open_drawer: true,
  reprint: true,
};

const cap = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));

/** The server's record (decimals come as text), or null when it is not one. */
export function parseLimits(raw: unknown): Limits | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.change_price !== "boolean") return null;
  return {
    discount_percent: Number(r.discount_percent) || 0,
    discount_amount: cap(r.discount_amount),
    change_price: r.change_price,
    void_line: r.void_line === true,
    void_sale: r.void_sale === true,
    refund: cap(r.refund),
    return_without_receipt: r.return_without_receipt === true,
    open_drawer: r.open_drawer === true,
    reprint: r.reprint === true,
  };
}

/** What the register allowed before role limits (`register_default`), or everything for a manager:
 *  the answer until the server's limits are known. */
export function rightsOf(profile: Doc, manager: boolean): Limits {
  if (manager) return UNLIMITED;
  const discount = profile.allow_discount_change === true;
  return {
    discount_percent: discount ? Number(profile.max_discount ?? 0) || 0 : 0,
    discount_amount: null,
    change_price: profile.allow_rate_change === true,
    void_line: true,
    void_sale: false,
    refund: null,
    return_without_receipt: false,
    open_drawer: false,
    reprint: true,
  };
}

/** Whether these limits let `act` through at `figure` (a saving percent or amount, a refund): `Limits::allows`. */
export function allows(l: Limits, act: Act, figure = 0): boolean {
  switch (act) {
    case "Discount":
      return figure <= l.discount_percent;
    case "Price Change":
      return l.change_price;
    case "Void Line":
      return l.void_line;
    case "Void Sale":
      return l.void_sale;
    case "Refund":
      return l.refund === null || figure <= l.refund;
    case "Return Without Receipt":
      return l.return_without_receipt;
    case "No Sale":
      return l.open_drawer;
    case "Reprint":
      return l.reprint;
  }
}

/** The most a line's total saving against the list price may be: the limit, or what the pricing
 *  rules already gave when that is more. */
export function discountLimit(l: Limits, rule: number): number {
  return Math.max(rule, l.discount_percent);
}

/** A sale line as typed: the list price and pricing-rule discount, and what the cashier asked for. */
export interface LineAsk {
  qty: number;
  list: number;
  rule: number;
  price?: number;
  discount?: number;
}

/** What a sale asks beyond someone's limits (`logic::beyond`): `line` is null for the whole sale. A
 *  typed price, a line discount and the sale's discount (`header`) count together as the saving. */
export interface Beyond {
  line: number | null;
  act: Act;
  figure: number;
  why: string;
}

const dp = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

export function beyond(l: Limits, lines: LineAsk[], header = 0): Beyond[] {
  const out: Beyond[] = [];
  let given = 0;
  lines.forEach((x, i) => {
    const price = x.price ?? x.list;
    const discount = x.discount ?? x.rule;
    if (x.price !== undefined && x.price !== x.list && !l.change_price) out.push({ line: i, act: "Price Change", figure: 0, why: t("you may not change prices") });
    if (!(x.list > 0)) return;
    const pays = (((price / x.list) * (100 - discount)) / 100) * (100 - header) / 100;
    const saving = dp((1 - pays) * 100, 4);
    const allowed = Math.max(x.rule, l.discount_percent);
    if (saving > allowed) out.push({ line: i, act: "Discount", figure: saving, why: t("a {saving}% discount exceeds the {allowed}% allowed", { saving: String(saving), allowed: String(allowed) }) });
    // What the cashier gave beyond the pricing rules, in money.
    given += Math.max((x.qty * x.list * (100 - x.rule)) / 100 - x.qty * x.list * pays, 0);
  });
  given = dp(given, 2);
  if (l.discount_amount !== null && given > l.discount_amount) {
    out.push({ line: null, act: "Discount", figure: given, why: t("discounts of {given} on this sale exceed the {cap} allowed", { given: String(given), cap: String(l.discount_amount) }) });
  }
  return out;
}

/** Another person's approval of one act on this sale, as `POST /approve` answered. */
export interface Approval {
  id: string;
  act: Act;
  /** What was asked for: a saving percent, a sale's discount in money, a refund. */
  figure: number;
  /** A discount figure that is the whole sale's, in money. */
  money?: boolean;
  by: string;
}

/** Whether an approval already given covers this ask (the server checks again, with the approver's own limits). */
export function covered(approvals: Approval[], a: Pick<Beyond, "line" | "act" | "figure">): boolean {
  const money = a.line === null && a.act === "Discount";
  return approvals.some((x) => x.act === a.act && !!x.money === money && x.figure + 1e-9 >= a.figure);
}

/** One thing to ask an approver for: what is beyond, grouped so that one approval covers all lines of an act. */
export interface Ask {
  act: Act;
  figure: number;
  money?: boolean;
  why: string;
}

/** The asks left once approvals already given are counted: a discount's figure is the largest line's. */
export function asksFor(found: Beyond[], approvals: Approval[]): Ask[] {
  const out: Ask[] = [];
  for (const b of found.filter((x) => !covered(approvals, x))) {
    const money = b.line === null && b.act === "Discount";
    const at = out.find((a) => a.act === b.act && !!a.money === money);
    if (!at) out.push({ act: b.act, figure: b.figure, ...(money ? { money } : {}), why: b.why });
    else if (b.figure > at.figure) Object.assign(at, { figure: b.figure, why: b.why });
  }
  // An approval is for a figure to two places, rounded up, so the server's exact sum is never a hair over it.
  return out.map((a) => ({ ...a, figure: Math.ceil(a.figure * 100 - 1e-6) / 100 }));
}

const typed = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : Number(v));

/** Why what was typed on a line makes no sense, in words for the cashier, or null when it does. */
export function lineProblem(o: { discount?: string; price?: string }): string | null {
  const discount = typed(o.discount);
  const price = typed(o.price);
  if (discount !== undefined && !(discount >= 0 && discount <= 100)) return t("A discount is between 0 and 100 percent.");
  if (price !== undefined && !(price > 0)) return t("Type a price above zero.");
  return null;
}

/** What a line typed this way asks beyond the person's limits, less what is already approved. */
export function lineAsks(l: Limits, o: { list: number; rule: number; discount?: string; price?: string }, approvals: Approval[] = []): Ask[] {
  const discount = typed(o.discount);
  const price = typed(o.price);
  if (lineProblem(o) || !(o.list > 0)) return [];
  const found = beyond(l, [{ qty: 1, list: o.list, rule: o.rule, price, discount }]);
  return asksFor(found, approvals);
}
