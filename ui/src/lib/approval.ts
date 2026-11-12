// Asking another person to approve what is beyond the cashier's limits (`POST /approve`) and setting
// one's own PIN (`POST /pin`): what is checked before the request, and the server's refusals in
// words for the cashier. A PIN is typed, sent in the one request, and dropped; it is never part of
// a record the till keeps, a queued sale or a log.

import { t } from "@ferrum/client";

/** A PIN as people type it: four to twelve digits (`check_pin_shape`). */
export const pinShape = (pin: string): boolean => /^\d{4,12}$/.test(pin);

/** What is wrong with a new PIN and its repeat, or null. */
export function newPinProblem(pin: string, again: string): string | null {
  if (!pinShape(pin)) return t("A PIN is four to twelve digits.");
  return pin === again ? null : t("The two PINs are not the same.");
}

/** Why the server did not approve, in the cashier's words: a wrong PIN, a lockout, a person who may
 *  not approve this either, or no connection. */
export function approvalProblem(e: { status?: number; message?: string }, approver: string): string {
  if (e.status === undefined || e.status === 0 || e.status >= 500 || e.status === 408) return t("Approvals need a connection. Ask again when the till is back online.");
  if (e.status === 429) return t("Too many wrong PINs for {approver}. Their PIN is locked for 15 minutes; ask someone else.", { approver });
  if (e.status === 403) return t("{approver} may not approve this either. Ask someone with higher limits.", { approver });
  if (/PIN does not match/i.test(e.message ?? "")) return t("That PIN does not match. Check it and try again.");
  return e.message || t("The approval was not given.");
}
