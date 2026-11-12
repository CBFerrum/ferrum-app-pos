import { describe, expect, it } from "vitest";
import { backItems, checkRefund, enteredPriceProblem, exchange, parsePolicy, refundPayments, refundPlan, restockingFee, returnBody, returnItems, unreceiptedBody, type Method, type Sheet } from "./returns";

const cash: Method = { mode: "cash", name: "Cash", kind: "Cash", usable: true };
const card: Method = { mode: "card", name: "Card", kind: "Bank", usable: true };
const credit: Method = { mode: "credit", name: "Credit", kind: "Credit", usable: true };
const points: Method = { mode: "points", name: "Loyalty Points", kind: "Loyalty Points", usable: true };
const sheet = (over: Partial<Sheet>): Pick<Sheet, "paid_with" | "methods" | "refundable" | "loyalty"> => ({
  methods: [cash, card, credit, points],
  paid_with: [],
  refundable: { money: "0", loyalty: "0", credit: "0" },
  loyalty: null,
  ...over,
});
const paid = (mode: string, left: string) => ({ mode, paid: left, refunded: "0", left });

describe("planning a refund the way the sale was paid", () => {
  it("sends money back through the ways it came in, in the order they were used", () => {
    const s = sheet({ paid_with: [paid("card", "100"), paid("cash", "50")], refundable: { money: "150", loyalty: "0", credit: "0" } });
    expect(refundPlan(150, s)).toEqual({ rows: [{ mode: "card", amount: 100 }, { mode: "cash", amount: 50 }], problem: null });
    expect(refundPlan(40, s).rows).toEqual([{ mode: "card", amount: 40 }]);
    expect(refundPlan(120, s).rows).toEqual([{ mode: "card", amount: 100 }, { mode: "cash", amount: 20 }]);
  });

  it("takes a way of paying this register no longer offers back in cash", () => {
    const gone = { ...card, usable: false, why: "this register does not refund through it" };
    const s = sheet({ methods: [cash, gone], paid_with: [paid("card", "100")], refundable: { money: "100", loyalty: "0", credit: "0" } });
    expect(refundPlan(60, s).rows).toEqual([{ mode: "cash", amount: 60 }]);
    expect(refundPlan(60, sheet({ methods: [gone], paid_with: [paid("card", "100")], refundable: { money: "100", loyalty: "0", credit: "0" } })).problem).toMatch(/no cash, card/);
  });

  it("cancels what the customer still owes first, and only then pays out", () => {
    const s = sheet({ paid_with: [paid("credit", "40"), paid("cash", "60")], refundable: { money: "60", loyalty: "0", credit: "40" } });
    expect(refundPlan(50, s).rows).toEqual([{ mode: "credit", amount: 40 }, { mode: "cash", amount: 10 }]);
    expect(refundPlan(30, s).rows).toEqual([{ mode: "credit", amount: 30 }]);
    expect(refundPlan(30, sheet({ methods: [cash], refundable: { money: "0", loyalty: "0", credit: "40" } })).problem).toMatch(/no Credit method/);
  });

  it("gives points back as points, in their share of the bill", () => {
    // 11.00 paid with 4 points (2.00 at half a unit a point) and 9.00 in cash.
    const s = sheet({ paid_with: [paid("points", "2"), paid("cash", "9")], refundable: { money: "9", loyalty: "2", credit: "0" }, loyalty: { factor: "0.5", points_left: 4 } });
    expect(refundPlan(11, s).rows).toEqual([{ mode: "points", amount: 2, points: 4 }, { mode: "cash", amount: 9 }]);
    // Half of it back: about half the points.
    expect(refundPlan(5.5, s).rows).toEqual([{ mode: "points", amount: 1, points: 2 }, { mode: "cash", amount: 4.5 }]);
    // 10 back: the points' share is 1.82, nearest whole points 2.00; the cash cannot take more than its 9 anyway.
    expect(refundPlan(10, s).rows).toEqual([{ mode: "points", amount: 2, points: 4 }, { mode: "cash", amount: 8 }]);
    // Points that must go back whole: the cash can take 9 of the 10.50, so at least 1.50 is points.
    expect(refundPlan(10.5, { ...s, loyalty: { factor: "0.5", points_left: 4 } }).rows).toEqual([{ mode: "points", amount: 2, points: 4 }, { mode: "cash", amount: 8.5 }]);
  });

  it("brings back a sale that was written off by a few cents whole", () => {
    const s = sheet({ paid_with: [paid("cash", "10.95")], refundable: { money: "11", loyalty: "0", credit: "0" } });
    expect(refundPlan(11, s).rows).toEqual([{ mode: "cash", amount: 11 }]);
  });
});

describe("checking a refund before the server does", () => {
  const s = sheet({ refundable: { money: "9", loyalty: "2", credit: "40" }, loyalty: { factor: "0.5", points_left: 4 } });
  const ok = (rows: { mode: string; amount: number }[], total: number) => checkRefund(total, rows, s);

  it("wants the refunds to add up to the return", () => {
    expect(ok([{ mode: "cash", amount: 5 }], 6)).toBe("The refunds add up to 5.00 of 6.00.");
  });

  it("holds each kind of way to what the sale took in that way", () => {
    expect(ok([{ mode: "credit", amount: 40 }, { mode: "cash", amount: 9 }, { mode: "points", amount: 2 }], 51)).toBeNull();
    expect(ok([{ mode: "cash", amount: 20 }], 20)).toMatch(/must go to Credit/);
    expect(checkRefund(10, [{ mode: "cash", amount: 10 }], sheet({ refundable: { money: "9", loyalty: "1", credit: "0" } }))).toBe("At most 9.00 can be refunded in cash or to cards: that is what the sale was paid with.");
    expect(checkRefund(5, [{ mode: "credit", amount: 5 }], sheet({ refundable: { money: "9", loyalty: "0", credit: "0" } }))).toMatch(/paid in full/);
    expect(checkRefund(5, [{ mode: "points", amount: 5 }], sheet({ refundable: { money: "9", loyalty: "2", credit: "0" } }))).toBe("At most 2.00 can go back as loyalty points.");
  });

  it("names a method this register does not refund through", () => {
    const gone = sheet({ methods: [{ ...card, usable: false }], refundable: { money: "9", loyalty: "0", credit: "0" } });
    expect(checkRefund(5, [{ mode: "card", amount: 5 }], gone)).toBe("Card cannot refund returns at this register.");
  });

  it("accepts what the plan itself makes", () => {
    const full = sheet({ paid_with: [paid("points", "2"), paid("cash", "9")], refundable: { money: "9", loyalty: "2", credit: "0" }, loyalty: { factor: "0.5", points_left: 4 } });
    for (const total of [11, 5.5, 10, 2, 0.5]) {
      const plan = refundPlan(total, full);
      expect([total, plan.problem, checkRefund(total, plan.rows, full)]).toEqual([total, null, null]);
    }
  });
});

describe("what the return sends", () => {
  const lines = [
    { id: "l1", item: "i-tea", item_name: "Tea", sold: "3", returned: "1", left: "2", rate: "20", amount: "60", serials: [] },
    { id: "l2", item: "i-phone", item_name: "Phone", sold: "2", returned: "0", left: "2", rate: "500", amount: "1000", serials: ["SN-1", "SN-2"] },
    { id: "l3", item: "i-gum", item_name: "Gum", sold: "1", returned: "0", left: "1", rate: "2", amount: "2", serials: [] },
  ];

  it("returns the lines picked, never more than is left, each against its sale line", () => {
    const items = returnItems({ lines }, { l1: { qty: 5, serials: [] }, l2: { qty: 1, serials: ["SN-2"] }, l3: { qty: 0, serials: [] } });
    expect(items).toEqual([
      { item: "i-tea", qty: "-2", original_line: "l1" },
      { item: "i-phone", qty: "-1", original_line: "l2", serial_no: "SN-2" },
    ]);
    expect(returnItems({ lines }, {})).toEqual([]);
  });

  it("refunds with negative amounts, points as points, and the card's reference", () => {
    expect(refundPayments([{ mode: "cash", amount: 9 }, { mode: "points", amount: 2, points: 4 }, { mode: "card", amount: 5 }, { mode: "upi", amount: 0 }], { card: " AUTH 7 " })).toEqual([
      { mode_of_payment: "cash", amount: "-9" },
      { mode_of_payment: "points", loyalty_points: 4 },
      { mode_of_payment: "card", amount: "-5", reference_no: "AUTH 7" },
    ]);
  });

  it("builds the body for the preview and for the return", () => {
    const items = [{ item: "i-tea", qty: "-1", original_line: "l1" }];
    expect(returnBody({ profile: "p", session: "s", sale: "sale-1", items })).toEqual({ pos_profile: "p", pos_opening_entry: "s", is_return: true, return_against: "sale-1", items, payments: [] });
    expect(returnBody({ id: "r-1", profile: "p", session: "s", sale: "sale-1", reason: " Faulty ", items, payments: [{ mode_of_payment: "cash", amount: "-20" }] })).toMatchObject({ id: "r-1", return_reason: "Faulty" });
  });
});

describe("a sale paid with a card goes back onto stored value (logic.rs check_refunds)", () => {
  const stored: Method = { mode: "gift", name: "Gift card", kind: "Stored Value", usable: true };
  // Paid 70 by card and 30 in cash: the cash part may go back as store credit, the card's never as money.
  const s = sheet({ methods: [cash, stored], paid_with: [paid("gift", "70"), paid("cash", "30")], refundable: { money: "30", loyalty: "0", credit: "0", stored_value: "70" } });

  it("refuses money beyond the cash part, and accepts cash and card, or all as stored value", () => {
    expect(checkRefund(100, [{ mode: "cash", amount: 100 }], s)).toMatch(/At most 30.00 can be refunded in cash/);
    expect(checkRefund(100, [{ mode: "cash", amount: 30 }, { mode: "gift", amount: 70 }], s)).toBeNull();
    expect(checkRefund(100, [{ mode: "gift", amount: 100 }], s)).toBeNull();
    expect(checkRefund(100, [{ mode: "gift", amount: 101 }], s)).toMatch(/refunds add up/);
    expect(checkRefund(40, [{ mode: "gift", amount: 40 }], sheet({ ...s, refundable: { money: "0", loyalty: "0", credit: "0", stored_value: "30" } }))).toMatch(/At most 30.00 can go back onto stored value/);
  });

  it("plans the card's share back onto the card first, then cash", () => {
    expect(refundPlan(100, s).rows).toEqual([{ mode: "gift", amount: 70 }, { mode: "cash", amount: 30 }]);
    expect(refundPlan(50, s).rows).toEqual([{ mode: "gift", amount: 50 }]);
  });

  it("sends a card's code only on its own row, trimmed", () => {
    expect(refundPayments([{ mode: "gift", amount: 70 }, { mode: "cash", amount: 30 }], {}, { gift: { code: " 7KQ2-M9XD ", pin: "1234" } })).toEqual([
      { mode_of_payment: "gift", amount: "-70", stored_value_code: "7KQ2-M9XD", stored_value_pin: "1234" },
      { mode_of_payment: "cash", amount: "-30" },
    ]);
  });
});

describe("returns without a receipt and exchanges (logic.rs)", () => {
  const policy = parsePolicy({ price_basis: "Entered", window_days: 30, store_credit: "credit-mode", refund_modes: [{ mode_of_payment: "cash" }], fees: [{ condition: "Damaged", fee_percent: "15" }], exchange_mode: "clearing" });

  it("reads the policy and finds the restocking fee of a condition", () => {
    expect(policy).toEqual({ price_basis: "Entered", window_days: 30, store_credit: "credit-mode", refund_modes: ["cash"], fees: [{ condition: "Damaged", fee_percent: 15 }], exchange_mode: "clearing" });
    expect([restockingFee(policy.fees, "Damaged"), restockingFee(policy.fees, "Resaleable")]).toEqual([15, 0]);
    expect(parsePolicy({}).price_basis).toBe("Current Price");
  });

  it("asks for a price only when the policy takes the one typed", () => {
    expect(enteredPriceProblem("Entered", undefined)).toMatch(/Type the price/);
    expect(enteredPriceProblem("Entered", "75")).toBeNull();
    expect(enteredPriceProblem("Current Price", undefined)).toBeNull();
  });

  it("carries what came back to what goes out, and splits the rest", () => {
    expect(exchange(100, 130)).toEqual({ carried: 100, due: 30, refund: 0 });
    expect(exchange(100, 60)).toEqual({ carried: 60, due: 0, refund: 40 });
    expect(exchange(50, 50)).toEqual({ carried: 50, due: 0, refund: 0 });
  });

  it("builds the return that names no sale", () => {
    const items = backItems([{ key: "k", item: "i-pen", item_name: "Pen", qty: 2, condition: "Damaged", price: " 75 " }], "Entered");
    expect(items).toEqual([{ item: "i-pen", qty: "-2", condition: "Damaged", manual_rate: "75" }]);
    expect(backItems([{ key: "k", item: "i-pen", item_name: "Pen", qty: 1, condition: "Resaleable", price: "75" }], "Current Price")).toEqual([{ item: "i-pen", qty: "-1", condition: "Resaleable" }]);
    expect(unreceiptedBody({ id: "r1", profile: "p", session: "s", customer: null, reason: "why", items, approvals: ["a1"] })).toEqual({
      id: "r1",
      pos_profile: "p",
      pos_opening_entry: "s",
      is_return: true,
      without_receipt: true,
      reason: "why",
      items,
      payments: [],
      approvals: [{ approval: "a1" }],
    });
  });
});
