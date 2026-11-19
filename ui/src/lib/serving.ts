// Someone else serving at the cashier's till by their PIN (POS-12): whom the lock screen offers, the server's refusals in
// words, and whether this till is locked. The till stays signed in as the session's cashier, who answers for the drawer;
// the server names who serves (`take_over`), their online sales are theirs and are held to the narrower of the two
// people's limits, and the cashier takes the till back with their own PIN (`hand_back`). A PIN is typed, sent in its one
// request and dropped. Offline nothing switches: the till carries on as whoever serves now.

import { t } from "@ferrum/client";
import type { Doc } from "@ferrum/records";
import { str } from "./pos";

/** Whom the lock screen offers: the session's cashier first, then the register's Allowed Users, each once by address. */
export function peopleOf(profile: Doc, cashier: string): string[] {
  const out = [cashier];
  const seen = new Set([cashier.toLowerCase()]);
  for (const u of (profile.users as Doc[] | undefined) ?? []) {
    const email = str(u.user).trim();
    if (email && !seen.has(email.toLowerCase())) {
      seen.add(email.toLowerCase());
      out.push(email);
    }
  }
  return out;
}

/** Why the till was not handed over, in words: no connection, a lockout, someone who does not work this till, a wrong PIN. */
export function servingProblem(e: { status?: number; message?: string }, who: string): string {
  if (e.status === undefined || e.status === 0 || e.status >= 500 || e.status === 408) return t("Switching people needs a connection.");
  if (e.status === 429) return t("Too many wrong PINs for {who}. Their PIN is locked for 15 minutes.", { who });
  if (e.status === 403) return t("{who} does not work at this till.", { who });
  if (/PIN does not match/i.test(e.message ?? "")) return t("That PIN does not match. Check it and try again.");
  return e.message || t("The till was not handed over.");
}

const LOCKED = (session: string) => `pos.locked.${session}`;

/** Whether this device's till for `session` was left locked (a reload does not unlock it). */
export function isLocked(session: string): boolean {
  try {
    return localStorage.getItem(LOCKED(session)) === "1";
  } catch {
    return false;
  }
}

export function keepLocked(session: string, locked: boolean): void {
  try {
    if (locked) localStorage.setItem(LOCKED(session), "1");
    else localStorage.removeItem(LOCKED(session));
  } catch {
    // a private window: the lock lasts while the page does
  }
}
