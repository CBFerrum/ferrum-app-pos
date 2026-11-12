import { describe, expect, it } from "vitest";
import { differenceOf, factsOf, gapOf } from "./differences";

// A row as the server lists a Price Difference with titles: src/invoice.rs `record_difference` writes it, packages/pos/entities/pos.yaml defines it.
const row = {
  id: "d1",
  pos_invoice: "s1",
  pos_profile: "p1",
  price_snapshot: "ab12cd34ef56",
  till_total: "139.00",
  replay_total: "139.00",
  sale_total: "131.00",
  snapshot_kept: true,
  status: "Open",
  _titles: { pos_invoice: "C1-2026-27-000042", pos_profile: "Counter 1" },
};

describe("a Price Difference", () => {
  it("reads the row with its sale's number and register", () => {
    expect(differenceOf(row)).toMatchObject({ id: "d1", saleNumber: "C1-2026-27-000042", register: "Counter 1", till: 139, replay: 139, recorded: 131, kept: true, status: "Open" });
  });

  it("says what differs as facts, not causes", () => {
    // The snapshot agreed with the till and the register recorded less: one fact.
    const agreed = differenceOf({ ...row, replay_total: "131.00", till_total: "131.00", sale_total: "131.00" });
    expect(factsOf(agreed)).toEqual([]);
    const tillOnly = differenceOf({ ...row, replay_total: "131.00" });
    expect(factsOf(tillOnly)).toEqual(["The till took payment for 139.00; the register recorded 131.00."]);
    expect(gapOf(tillOnly)).toBe(-8);
    expect(factsOf(differenceOf(row))).toEqual(["The till took payment for 139.00; the register recorded 131.00.", "Priced again with the snapshot it comes to 139.00, not 131.00."]);
  });

  it("says a snapshot that is gone could not price the sale again, and keeps the till's total absent when none was sent", () => {
    const gone = differenceOf({ ...row, snapshot_kept: false, replay_total: null, till_total: null });
    expect(factsOf(gone)).toEqual(["The snapshot the till used is no longer kept, so the sale could not be priced again with it."]);
    expect(gapOf(gone)).toBeNull();
  });

  it("is reviewed with its resolution, who and when", () => {
    expect(differenceOf({ ...row, status: "Reviewed", resolution: "Till was a day old", resolved_by: "mgr@shop.test", resolved_at: "2026-11-13T10:00:00Z" })).toMatchObject({ status: "Reviewed", resolution: "Till was a day old", by: "mgr@shop.test" });
  });
});
