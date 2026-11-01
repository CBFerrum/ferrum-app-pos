// Small things every screen of the till shares.

import { createContext, useContext } from "react";
import { bootstrap, formatDecimal } from "@ferrum/client";
import type { Doc } from "@ferrum/records";
import { str } from "./lib/pos";

export { str };
export const num = (v: unknown) => Number(v ?? 0) || 0;
export const titleOf = (d: Doc | undefined, field: string) => str((d?._titles as Record<string, unknown> | undefined)?.[field]) || str(d?.[field]);
/** The person at the till, from the page (it works offline, unlike asking the server). */
export const myEmail = () => bootstrap()?.person?.email ?? "";
/** Whether the pointer is a mouse or a trackpad: only then does the till pull focus back to the
 *  scan box by itself (on a touch screen that would raise the keyboard after every tap). */
export const fine = () => typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;
/** A local date as the server's date: YYYY-MM-DD. */
export const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** How amounts are written here: the currency's places (the register's price book knows them). */
export const Currency = createContext({ precision: 2, code: "" });
export function useMoney(): (v: unknown) => string {
  const { precision } = useContext(Currency);
  return (v) => formatDecimal(v ?? 0, precision);
}

const PROFILE_KEY = "ferrum.pos.profile";

/** The register this device last worked. */
export function remembered(): string | null {
  try {
    return localStorage.getItem(PROFILE_KEY);
  } catch {
    return null;
  }
}

export function remember(id: string) {
  try {
    localStorage.setItem(PROFILE_KEY, id);
  } catch {
    // a private window: the cashier picks again next time
  }
}
