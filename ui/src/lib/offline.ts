// Selling without a connection (Ferrum docs/plan/apps-ui.md §12.5; "POS offline" in §16): the
// register's price book, kept on this device and refreshed while online; what the till last knew
// (its register, open session, ways of paying), so it starts offline; and carts priced with the
// platform's own engine (@ferrum/calc, Ferrum's crates/calc in WebAssembly), exactly as the server
// prices them from the same inputs. The server prices every sale again when it arrives.

import { calculate, type CalcInput } from "@ferrum/calc";
import { bootstrap, parseApiError } from "@ferrum/client";
import type { Doc } from "@ferrum/records";

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

/** A request of the till: one try within a few seconds, and never a page change on 401 (the
 *  till keeps working; the person signs in when they choose to send). */
export async function till<T>(
  path: string,
  o: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined>; idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const app = bootstrap()?.app;
  if (app) headers["x-ferrum-ui"] = `${app.id}@${app.version}`;
  if (o.idempotencyKey) headers["idempotency-key"] = o.idempotencyKey;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) q.set(k, String(v));
  const timeout = AbortSignal.timeout(PATIENCE_MS);
  const signal = o.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([o.signal, timeout]) : (o.signal ?? timeout);
  const res = await fetch(path + (q.size ? `?${q}` : ""), {
    method: o.method ?? "GET",
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
    credentials: "same-origin",
    signal,
  });
  if (!res.ok) throw parseApiError(res.status, await res.json().catch(() => null));
  return (res.status === 204 ? undefined : await res.json()) as T;
}

// ── the price book ──

export interface BookItem {
  id: string;
  code: string;
  name: string;
  barcode: string | null;
  /** The engine's line for one of it: price, line discount, item tax rates, and the stock
   *  quantity per-unit taxes count for one (its unit's conversion). */
  line: { price: string; discount_percent?: string; tax_rates?: Record<string, string>; tax_qty?: string | null };
}

export interface PriceBook {
  profile: string;
  currency: string;
  customer: string | null;
  /** What every sale shares: precision, rounding, tax rows, cash rounding. */
  engine: Omit<CalcInput, "lines">;
  items: BookItem[];
  barcodes: { barcode: string; item: string; qty: string }[];
  built_at: string;
}

interface BookPage extends Partial<Omit<PriceBook, "items" | "barcodes">> {
  items: BookItem[];
  barcodes: { barcode: string; item: string; qty: string }[];
  next: string | null;
}

/** Most pages a book may take (250 items each): a register selling more is outside offline. */
const MAX_PAGES = 200;

/** The register's whole price book, page by page. */
export async function downloadBook(profile: string, page: (after: string | null) => Promise<BookPage>): Promise<PriceBook> {
  const book: PriceBook = { profile, currency: "", customer: null, engine: { precision: 2 }, items: [], barcodes: [], built_at: new Date().toISOString() };
  let after: string | null = null;
  for (let n = 0; n < MAX_PAGES; n++) {
    const p: BookPage = await page(after);
    if (p.engine) Object.assign(book, { engine: p.engine, currency: p.currency ?? "", customer: p.customer ?? null, built_at: p.built_at ?? book.built_at });
    book.items.push(...p.items);
    book.barcodes.push(...p.barcodes);
    if (!p.next) break;
    after = p.next;
  }
  return book;
}

const DB = "ferrum-pos";
const BOOKS = "pricebooks";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
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
export const loadBook = (profile: string) => inStore<PriceBook | undefined>("readonly", (s) => s.get(profile)).then((b) => b ?? null, () => null);

/** The item a scanned code names: a pack barcode (with its quantity), else an item's barcode or code. */
export function scanBook(book: PriceBook, code: string): { item: BookItem; qty: number } | null {
  const c = code.trim();
  const pack = book.barcodes.find((b) => b.barcode === c);
  const byId = (id: string) => book.items.find((i) => i.id === id);
  if (pack) {
    const item = byId(pack.item);
    return item ? { item, qty: Number(pack.qty) || 1 } : null;
  }
  const hit = book.items.filter((i) => i.barcode === c || i.code.toLowerCase() === c.toLowerCase());
  return hit.length === 1 ? { item: hit[0], qty: 1 } : null;
}

/** Items whose name or code holds every word of `q`, by name. */
export function searchBook(book: PriceBook, q: string, limit = 30): BookItem[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return book.items
    .filter((i) => words.every((w) => `${i.name} ${i.code}`.toLowerCase().includes(w)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** `a × b` for decimal strings, exactly (no binary floating point): "0.1" × "3" is "0.3". */
export function times(a: string, b: string): string {
  const parse = (x: string) => {
    const [whole, frac = ""] = x.trim().split(".");
    return { digits: BigInt(`${whole}${frac}` || "0"), scale: frac.length };
  };
  const [x, y] = [parse(a), parse(b)];
  const scale = x.scale + y.scale;
  const product = x.digits * y.digits;
  const sign = product < 0n ? "-" : "";
  const text = (product < 0n ? -product : product).toString().padStart(scale + 1, "0");
  return scale ? `${sign}${text.slice(0, -scale)}.${text.slice(-scale)}` : `${sign}${text}`;
}

/** A cart priced from the book with the server's engine, in the fields the till shows (`_calc`'s). */
export async function priceOffline(book: PriceBook, lines: { key: string; item: string; item_name: string; qty: number }[]): Promise<Doc> {
  const items = new Map(book.items.map((i) => [i.id, i]));
  const missing = lines.find((l) => !items.has(l.item));
  if (missing) throw new Error(`${missing.item_name} has no price on this device yet: sell it when the connection is back`);
  const out = await calculate({
    ...book.engine,
    lines: lines.map((l) => {
      const { tax_qty, ...line } = items.get(l.item)!.line;
      return { key: l.key, qty: String(l.qty), ...line, ...(tax_qty ? { tax_qty: times(tax_qty, String(l.qty)) } : {}) };
    }),
  });
  return {
    items: lines.map((l, i) => ({ item: l.item, item_name: l.item_name, qty: String(l.qty), rate: out.lines[i].rate, amount: out.lines[i].amount })),
    total: out.total,
    discount_amount: out.discount_amount,
    total_taxes: out.total_taxes,
    grand_total: out.grand_total,
    rounded_total: out.rounded_total,
    offline: true,
  };
}

// ── what the till last knew ──

export interface TillMemory {
  email: string;
  profile: Doc;
  session: { id: string; number: string } | null;
  /** Ways of paying, with their kinds (cash shows quick amounts). */
  modes: Doc[];
}

const MEMORY = "ferrum.pos.till";

export function recallTill(profile: string, email: string): TillMemory | null {
  try {
    const all = JSON.parse(localStorage.getItem(MEMORY) ?? "{}") as Record<string, TillMemory>;
    const m = all[profile];
    return m && m.email === email ? m : null;
  } catch {
    return null;
  }
}

export function rememberTill(m: TillMemory): void {
  try {
    const all = JSON.parse(localStorage.getItem(MEMORY) ?? "{}") as Record<string, TillMemory>;
    all[String(m.profile.id)] = m;
    localStorage.setItem(MEMORY, JSON.stringify(all));
  } catch {
    // a private window: the till starts online only
  }
}

/** Registers this device worked, for picking one offline. */
export function knownRegisters(email: string): Doc[] {
  try {
    const all = JSON.parse(localStorage.getItem(MEMORY) ?? "{}") as Record<string, TillMemory>;
    return Object.values(all)
      .filter((m) => m.email === email)
      .map((m) => m.profile);
  } catch {
    return [];
  }
}
