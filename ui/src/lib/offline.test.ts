import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import fixtures from "./pricing.fixtures.json";
import { downloadSnapshot, listPrices, markDown, markUp, priceOffline, readable, scanBook, searchBook, serverDown, tillAll, unreachable, type PriceBook } from "./offline";
import { loadPricing, type Basket, type Priced, type PricingSnapshot } from "./pricing";

// An ERP fixture (pricing/tests: three items, three promotions, taxes of 8% and 10%) as the till keeps it: the snapshot plus what the till shows.
const fixture = fixtures.cases[0] as unknown as { request: { snapshot: PricingSnapshot; basket: Basket }; priced: Priced };
const book: PriceBook = {
  ...(fixture.request.snapshot as PriceBook),
  profile: "p1",
  catalog: [
    { id: "i0", code: "TEA", name: "Masala tea", barcode: "8901" },
    { id: "i1", code: "CAKE", name: "Plum cake", barcode: null },
    { id: "i2", code: "BUN", name: "Bun", barcode: null },
  ],
  barcodes: [{ barcode: "CASE6", item: "i0", qty: "6" }],
  built_at: "2026-11-12T00:00:00Z",
};
// The moment the fixture's basket is at, as a Date in this device's time zone (its snapshot names none).
const at = (m: string) => {
  const [d, h] = m.split(" ");
  const [y, mo, da] = d.split("-").map(Number);
  const [hh, mm] = h.split(":").map(Number);
  return new Date(y, mo - 1, da, hh, mm);
};

beforeAll(async () => {
  await loadPricing(readFileSync(new URL("../vendor/pricing/ferrum_erp_pricing_bg.wasm", import.meta.url)));
});

describe("selling offline", () => {
  it("prices a cart from the snapshot with promotions, the free item they add and the tax by rate, as the server prices it", async () => {
    const lines = fixture.request.basket.lines.map((l, i) => ({ key: `k${i}`, item: l.item, item_name: `line ${i}`, qty: Number(l.qty) }));
    const doc = await priceOffline(book, lines, { at: at(fixture.request.basket.at) });
    const want = fixture.priced.totals;
    expect([doc.total, doc.total_taxes, doc.grand_total, doc.rounded_total, doc.rounding_adjustment, doc.offline]).toEqual([want.total, want.total_taxes, want.grand_total, want.rounded_total, want.rounding_adjustment, true]);
    const items = doc.items as { item: string; item_name: string; rate: string; amount: string; promotion_percent: string; added_by_promotion?: string }[];
    expect(items.map((i) => i.amount)).toEqual(want.lines.map((l) => l.amount));
    // The promotional price is each line's own: its promotion share, and the free item added after the cashier's lines (named from the catalog).
    expect(items.some((i) => Number(i.promotion_percent) > 0)).toBe(true);
    expect(items.slice(3).map((i) => [i.added_by_promotion !== undefined, i.item_name])).toEqual([[true, book.catalog.find((c) => c.id === items[3].item)!.name]]);
    expect((doc.applied_promotions as unknown[]).length).toBe(fixture.priced.applied.length);
    expect((doc.tax_breakdown as { rate: string; tax_amount: string }[]).map((r) => [r.rate, r.tax_amount])).toEqual([["8", "86.81"], ["10", "2.82"]]);
  });

  it("applies a price or discount the cashier typed in place of the snapshot's, as the server does", async () => {
    const when = at(fixture.request.basket.at);
    const plain = await priceOffline(book, [{ key: "a", item: "i2", item_name: "Bun", qty: 1 }], { at: when });
    const typed = await priceOffline(book, [{ key: "a", item: "i2", item_name: "Bun", qty: 1, price: "50", discount: "10" }], { at: when });
    const only = (d: Record<string, unknown>) => (d.items as { price_list_rate: string; discount_percent: string }[])[0];
    expect([only(typed).price_list_rate, only(typed).discount_percent]).toEqual(["50", "10"]);
    expect(only(plain).price_list_rate).not.toBe("50");
    // A blank box is no typed value.
    const blank = await priceOffline(book, [{ key: "a", item: "i2", item_name: "Bun", qty: 1, price: "  ", discount: "" }], { at: when });
    expect(only(blank)).toEqual(only(plain));
  });

  it("will not price what the snapshot cannot: an item it does not hold, a snapshot of another shape (0.7.1's), a day it does not cover", async () => {
    const when = at(fixture.request.basket.at);
    await expect(priceOffline(book, [{ key: "c", item: "i-new", item_name: "Scones", qty: 1 }], { at: when })).rejects.toThrow(/Scones has no price on this device/);
    const old = { ...book, schema: undefined } as unknown as PriceBook;
    await expect(priceOffline(old, [{ key: "a", item: "i2", item_name: "Bun", qty: 1 }], { at: when })).rejects.toThrow(/Offline pricing is not available/);
    expect([readable(old), readable(book), readable(null)]).toEqual([false, true, false]);
    await expect(priceOffline(book, [{ key: "a", item: "i2", item_name: "Bun", qty: 1 }], { at: new Date(2031, 0, 1, 10, 0) })).rejects.toThrow(/the snapshot prices from/);
  });

  it("lists each item's price and its rule's discount from the snapshot, and nothing for an item it does not hold", async () => {
    const got = await listPrices(book, ["i0", "i0", "i1", "ghost"], at(fixture.request.basket.at));
    expect([...got.keys()]).toEqual(["i0", "i1"]);
    expect(Number(got.get("i0")!.list)).toBeGreaterThan(0);
    expect((await listPrices({ ...book, schema: 9 }, ["i0"])).size).toBe(0);
  });

  it("scans and searches the price book", () => {
    expect(scanBook(book, "CASE6")).toMatchObject({ item: { id: "i0" }, qty: 6 });
    expect(scanBook(book, "8901")).toMatchObject({ item: { id: "i0" }, qty: 1 });
    expect(scanBook(book, "cake")).toMatchObject({ item: { id: "i1" }, qty: 1 });
    expect(scanBook(book, "nothing")).toBeNull();
    expect(searchBook(book, "cake plum").map((i) => i.id)).toEqual(["i1"]);
    expect(searchBook(book, "").map((i) => i.id)).toEqual(["i2", "i0", "i1"]);
  });

  it("keeps the whole snapshot the server gave: its schema, version, signature, promotions and buyer rule", async () => {
    const answer = { ...fixture.request.snapshot, catalog: book.catalog, barcodes: book.barcodes, version: "ab12", signature: "sig", buyer: { named_above: "5000", walk_in: "walkin" }, truncated: false, built_at: "2026-11-13T09:00:00Z" };
    const got = await downloadSnapshot("p1", async () => answer);
    expect([got.schema, got.catalog.map((i) => i.id), got.barcodes.length, got.version, got.signature, (got.promotions as unknown[]).length, got.buyer?.named_above, got.truncated, got.profile]).toEqual([1, ["i0", "i1", "i2"], 1, "ab12", "sig", 2, "5000", false, "p1"]);
    // One from a server that signs nothing: nothing invented.
    const bare = await downloadSnapshot("p1", async () => ({ catalog: [], barcodes: [] }));
    expect([bare.version, bare.signature, bare.truncated, bare.customer]).toEqual([undefined, null, false, null]);
  });

  it("does not wait again for a server that has just failed to answer", () => {
    markUp();
    expect(serverDown(1_000)).toBe(false);
    markDown(1_000);
    expect([serverDown(1_000), serverDown(20_999), serverDown(21_000)]).toEqual([true, true, false]);
    markUp();
    expect(serverDown(1_500)).toBe(false);
  });

  it("tells a lost connection or an ended session from a refusal", () => {
    expect([unreachable(new TypeError("Failed to fetch")), unreachable({ status: 401 }), unreachable({ status: 503 }), unreachable({ status: 422 }), unreachable(null)]).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("what the device keeps", () => {
  const memory = () => {
    const map = new Map<string, string>();
    return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k), key: (i: number) => [...map.keys()][i] ?? null, get length() { return map.size; } };
  };
  const till = { email: "asha@shop.test", profile: { id: "p1", name: "Front" }, session: null, modes: [] };
  const lease = (key: string, until: string | null) => ({ allowed: until !== null, until, hours: 72, key, person: "u1" });

  it("keeps the till's memory under the lease, for this sign-in only", async () => {
    const { resetBootstrap } = await import("@ferrum/client");
    const { fakeBootstrap } = await import("@ferrum/testing");
    const { recallTill, rememberTill, keepToTheLease } = await import("./offline");
    const storage = memory();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    const as = (offline: unknown) => {
      (globalThis as { __FERRUM_BOOTSTRAP__?: unknown }).__FERRUM_BOOTSTRAP__ = fakeBootstrap({ offline } as never);
      resetBootstrap();
    };
    as(lease("k1", "2999-01-01T00:00:00Z"));
    storage.setItem("ferrum.pos.till", JSON.stringify({ p1: till }));
    const stop = keepToTheLease();
    stop();
    expect(storage.map.has("ferrum.pos.till")).toBe(false);
    rememberTill(till);
    expect(recallTill("p1", "asha@shop.test")?.profile.name).toBe("Front");
    // Signed out everywhere: a new key, and what the old sign-in kept goes.
    as(lease("k2", "2999-01-01T00:00:00Z"));
    keepToTheLease()();
    expect(recallTill("p1", "asha@shop.test")).toBeNull();
    expect([...storage.map.keys()].filter((k) => k.includes(".pos.k1."))).toEqual([]);
    // The workspace keeps nothing on devices: nothing is kept.
    as(lease("k2", null));
    rememberTill(till);
    expect(recallTill("p1", "asha@shop.test")).toBeNull();
  });
});

describe("a list read whole", () => {
  it("reads every page of a customer's points, not the first 500", async () => {
    const pages: Record<string, { rows: { points: number }[]; next_cursor?: string | null }> = {
      "": { rows: [{ points: 100 }, { points: -30 }], next_cursor: "c2" },
      c2: { rows: [{ points: 50 }], next_cursor: null },
    };
    const asked: unknown[] = [];
    const get = async <R,>(_p: string, o: { query?: Record<string, unknown> }) => {
      asked.push([o.query?.cursor, o.query?.sort, o.query?.limit]);
      return pages[String(o.query?.cursor ?? "")] as R;
    };
    const rows = await tillAll<{ points: number }>("/api/v1/LoyaltyPointEntry", { fields: "points" }, undefined, get);
    expect(rows.reduce((s, r) => s + r.points, 0)).toBe(120);
    expect(asked).toEqual([
      [undefined, "created_at desc", 500],
      ["c2", "created_at desc", 500],
    ]);
  });
});
