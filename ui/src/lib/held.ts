// Sales set aside, and the sale in progress, kept on this device. A cashier parks a basket to serve
// the next customer and calls it back; a page reload, a crash or a lost connection never costs the
// sale being rung up. Both are stored per register and cashier, in the browser's own storage
// (they need no server, so they work offline), and every read or write survives storage that is
// empty, full, corrupt or blocked.

import { t } from "@ferrum/client";
import type { Doc } from "@ferrum/records";
import type { CartLine } from "./pos";

export interface Customer {
  id: string | null;
  title?: string;
}

/** A sale in progress: what is in the cart, whose it is, and the key it will be sold under. */
export interface Cart {
  lines: CartLine[];
  customer: Customer;
  /** The sale's own id, made on the device when it began. */
  key: string;
}

export interface HeldSale extends Cart {
  /** When it was set aside. */
  at: string;
  /** What it came to then, for the list. */
  total?: string;
}

type Store = Pick<Storage, "getItem" | "setItem">;

const HELD = "ferrum.pos.held";
const CART = "ferrum.pos.cart";

/** Whose sales these are: one register's, one cashier's. */
export const ownerOf = (profile: string, email: string) => `${profile}:${email.toLowerCase()}`;

function read<T>(name: string, storage: Store | undefined): Record<string, T> {
  try {
    const v: unknown = JSON.parse(storage?.getItem(name) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function write<T>(name: string, all: Record<string, T>, storage: Store | undefined): boolean {
  try {
    if (!storage) return false;
    storage.setItem(name, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

const sound = (c: unknown): c is Cart => !!c && typeof c === "object" && Array.isArray((c as Cart).lines) && typeof (c as Cart).key === "string" && !!(c as Cart).customer;

export function loadHeld(owner: string, storage: Store | undefined = globalThis.localStorage): HeldSale[] {
  const list = read<unknown>(HELD, storage)[owner];
  return Array.isArray(list) ? list.filter((s): s is HeldSale => sound(s) && typeof (s as HeldSale).at === "string") : [];
}

export function saveHeld(owner: string, list: HeldSale[], storage: Store | undefined = globalThis.localStorage): boolean {
  const all = read<HeldSale[]>(HELD, storage);
  if (list.length) all[owner] = list;
  else delete all[owner];
  return write(HELD, all, storage);
}

/** Sets a sale aside: newest first. An empty basket is not worth keeping. */
export function putAside(list: HeldSale[], cart: Cart, at: string, total?: string): HeldSale[] {
  return cart.lines.length ? [{ ...cart, at, ...(total ? { total } : {}) }, ...list] : list;
}

/** Takes a held sale out of the list. */
export function takeOut(list: HeldSale[], key: string): { sale: HeldSale | null; rest: HeldSale[] } {
  return { sale: list.find((s) => s.key === key) ?? null, rest: list.filter((s) => s.key !== key) };
}

export function loadCart(owner: string, storage: Store | undefined = globalThis.localStorage): Cart | null {
  const c = read<unknown>(CART, storage)[owner];
  return sound(c) && c.lines.length ? c : null;
}

/** Remembers the sale in progress (an empty cart forgets it). */
export function saveCart(owner: string, cart: Cart | null, storage: Store | undefined = globalThis.localStorage): boolean {
  const all = read<Cart>(CART, storage);
  if (cart?.lines.length) all[owner] = cart;
  else delete all[owner];
  return write(CART, all, storage);
}

/** What a held sale shows in a list: its customer or "Walk-in", how many lines. */
export function heldSummary(s: HeldSale, walkIn = t("Walk-in customer")): { who: string; lines: string } {
  const n = s.lines.length;
  return { who: s.customer.title || walkIn, lines: `${n} ${n === 1 ? "line" : "lines"}` };
}

/** A priced cart's total, as the list keeps it. */
export const totalOf = (doc: Doc | null | undefined): string | undefined => {
  const v = doc?.rounded_total ?? doc?.grand_total;
  return v == null || v === "" ? undefined : String(v);
};
