import { describe, expect, it } from "vitest";
import { allows, asksFor, beyond, covered, lineAsks, lineProblem, parseLimits, rightsOf, UNLIMITED, type Limits, type LineAsk } from "./rights";

// The same limits and cases as `logic.rs`'s unit tests (limits_of_several_roles…, what_a_sale_asks_beyond_the_limits).
const cashier: Limits = {
  discount_percent: 10,
  discount_amount: 50,
  change_price: false,
  void_line: true,
  void_sale: false,
  refund: 200,
  return_without_receipt: false,
  open_drawer: false,
  reprint: true,
};
const line = (list: number, rule: number, price?: number, discount?: number): LineAsk => ({ qty: 1, list, rule, price, discount });

describe("what a sale asks beyond the limits (logic.rs beyond)", () => {
  it("lets a discount reach the limit, and asks for anything over it", () => {
    expect(beyond(cashier, [line(100, 0, undefined, 10)])).toEqual([]);
    const over = beyond(cashier, [line(100, 0, undefined, 12)]);
    expect([over[0].line, over[0].act, over[0].figure]).toEqual([0, "Discount", 12]);
  });

  it("stands by a pricing rule's own discount", () => {
    expect(beyond(cashier, [line(100, 15)])).toEqual([]);
  });

  it("counts a typed price as a price change, and the line's and the sale's discounts together", () => {
    const typed = beyond(cashier, [line(100, 0, 95, 5)]);
    expect(typed.map((x) => x.act)).toEqual(["Price Change"]);
    expect(beyond(cashier, [line(100, 0, undefined, 5)], 6)[0].act).toBe("Discount"); // 5% then 6% is 10.7%
  });

  it("holds the whole sale to its money limit", () => {
    // 10% on six lines of 100 is 60 given, over the 50 a sale may carry.
    const six = Array.from({ length: 6 }, () => line(100, 0, undefined, 10));
    const sale = beyond(cashier, six);
    expect([sale.length, sale[0].line, sale[0].figure]).toEqual([1, null, 60]);
    expect(beyond(UNLIMITED, six, 50)).toEqual([]);
  });
});

describe("what a person may do (logic.rs allows)", () => {
  it("checks a refund against the cap, inclusive, and no cap against nothing", () => {
    expect(allows(UNLIMITED, "Refund", 1_000_000)).toBe(true);
    expect(allows(cashier, "Refund", 200.01)).toBe(false);
    expect(allows(cashier, "Refund", 200)).toBe(true);
    expect(allows(cashier, "Void Sale")).toBe(false);
    expect(allows(cashier, "Void Line")).toBe(true);
    expect(allows(cashier, "Return Without Receipt")).toBe(false);
  });
});

describe("the limits the server sends", () => {
  it("reads decimals that come as text, and null caps as no cap", () => {
    const raw = { discount_percent: "10", discount_amount: "50", change_price: false, void_line: true, void_sale: false, refund: null, return_without_receipt: false, open_drawer: false, reprint: true };
    expect(parseLimits(raw)).toEqual({ ...cashier, discount_amount: 50, refund: null });
    expect(parseLimits({})).toBeNull();
    expect(parseLimits(null)).toBeNull();
  });

  it("answers from the register's switches until they are known, as the server does for a role with no row", () => {
    const shop = { allow_discount_change: true, max_discount: "10", allow_rate_change: false };
    expect(rightsOf(shop, false)).toEqual({ ...cashier, discount_amount: null, refund: null });
    expect(rightsOf({ max_discount: "10" }, false).discount_percent).toBe(0);
    expect(rightsOf({}, false).change_price).toBe(false);
    expect(rightsOf({}, true)).toEqual(UNLIMITED);
  });
});

describe("asking for approval", () => {
  it("asks once for an act however many lines are over it, for the largest figure, rounded up", () => {
    const found = beyond(cashier, [line(100, 0, undefined, 12), line(100, 0, undefined, 15.123)]);
    expect(asksFor(found, [])).toEqual([{ act: "Discount", figure: 15.13, why: expect.any(String) }]);
  });

  it("counts an approval already given, for the same act and at least the figure asked", () => {
    const found = beyond(cashier, [line(100, 0, undefined, 12)]);
    expect(asksFor(found, [{ id: "a1", act: "Discount", figure: 12, by: "boss@shop.test" }])).toEqual([]);
    expect(asksFor(found, [{ id: "a1", act: "Discount", figure: 11, by: "boss@shop.test" }]).length).toBe(1);
    expect(asksFor(found, [{ id: "a1", act: "Price Change", figure: 0, by: "boss@shop.test" }]).length).toBe(1);
    // The sale's money limit and a line's percent are different approvals.
    const six = beyond(cashier, Array.from({ length: 6 }, () => line(100, 0, undefined, 10)));
    expect(covered([{ id: "a1", act: "Discount", figure: 100, by: "x" }], six[0])).toBe(false);
    expect(covered([{ id: "a1", act: "Discount", figure: 60, money: true, by: "x" }], six[0])).toBe(true);
  });

  it("asks about a typed line, and says what makes no sense before asking", () => {
    expect(lineAsks(cashier, { list: 100, rule: 0, discount: "12.5" }).map((a) => [a.act, a.figure])).toEqual([["Discount", 12.5]]);
    expect(lineAsks(cashier, { list: 100, rule: 0, discount: "8" })).toEqual([]);
    expect(lineAsks(cashier, { list: 100, rule: 0, price: "80" }).map((a) => a.act)).toEqual(["Price Change", "Discount"]);
    expect(lineAsks(cashier, { list: 100, rule: 0, price: "90" }).map((a) => a.act)).toEqual(["Price Change"]);
    expect(lineAsks(cashier, { list: 100, rule: 0, price: "100", discount: "  " })).toEqual([]);
    expect(lineAsks(cashier, { list: 100, rule: 0, discount: "101" })).toEqual([]);
    expect(lineProblem({ discount: "101" })).toMatch(/between 0 and 100/);
    expect(lineProblem({ price: "0" })).toMatch(/above zero/);
    expect(lineProblem({ discount: "  ", price: "" })).toBeNull();
    expect(lineAsks(UNLIMITED, { list: 100, rule: 0, discount: "100", price: "1" })).toEqual([]);
  });
});
