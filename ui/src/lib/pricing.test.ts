import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import fixtures from "./pricing.fixtures.json";
import { loadPricing, momentIn, priceBasket, PRICING_SCHEMA, type Basket, type Priced, type PricingSnapshot } from "./pricing";

// The real WebAssembly, ERP's pricing crate as built by its scripts/pricing-wasm.sh, priced against two of ERP's own fixture baskets
// (pricing/tests/baskets.jsonl and priced.jsonl): what the crate gives natively, to the cent.
const cases = fixtures.cases as unknown as { request: { snapshot: PricingSnapshot; basket: Basket }; priced: Priced }[];

beforeAll(async () => {
  await loadPricing(readFileSync(new URL("../vendor/pricing/ferrum_erp_pricing_bg.wasm", import.meta.url)));
});

describe("ERP's pricing engine in the till", () => {
  it("prices a basket with promotions, a free item and two tax rates as the crate does", async () => {
    const { request, priced } = cases[0];
    const got = await priceBasket(request);
    expect(got).toEqual(priced);
    expect([got.totals.net_total, got.totals.total_taxes, got.totals.rounded_total]).toEqual([priced.totals.net_total, "89.63", "1202.91"]);
    expect(got.tax_summary.map((r) => [r.rate, r.tax_amount])).toEqual([["8", "86.81"], ["10", "2.82"]]);
    expect(got.lines.filter((l) => l.added_by_promotion)).toHaveLength(1);
  });

  it("prices a basket with the document's discount and nine promotion shares to the cent", async () => {
    const { request, priced } = cases[1];
    const got = await priceBasket(request);
    expect(got).toEqual(priced);
    expect([got.applied.length, got.totals.total_taxes, got.totals.rounded_total]).toEqual([9, "114.79", "2005.78"]);
  });

  it("refuses a snapshot whose schema it does not know, and a day the snapshot does not cover", async () => {
    const { request } = cases[0];
    await expect(priceBasket({ ...request, snapshot: { ...request.snapshot, schema: PRICING_SCHEMA + 1 } })).rejects.toThrow(/Offline pricing is not available/);
    const { schema: _gone, ...old } = request.snapshot;
    await expect(priceBasket({ ...request, snapshot: old as unknown as PricingSnapshot })).rejects.toThrow(/Offline pricing is not available/);
    await expect(priceBasket({ ...request, basket: { ...request.basket, at: "2030-01-01 10:00" } })).rejects.toThrow(/not on 2030-01-01/);
  });

  it("gives the moment in the snapshot's time zone", () => {
    const at = new Date("2026-11-13T22:30:00Z");
    expect([momentIn("Asia/Kolkata", at), momentIn("America/New_York", at), momentIn("UTC", new Date("2026-11-13T00:05:00Z"))]).toEqual(["2026-11-14 04:00", "2026-11-13 17:30", "2026-11-13 00:05"]);
  });
});
