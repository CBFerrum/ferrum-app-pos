// What the person at the till may change on a line. The server holds the rules (`price_sale` in
// the register's invoice) and refuses what they may not do; this is the same sum, done before
// they type, so the limit is shown instead of met as an error. A POS manager (or an administrator)
// has none.

import type { Doc } from "@ferrum/records";
import { t } from "@ferrum/client";

export interface Rights {
  manager: boolean;
  /** May type a discount on a line. */
  discount: boolean;
  /** The largest discount, in percent, beyond what the pricing rules already gave. */
  max: number;
  /** May type a different price. */
  price: boolean;
}

export function rightsOf(profile: Doc, manager: boolean): Rights {
  const allow = profile.allow_discount_change === true;
  return {
    manager,
    discount: manager || allow,
    max: manager ? 100 : allow ? Number(profile.max_discount ?? 0) || 0 : 0,
    price: manager || profile.allow_rate_change === true,
  };
}

/** The most a line's total saving against the list price may be: the register's maximum, or what
 *  the pricing rules already gave when that is more. */
export function discountLimit(r: Rights, rule: number): number {
  return r.manager ? 100 : Math.max(rule, r.max);
}

const plain = (n: number) => String(Math.round(n * 100) / 100);
const typed = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : Number(v));

/** Why what was typed on a line is not allowed, in words for the cashier, or null when it is. The
 *  saving counts a lower price and a discount together, as the server does. */
export function lineProblem(r: Rights, o: { list: number; rule: number; discount?: string; price?: string }): string | null {
  const discount = typed(o.discount);
  const price = typed(o.price);
  if (discount !== undefined && !(discount >= 0 && discount <= 100)) return "A discount is between 0 and 100 percent.";
  if (price !== undefined && !(price > 0)) return "Type a price above zero.";
  if (r.manager) return null;
  if (price !== undefined && price !== o.list && !r.price) return "This register does not let cashiers change prices. Ask a POS manager.";
  if (discount !== undefined && discount > o.rule && !r.discount) return "This register does not let cashiers give discounts. Ask a POS manager.";
  if (!(o.list > 0)) return null;
  const pays = ((price ?? o.list) / o.list) * ((100 - (discount ?? o.rule)) / 100);
  const saving = Math.round((1 - pays) * 100 * 1e4) / 1e4;
  const limit = discountLimit(r, o.rule);
  return saving > limit ? t("That is {saving}% off the list price. You can give up to {limit}%. Ask a POS manager for more.", { saving: plain(saving), limit: plain(limit) }) : null;
}
