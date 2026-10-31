import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { engineUrl, loadEngine } from "@ferrum/calc";
import { downloadBook, priceOffline, scanBook, searchBook, times, unreachable, type PriceBook } from "./offline";

const book: PriceBook = {
  profile: "p1",
  currency: "INR",
  customer: "walk-in",
  engine: { precision: 2, taxes: [{ key: "gst", charge_type: "on_net_total", rate: "5" }], round_total_to: "1" },
  items: [
    { id: "i-tea", code: "TEA", name: "Masala tea", barcode: "8901", line: { price: "20.00" } },
    { id: "i-cake", code: "CAKE", name: "Plum cake", barcode: null, line: { price: "45.00", discount_percent: "10", tax_rates: { gst: "12" } } },
  ],
  barcodes: [{ barcode: "CASE6", item: "i-tea", qty: "6" }],
  built_at: "2026-10-31T00:00:00Z",
};

describe("selling offline", () => {
  it("counts a per-unit tax in stock units, exactly", async () => {
    await loadEngine(readFileSync(new URL(engineUrl)));
    // A six-pack of bottles with a deposit of 0.10 a bottle.
    const deposit: PriceBook = {
      ...book,
      engine: { precision: 2, taxes: [{ key: "dep", charge_type: "on_item_quantity", rate: "0.10" }] },
      items: [{ id: "i-six", code: "SIX", name: "Six-pack", barcode: null, line: { price: "6.00", tax_qty: "6" } }],
    };
    const doc = await priceOffline(deposit, [{ key: "a", item: "i-six", item_name: "Six-pack", qty: 2 }]);
    expect([doc.total, doc.total_taxes, doc.grand_total]).toEqual(["12.00", "1.20", "13.20"]);
    expect([times("0.1", "3"), times("1.5", "0.5"), times("-2", "0.25"), times("12", "1")]).toEqual(["0.3", "0.75", "-0.50", "12"]);
  });

  it("prices a cart with the server's engine from the price book", async () => {
    await loadEngine(readFileSync(new URL(engineUrl)));
    const doc = await priceOffline(book, [
      { key: "a", item: "i-tea", item_name: "Masala tea", qty: 3 },
      { key: "b", item: "i-cake", item_name: "Plum cake", qty: 1 },
    ]);
    // 3 × 20.00 + 40.50 = 100.50; 5% of 60.00 + 12% of 40.50 = 3.00 + 4.86 = 7.86; 108.36 → 108.00.
    expect([doc.total, doc.total_taxes, doc.grand_total, doc.rounded_total, doc.offline]).toEqual(["100.50", "7.86", "108.36", "108.00", true]);
    await expect(priceOffline(book, [{ key: "c", item: "i-new", item_name: "Scones", qty: 1 }])).rejects.toThrow(/Scones has no price on this device/);
  });

  it("scans and searches the price book", () => {
    expect(scanBook(book, "CASE6")).toMatchObject({ item: { id: "i-tea" }, qty: 6 });
    expect(scanBook(book, "8901")).toMatchObject({ item: { id: "i-tea" }, qty: 1 });
    expect(scanBook(book, "cake")).toMatchObject({ item: { id: "i-cake" }, qty: 1 });
    expect(scanBook(book, "nothing")).toBeNull();
    expect(searchBook(book, "cake plum").map((i) => i.id)).toEqual(["i-cake"]);
    expect(searchBook(book, "").map((i) => i.id)).toEqual(["i-tea", "i-cake"]);
  });

  it("downloads every page of the book", async () => {
    const pages: Record<string, { items: PriceBook["items"]; barcodes: PriceBook["barcodes"]; next: string | null; engine?: PriceBook["engine"] }> = {
      start: { engine: book.engine, items: [book.items[0]], barcodes: [], next: "i-tea" },
      "i-tea": { engine: book.engine, items: [book.items[1]], barcodes: book.barcodes, next: null },
    };
    const got = await downloadBook("p1", async (after) => pages[after ?? "start"]);
    expect([got.items.map((i) => i.id), got.barcodes.length, got.engine.round_total_to]).toEqual([["i-tea", "i-cake"], 1, "1"]);
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
