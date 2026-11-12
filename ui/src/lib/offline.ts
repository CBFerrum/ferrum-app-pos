// Selling without a connection (Ferrum docs/plan/apps-ui.md §12.5; "POS offline" in §16): the
// register's snapshot, kept on this device and refreshed while online; what the till last knew
// (its register, open session, ways of paying), so it starts offline; and carts priced from the snapshot with
// ERP's own pricing crate in WebAssembly (lib/pricing.ts), promotions and taxes included, exactly as the server
// prices them from the same inputs. The server prices every sale again when it arrives.

import { bootstrap, cacheName, offlineEnv, parseApiError, renewOfflineLease, sweep, t } from "@ferrum/client";
import type { Doc } from "@ferrum/records";
import { momentIn, notAvailable, priceBasket, PRICING_SCHEMA, type PricingSnapshot } from "./pricing";
import type { Limits } from "./rights";

// ── requests the till makes ──

/** How long the till waits for the server before it sells offline. */
const PATIENCE_MS = 4000;

/** Whether an error means the server could not be reached, or the session ended (401): the
 *  till then sells from the price book and keeps sales until it can send them. */
export function unreachable(e: unknown): boolean {
  if (e instanceof TypeError || (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError"))) return true;
  const status = (e as { status?: number } | null)?.status;
  return status === 0 || status === 401 || status === 408 || status === 429 || (typeof status === "number" && status >= 500);
}

/** After the server fails to answer, the till does not wait for it again for a little while: it
 *  prices from the book at once, so a dead connection costs one slow request, not one per scan. */
const DOWN_FOR_MS = 20_000;
let downUntil = 0;

/** Whether the server is thought out of reach now: it failed to answer a moment ago. (The
 *  browser's own "offline" flag is not asked: it is wrong often enough, and a dead connection
 *  fails at once anyway.) */
export const serverDown = (now = Date.now()) => now < downUntil;
export const markDown = (now = Date.now()) => void (downUntil = now + DOWN_FOR_MS);
export const markUp = () => void (downUntil = 0);
if (typeof window !== "undefined") window.addEventListener("online", markUp);

/** A request of the till: one try within a few seconds, and never a page change on 401 (the
 *  till keeps working; the person signs in when they choose to send). */
export async function till<T>(
  path: string,
  o: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined>; idempotencyKey?: string; signal?: AbortSignal; accept?: string; patience?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: o.accept ?? "application/json" };
  const app = bootstrap()?.app;
  if (app) headers["x-ferrum-ui"] = `${app.id}@${app.version}`;
  if (o.idempotencyKey) headers["idempotency-key"] = o.idempotencyKey;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) q.set(k, String(v));
  const timeout = AbortSignal.timeout(o.patience ?? PATIENCE_MS);
  const signal = o.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([o.signal, timeout]) : (o.signal ?? timeout);
  let res: Response;
  try {
    res = await fetch(path + (q.size ? `?${q}` : ""), {
      method: o.method ?? "GET",
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      credentials: "same-origin",
      signal,
    });
  } catch (e) {
    // A request the till itself gave up on (the cart changed) says nothing about the server.
    if (!o.signal?.aborted) markDown();
    throw e;
  }
  if (unreachable({ status: res.status })) markDown();
  else markUp();
  if (!res.ok) throw parseApiError(res.status, await res.json().catch(() => null));
  if (res.status === 204) return undefined as T;
  // A paper (the server's receipt, its shift report) comes back as the page's text.
  return ((res.headers.get("content-type") ?? "").includes("json") ? await res.json() : await res.text()) as T;
}

/** Every row of a list, page after page by cursor: the server pages at 500, and cursors need the
 *  creation order. */
export async function tillAll<T>(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal,
  get: <R>(p: string, o: { query?: Record<string, string | number | boolean | undefined>; signal?: AbortSignal }) => Promise<R> = till,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await get<{ rows: T[]; next_cursor?: string | null }>(path, { query: { ...query, limit: 500, sort: "created_at desc", cursor }, signal });
    out.push(...page.rows);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

// ── the price book ──

/** What the till shows of an item: from the snapshot's `catalog`. */
export interface BookItem {
  id: string;
  code: string;
  name: string;
  barcode: string | null;
  item_group?: string | null;
}

/** The register's snapshot as the till keeps it: ERP's pricing snapshot (schema 1: prices, units, rules, taxes, rounding, promotions, the days it
 *  prices for, in its own fields: `lib/pricing.ts` is what reads them) with what the till shows and holds a sale to. */
export interface PriceBook extends PricingSnapshot {
  profile: string;
  /** The walk-in customer: a basket naming nobody else is priced as theirs. */
  customer: string | null;
  items: { id: string }[];
  catalog: BookItem[];
  barcodes: { barcode: string; item: string; qty: string }[];
  built_at: string;
  /** The snapshot's version (a digest of its content): an offline sale names it, and the server prices the sale again with exactly it. */
  version?: string;
  /** The server's signature of the version, when it has a key. The till keeps it; only the server can check it. */
  signature?: string | null;
  /** The buyer rule: a sale above `named_above` to the walk-in customer needs a named buyer. */
  buyer?: { named_above: string | null; walk_in: string | null };
  /** Items the register cannot sell as they stand offline (no price in its list). */
  unpriced?: { id: string; name: string; reason: string }[];
  /** The snapshot stopped at its page limit: the items past it are sold online only. */
  truncated?: boolean;
}

/** The register's snapshot, in one request: the server pages its own price book and signs the whole. */
export async function downloadSnapshot(profile: string, get: () => Promise<Partial<PriceBook> & { catalog: BookItem[]; barcodes: PriceBook["barcodes"] }>): Promise<PriceBook> {
  const s = await get();
  return { ...s, profile, customer: s.customer ?? null, built_at: s.built_at ?? new Date().toISOString(), signature: s.signature ?? null, truncated: s.truncated === true } as PriceBook;
}

/** The most a snapshot may take to come: a large catalogue is paged by the server and signed whole. */
export const SNAPSHOT_PATIENCE_MS = 90_000;

const BOOKS = "pricebooks";

/** Where the book is kept: under the workspace's offline lease (Ferrum docs/offline.md), for this
 *  person's sign-in; nowhere when the workspace keeps nothing on devices or the lease has ended. */
function bookDb(): string | null {
  return cacheName(offlineEnv(), "pos", "pricebooks");
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const db = bookDb();
    if (!db) return reject(new Error(t("this device may not keep the price book")));
    const req = indexedDB.open(db, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(BOOKS, { keyPath: "profile" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function inStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(BOOKS, mode);
        const req = run(tx.objectStore(BOOKS));
        tx.oncomplete = () => (db.close(), resolve(req.result as T));
        tx.onerror = tx.onabort = () => (db.close(), reject(tx.error));
      }),
  );
}

/** Keeps the book on this device (a private window may refuse: the till then sells online only). */
export const saveBook = (book: PriceBook) => inStore<unknown>("readwrite", (s) => s.put(book)).then(() => undefined);

/** The book kept for a register. One with no schema is a 0.7.1 book (another shape, with its own engine and prices): it is discarded here and
 *  fetched again when the till is next online, and until then the till has no offline prices. */
export const readable = (b: { schema?: unknown } | null | undefined): boolean => typeof b?.schema === "number";
export const loadBook = (profile: string) =>
  inStore<PriceBook | undefined>("readonly", (s) => s.get(profile)).then(
    (b) => {
      if (b && !readable(b)) {
        void inStore<unknown>("readwrite", (s) => s.delete(profile)).catch(() => {});
        return null;
      }
      return b ?? null;
    },
    () => null,
  );

/** The item a scanned code names: a pack barcode (with its quantity), else an item's barcode or code. */
export function scanBook(book: PriceBook, code: string): { item: BookItem; qty: number } | null {
  const c = code.trim();
  const pack = book.barcodes.find((b) => b.barcode === c);
  const byId = (id: string) => book.catalog.find((i) => i.id === id);
  if (pack) {
    const item = byId(pack.item);
    return item ? { item, qty: Number(pack.qty) || 1 } : null;
  }
  const hit = book.catalog.filter((i) => i.barcode === c || i.code.toLowerCase() === c.toLowerCase());
  return hit.length === 1 ? { item: hit[0], qty: 1 } : null;
}

/** Items whose name or code holds every word of `q`, by name. */
export function searchBook(book: PriceBook, q: string, limit = 30): BookItem[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return book.catalog
    .filter((i) => words.every((w) => `${i.name} ${i.code}`.toLowerCase().includes(w)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** A cart priced from the snapshot with ERP's pricing (`lib/pricing.ts`), in the fields the till shows (`_calc`'s): promotions, free items they add,
 *  each line's price, the tax by rate and the totals, as the server prices the sale again. A price or discount the cashier typed replaces the
 *  snapshot's, as it does on the server. Throws what the snapshot cannot price (an item it does not hold, a day it does not cover, a schema it does
 *  not know): the sale then waits for the server. */
export async function priceOffline(
  book: PriceBook,
  lines: { key: string; item: string; item_name: string; qty: number; discount?: string; price?: string }[],
  o: { customer?: string | null; at?: Date } = {},
): Promise<Doc> {
  if (book.schema !== PRICING_SCHEMA) throw new Error(notAvailable());
  const held = new Set(book.items.map((i) => i.id));
  const missing = lines.find((l) => !held.has(l.item));
  if (missing) throw new Error(t("{item_name} has no price on this device yet: sell it when the connection is back", { item_name: missing.item_name }));
  const typed = (v: string | undefined) => (v?.trim() ? v.trim() : null);
  const priced = await priceBasket({
    snapshot: book,
    basket: {
      lines: lines.map((l) => ({ item: l.item, qty: String(l.qty), price: typed(l.price), discount_percent: typed(l.discount) })),
      at: momentIn(book.time_zone, o.at),
      // The walk-in customer is the snapshot's own; another is named, and their group is the server's to know.
      customer: o.customer && o.customer !== book.customer ? o.customer : null,
    },
  });
  const names = new Map(book.catalog.map((i) => [i.id, i.name || i.code] as const));
  const totals = priced.totals;
  return {
    items: priced.lines.map((l, i) => ({
      item: l.item,
      item_name: lines[i]?.item_name ?? names.get(l.item) ?? l.item,
      qty: l.qty,
      rate: totals.lines[i].rate,
      amount: totals.lines[i].amount,
      price_list_rate: l.price_list_rate,
      discount_percent: l.discount_percent,
      promotion_percent: l.promotion_percent,
      ...(l.added_by_promotion ? { added_by_promotion: l.added_by_promotion } : {}),
    })),
    applied_promotions: priced.applied.map((a) => ({ promotion: a.promotion, title: a.title, line: Number(a.line), amount: a.amount, code: a.code })),
    tax_breakdown: priced.tax_summary,
    total: totals.total,
    discount_amount: totals.discount_amount,
    total_taxes: totals.total_taxes,
    rounding_adjustment: totals.rounding_adjustment,
    grand_total: totals.grand_total,
    rounded_total: totals.rounded_total,
    offline: true,
  };
}

/** What each of these items is listed at and the discount its pricing rule gives, from the snapshot (one item at a time, as the engine prices it): what the till
 *  measures a cashier's discount against, and shows beside an item. Nothing for an item the snapshot does not hold, or when it cannot price. */
export async function listPrices(book: PriceBook, ids: string[], at?: Date): Promise<Map<string, { list: string; rule: string }>> {
  const held = new Set(book.items.map((i) => i.id));
  const want = [...new Set(ids)].filter((id) => held.has(id));
  const out = new Map<string, { list: string; rule: string }>();
  if (!want.length || book.schema !== PRICING_SCHEMA) return out;
  try {
    const priced = await priceBasket({ snapshot: book, basket: { lines: want.map((item) => ({ item, qty: "1" })), at: momentIn(book.time_zone, at) } });
    // a promotion may add free items after the lines asked for: they are not asked about
    priced.lines.slice(0, want.length).forEach((l, i) => out.set(want[i], { list: l.price_list_rate, rule: l.discount_percent }));
  } catch {
    // outside the days it covers: the server's prices stand
  }
  return out;
}

// ── what the till last knew ──

export interface TillMemory {
  email: string;
  profile: Doc;
  session: { id: string; number: string } | null;
  /** Ways of paying, with their kinds (cash shows quick amounts). */
  modes: Doc[];
  /** Whether they are a POS manager, which lifts the cashier's limits at the till. */
  manager?: boolean;
  /** What they may do on their own at this register (`GET /limits`), held to offline as the server will hold the sale. */
  limits?: Limits;
  /** The business's reasons for voiding and returning (`PosReason`). */
  reasons?: Doc[];
}

/** Where the till's memory is kept: like the book, under the lease. */
const memoryKey = () => cacheName(offlineEnv(), "pos", "till");

export function recallTill(profile: string, email: string): TillMemory | null {
  try {
    const key = memoryKey();
    const all = JSON.parse((key && localStorage.getItem(key)) || "{}") as Record<string, TillMemory>;
    const m = all[profile];
    return m && m.email === email ? m : null;
  } catch {
    return null;
  }
}

export function rememberTill(m: TillMemory): void {
  try {
    const key = memoryKey();
    if (!key) return;
    const all = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, TillMemory>;
    all[String(m.profile.id)] = m;
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    // a private window: the till starts online only
  }
}

/** Registers this device worked, for picking one offline. */
export function knownRegisters(email: string): Doc[] {
  try {
    const key = memoryKey();
    const all = JSON.parse((key && localStorage.getItem(key)) || "{}") as Record<string, TillMemory>;
    return Object.values(all)
      .filter((m) => m.email === email)
      .map((m) => m.profile);
  } catch {
    return [];
  }
}

// ── what the device may keep ──

/** Before the shared policy the book and the till's memory were kept for anyone on the device. */
const LEGACY = { db: "ferrum-pos", memory: "ferrum.pos.till" };

/** At start: forgets what the lease no longer covers (and what was kept before it), then renews
 *  the lease every hour while the till is open. Queued and held sales are kept whatever it says. */
export function keepToTheLease(every = 3_600_000): () => void {
  const forget = () => {
    void sweep(offlineEnv(), typeof indexedDB === "undefined" ? undefined : indexedDB);
  };
  try {
    localStorage.removeItem(LEGACY.memory);
    if (typeof indexedDB !== "undefined") indexedDB.deleteDatabase(LEGACY.db);
  } catch {
    // nothing kept, or nothing to keep it in
  }
  forget();
  const timer = setInterval(() => void renewOfflineLease().then(forget), every);
  return () => clearInterval(timer);
}
