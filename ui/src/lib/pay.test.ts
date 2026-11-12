import { describe, expect, it } from "vitest";
import { leftOnCard, perTender, pointsAvailable, pointsFor, pointsValue, round, stillDue, tally } from "./pay";

const cash = (amount: number) => ({ kind: "Cash", amount });
const card = (amount: number) => ({ kind: "Bank", amount });

describe("taking payment", () => {
  it("rounds to the currency's places and never to minus zero", () => {
    expect([round(1.005), round(0.1 + 0.2), round(-0.001), round(2.675, 2), round(1234.5, 0), round(0.0005, 3)]).toEqual([1.01, 0.3, 0, 2.68, 1235, 0.001]);
  });

  it("hands change back out of cash", () => {
    expect(tally(472.5, [cash(500)])).toEqual({ tendered: 500, left: 0, change: 27.5, writeOff: 0, problem: null });
    expect(tally(92.5, [card(50), cash(50)])).toMatchObject({ tendered: 100, change: 7.5, problem: null });
    expect(tally(100, [cash(100)])).toMatchObject({ change: 0, left: 0 });
  });

  it("says what is still due, and forgives a small shortfall as the register allows", () => {
    expect(tally(100, [cash(90)])).toMatchObject({ left: 10, writeOff: 0 });
    expect(tally(100.03, [cash(100)], 0.05)).toMatchObject({ left: 0, writeOff: 0.03 });
    expect(tally(100.1, [cash(100)], 0.05)).toMatchObject({ left: 0.1, writeOff: 0 });
    expect(tally(0, [])).toMatchObject({ left: 0, change: 0, problem: null });
  });

  it("refuses to give change for anything but cash", () => {
    expect(tally(80, [card(100)]).problem).toMatch(/Only cash/);
    expect(tally(80, [card(60), { kind: "Loyalty Points", amount: 30 }]).problem).toMatch(/Only cash/);
    expect(tally(80, [{ kind: "Stored Value", amount: 100 }]).problem).toMatch(/Only cash/); // a card gives no change (settle_sale)
    expect(tally(80, [{ kind: "Stored Value", amount: 30 }, cash(50)])).toMatchObject({ change: 0, left: 0, problem: null });
    expect(tally(80, [card(60), cash(50)])).toMatchObject({ change: 30, problem: null });
    // A tender of nothing, or a negative one, does not count.
    expect(tally(10, [cash(-5), cash(0), cash(10)])).toMatchObject({ tendered: 10, left: 0 });
  });

  it("works in currencies with other places", () => {
    expect(tally(1.234, [cash(1.5)], 0, 3)).toMatchObject({ change: 0.266 });
    expect(tally(150, [cash(200)], 0, 0)).toMatchObject({ change: 50 });
    expect(stillDue(100, [cash(30.4)])).toBe(69.6);
    expect(stillDue(100, [cash(130)])).toBe(0);
  });

  it("values loyalty points like the server and never offers more than they are worth", () => {
    expect([pointsValue(4, 0.5), pointsValue(3, 0.333), pointsValue(1, 0.005)]).toEqual([2, 1, 0.01]);
    // 9.99 to pay at half a unit a point: 19 points (9.50), never 20 (10.00).
    expect([pointsFor(9.99, 120, 0.5), pointsFor(9.99, 7, 0.5), pointsFor(0, 50, 0.5), pointsFor(5, 50, 0)]).toEqual([19, 7, 0, 0]);
    expect(pointsFor(1, 10, 0.333)).toBe(3);
  });

  it("counts the points a customer can use now", () => {
    const entries = [
      { points: 11, remaining: 11, expiry_date: "2027-01-01" },
      { points: 10, remaining: 6, expiry_date: "2026-10-01" },
      { points: -4, remaining: 0, expiry_date: null },
    ];
    expect(pointsAvailable(entries, "2026-11-01")).toBe(11 + 10 - 6 - 4);
    expect(pointsAvailable([], "2026-11-01")).toBe(0);
  });
});

describe("what each way of paying came to", () => {
  it("hands the change back out of the last cash tender, and takes the rest of the bill from the others", () => {
    expect(perTender(70, [{ kind: "Bank", amount: 20 }, { kind: "Cash", amount: 100 }])).toEqual([
      { tendered: 20, taken: 20, change: 0 },
      { tendered: 100, taken: 50, change: 50 },
    ]);
    expect(perTender(70, [{ kind: "Cash", amount: 40 }, { kind: "Cash", amount: 40 }]).map((r) => r.change)).toEqual([0, 10]);
    expect(perTender(70, [{ kind: "Bank", amount: 70 }])).toEqual([{ tendered: 70, taken: 70, change: 0 }]);
  });

  it("says what is left on a card, never below nothing", () => {
    expect(leftOnCard(500, 110)).toBe(390);
    expect(leftOnCard(50, 50)).toBe(0);
    expect(leftOnCard(0.3, 0.1)).toBe(0.2);
  });
});
