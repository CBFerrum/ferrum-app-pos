// Sales set aside, and the sale in progress, kept on this device. A cashier parks a basket to serve
// the next customer and calls it back; a page reload, a crash or a lost connection never costs the
// sale being rung up. Both are stored per register and cashier, in the browser's own storage
// (they need no server, so they work offline), and every read or write survives storage that is
// empty, full, corrupt or blocked. A held sale is also sent to the register (`PosHeldSale`) when it can
// be, so the cashier's other tills and a manager see it: the device's copy stays the first one.

import { t } from "@ferrum/client";
import type { Doc } from "@ferrum/records";
import type { Approval } from "./rights";
import type { Buyer, CartLine, Voided } from "./pos";

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
  /** Another person's approvals for this sale (ids only; the PIN that gave them is never kept). */
  approvals?: Approval[];
  /** Lines taken off after they were rung, with why. */
  voided?: Voided[];
  /** The tax registration the buyer gave, and the promotion codes (neither is a secret; the server checks both again). */
  buyer?: Buyer | null;
  codes?: string[];
  /** The discount on the whole sale, a percent as typed; none when there is none (a sale kept before 0.13.0 has none). */
  discount?: string;
  /** A card's code was on a line when this was kept. The code is not (a card's code is never kept on the
   *  device), so the card is asked for again; this only says that it is to be. */
  cardAgain?: boolean;
}

export interface HeldSale extends Cart {
  /** When it was set aside. */
  at: string;
  /** What it came to then, for the list. */
  total?: string;
  /** The register has it: it was sent, or it came from the register. */
  sent?: boolean;
  /** Who held it, when it is not the person signed in (a manager sees everyone's). */
  by?: string;
  /** The register's copy lost its basket to an erasure: it can only be discarded. */
  erased?: boolean;
}

type Store = Pick<Storage, "getItem" | "setItem">;

const HELD = "ferrum.pos.held";
const CART = "ferrum.pos.cart";
/** Keys of held sales taken off this device whose register copy is still to be deleted. */
const GONE = "ferrum.pos.held.gone";

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

// ── the register's copy ──

/** Keys whose register copy is still to be deleted (resumed or discarded here, the delete not yet answered). */
export function loadGone(owner: string, storage: Store | undefined = globalThis.localStorage): string[] {
  const list = read<unknown>(GONE, storage)[owner];
  return Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : [];
}

export function saveGone(owner: string, keys: string[], storage: Store | undefined = globalThis.localStorage): boolean {
  const all = read<string[]>(GONE, storage);
  if (keys.length) all[owner] = keys;
  else delete all[owner];
  return write(GONE, all, storage);
}

/** The register's record of a held sale (`pos.pos_held_sale.create`): its key as the id, the basket as the till keeps it. A
 *  card's code is never in a basket (`cardAgain` only says it is to be asked for again). */
export function heldBody(sale: HeldSale, profile: string): Doc {
  const { at, total, sent: _sent, by: _by, erased: _erased, ...cart } = sale;
  return {
    id: sale.key,
    pos_profile: profile,
    customer: sale.customer.id,
    customer_title: sale.customer.title ?? null,
    held_at: at,
    ...(total ? { total } : {}),
    cart,
  };
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** A held sale as the register lists it, read as untrusted: only what the till knows is taken, a malformed row is dropped
 *  (null), and one whose basket was erased comes back to be discarded only. `me` is the person signed in. */
export function fromServer(row: Doc, me: string): HeldSale | null {
  const key = text(row.id);
  const at = text(row.held_at);
  if (!key || !at) return null;
  const by = text(row.cashier);
  const base = {
    key,
    at,
    sent: true,
    ...(row.total != null && row.total !== "" ? { total: String(row.total) } : {}),
    ...(by && by.toLowerCase() !== me.toLowerCase() ? { by } : {}),
  };
  const customer: Customer = { id: text(row.customer) ?? null, ...(text(row.customer_title) ? { title: text(row.customer_title) } : {}) };
  if (row.cart == null) return { ...base, customer, lines: [], erased: true };
  const c = row.cart as Partial<Cart>;
  const lines = Array.isArray(c.lines) ? c.lines : null;
  const line = (l: unknown): l is CartLine =>
    !!l && typeof l === "object" && !!text((l as CartLine).key) && !!text((l as CartLine).item) && typeof (l as CartLine).qty === "number" && (l as CartLine).qty > 0;
  if (!lines || !lines.length || !lines.every(line)) return null;
  return {
    ...base,
    customer: c.customer && typeof c.customer === "object" && "id" in c.customer ? { id: text(c.customer.id) ?? null, ...(text(c.customer.title) ? { title: text(c.customer.title) } : {}) } : customer,
    lines: lines.map((l) => ({ key: l.key, item: l.item, item_name: text(l.item_name) ?? l.item, qty: l.qty, ...(text(l.discount) ? { discount: l.discount } : {}), ...(text(l.price) ? { price: l.price } : {}), ...(text(l.note) ? { note: l.note } : {}) })),
    ...(Array.isArray(c.approvals) ? { approvals: c.approvals } : {}),
    ...(Array.isArray(c.voided) ? { voided: c.voided } : {}),
    ...(c.buyer && typeof c.buyer === "object" ? { buyer: c.buyer } : {}),
    ...(Array.isArray(c.codes) ? { codes: c.codes.filter((x): x is string => typeof x === "string") } : {}),
    ...(text(c.discount) ? { discount: c.discount } : {}),
    ...(c.cardAgain === true ? { cardAgain: true } : {}),
  };
}

/** What the till shows: the device's held sales, then the register's that the device does not hold and has not taken. A
 *  device row the register had (`sent`) that a complete answer no longer lists was resumed or discarded elsewhere: it goes.
 *  `complete`: the register's answer was its whole list (fewer rows than asked for). */
export function mergeHeld(device: HeldSale[], server: HeldSale[], gone: string[], complete: boolean): { device: HeldSale[]; shown: HeldSale[] } {
  const listed = new Set(server.map((s) => s.key));
  const kept = device.filter((s) => !(s.sent && complete && !listed.has(s.key)));
  const here = new Set(kept.map((s) => s.key));
  return { device: kept, shown: [...kept, ...server.filter((s) => !here.has(s.key) && !gone.includes(s.key))] };
}

/** Takes a held sale off this device to resume or discard it. One the register has is deleted there first, its key kept in
 *  `gone` (saved before the delete goes) until the delete is answered: done, it is taken; not found, another till took it and
 *  the device's copy goes too; the register out of reach, it is taken from the device's copy and the delete waits in `gone`
 *  for the next pass; refused for another reason, nothing changes and the refusal is thrown. */
export async function takeHeld(
  key: string,
  list: HeldSale[],
  gone: string[],
  io: { del: (key: string) => Promise<unknown>; lost: (e: unknown) => boolean; keepGone: (keys: string[]) => void },
): Promise<{ taken: boolean; why?: "missing" | "elsewhere"; sale?: HeldSale; list: HeldSale[]; gone: string[] }> {
  const sale = list.find((s) => s.key === key);
  if (!sale) return { taken: false, why: "missing", list, gone };
  const rest = list.filter((s) => s.key !== key);
  if (!sale.sent) return { taken: true, sale, list: rest, gone };
  const without = gone.filter((k) => k !== key);
  const waiting = [...without, key];
  io.keepGone(waiting);
  try {
    await io.del(key);
  } catch (e) {
    if ((e as { status?: number } | null)?.status === 404) {
      io.keepGone(without);
      return { taken: false, why: "elsewhere", list: rest, gone: without };
    }
    if (io.lost(e)) return { taken: true, sale, list: rest, gone: waiting };
    io.keepGone(gone);
    throw e;
  }
  io.keepGone(without);
  return { taken: true, sale, list: rest, gone: without };
}
