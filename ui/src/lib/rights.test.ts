import { describe, expect, it } from "vitest";
import { discountLimit, lineProblem, rightsOf } from "./rights";

const shop = { allow_discount_change: true, max_discount: "10", allow_rate_change: false };

describe("what a cashier may change", () => {
  it("follows the register's switches, and a manager has none", () => {
    expect(rightsOf(shop, false)).toEqual({ manager: false, discount: true, max: 10, price: false });
    expect(rightsOf({}, false)).toEqual({ manager: false, discount: false, max: 0, price: false });
    expect(rightsOf({ max_discount: "10" }, false).max).toBe(0);
    expect(rightsOf({}, true)).toEqual({ manager: true, discount: true, max: 100, price: true });
  });

  it("lets a discount reach the register's maximum, or what the pricing rules gave if that is more", () => {
    const r = rightsOf(shop, false);
    expect([discountLimit(r, 0), discountLimit(r, 15), discountLimit(rightsOf({}, false), 5), discountLimit(rightsOf({}, true), 0)]).toEqual([10, 15, 5, 100]);
    expect(lineProblem(r, { list: 100, rule: 0, discount: "10" })).toBeNull();
    expect(lineProblem(r, { list: 100, rule: 0, discount: "12.5" })).toBe("That is 12.5% off the list price. You can give up to 10%. Ask a POS manager for more.");
    // The discount replaces the rule's: 8% is less than the 15% a rule gave, so it stays inside.
    expect(lineProblem(r, { list: 100, rule: 15, discount: "8" })).toBeNull();
  });

  it("counts a lower price and a discount together, as the server does", () => {
    const r = rightsOf({ ...shop, allow_rate_change: true }, false);
    expect(lineProblem(r, { list: 100, rule: 0, price: "95" })).toBeNull();
    expect(lineProblem(r, { list: 100, rule: 0, price: "95", discount: "10" })).toMatch(/14.5% off/);
    expect(lineProblem(r, { list: 100, rule: 0, price: "120", discount: "10" })).toBeNull();
    expect(lineProblem(r, { list: 0, rule: 0, price: "5" })).toBeNull();
  });

  it("says what is switched off, and checks what was typed makes sense", () => {
    const none = rightsOf({}, false);
    expect(lineProblem(none, { list: 100, rule: 0, discount: "5" })).toMatch(/does not let cashiers give discounts/);
    expect(lineProblem(none, { list: 100, rule: 5, discount: "5" })).toBeNull();
    expect(lineProblem(none, { list: 100, rule: 0, price: "90" })).toMatch(/does not let cashiers change prices/);
    expect(lineProblem(none, { list: 100, rule: 0, price: "100" })).toBeNull();
    expect(lineProblem(rightsOf({}, true), { list: 100, rule: 0, discount: "100", price: "1" })).toBeNull();
    expect(lineProblem(rightsOf({}, true), { list: 100, rule: 0, discount: "101" })).toMatch(/between 0 and 100/);
    expect(lineProblem(rightsOf({}, true), { list: 100, rule: 0, price: "0" })).toMatch(/above zero/);
    expect(lineProblem(none, { list: 100, rule: 0, discount: "  ", price: "" })).toBeNull();
  });
});
