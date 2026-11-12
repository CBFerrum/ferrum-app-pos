import { describe, expect, it } from "vitest";
import { cashCounted, closingBody, countsOf, denominations, difference, reasonOf, remarksOf, standing, typedAmount, fallbackShiftHtml, type Report } from "./shift";

describe("counting the drawer", () => {
  it("adds notes and coins, and anything odd, exactly", () => {
    expect(cashCounted({ "500": 3, "100": 7, "0.5": 5 })).toBe(2202.5);
    expect(cashCounted({ "0.1": 3, "0.05": 1 })).toBe(0.35);
    expect(cashCounted({ "20": 2 }, 3.5)).toBe(43.5);
    expect(cashCounted({}, 0)).toBe(0);
    // A count that is not a whole, positive number is not a count.
    expect(cashCounted({ "100": -2, "50": 1.9, "10": Number.NaN })).toBe(50);
    expect(cashCounted({ "0.001": 5 }, 0, 3)).toBe(0.005);
  });

  it("knows the notes of the common currencies and has a way for the rest", () => {
    expect(denominations("inr").notes[0]).toBe(2000);
    expect(denominations("EUR").coins).toContain(0.02);
    expect(denominations("XYZ").notes.length).toBeGreaterThan(3);
    expect(denominations(null).quick).toEqual(denominations("???").quick);
    for (const c of ["INR", "USD", "EUR", "GBP", "AED", "SAR", "none"]) {
      const d = denominations(c);
      // A value is a note or a coin, never both, so a count has one row for it.
      expect(d.notes.filter((n) => d.coins.includes(n))).toEqual([]);
    }
  });

  it("measures the difference against what is expected", () => {
    expect([difference(774.45, 772.45), difference(100, 100), difference(100, 101.5), difference(50, null)]).toEqual([-2, 0, 1.5, 0]);
    expect([standing(-2), standing(0), standing(0.01)]).toEqual(["short", "right", "over"]);
    expect([typedAmount(""), typedAmount("  "), typedAmount("1250.5"), typedAmount("1,250.5"), typedAmount("-3"), typedAmount("abc"), typedAmount("0"), typedAmount(undefined)]).toEqual([null, null, 1250.5, null, null, null, 0, null]);
  });
});

describe("the closing", () => {
  it("sends the notes counted for the drawer, a total for the rest, and what was said", () => {
    const body = closingBody({
      session: "s1",
      drawer: "cash",
      counts: { "500": 1, "100": 2, "50": 0, "0.05": 9 },
      other: 2,
      typed: [{ mode: "card", amount: 199 }, { mode: "upi", amount: null }],
      remarks: "  Cash short by 2.00  ",
    });
    expect(body).toEqual({
      pos_opening_entry: "s1",
      payments: [{ mode_of_payment: "card", closing_amount: "199" }],
      denominations: [
        { mode_of_payment: "cash", denomination: "500", count: 1 },
        { mode_of_payment: "cash", denomination: "100", count: 2 },
        { mode_of_payment: "cash", denomination: "0.05", count: 9 },
        { mode_of_payment: "cash", denomination: "2", count: 1 },
      ],
      remarks: "Cash short by 2.00",
    });
    expect(closingBody({ session: "s1", drawer: null, counts: {}, other: 0, typed: [], remarks: "" })).toEqual({ pos_opening_entry: "s1", payments: [], denominations: [], remarks: null });
  });

  it("shows a saved count on the page again", () => {
    const back = countsOf(
      [{ denomination: "500", count: 1 }, { denomination: "0.05", count: 9 }, { denomination: "2", count: 1 }, { denomination: "7", count: 2 }],
      [500, 100, 0.05],
    );
    expect(back).toEqual({ counts: { "500": 1, "0.05": 9 }, other: 16 });
  });

  it("words the differences for the remarks, and reads the reason back", () => {
    const rows = [{ name: "Cash", difference: -2 }, { name: "Card", difference: 0 }, { name: "UPI", difference: 1.5 }];
    const remarks = remarksOf(rows, " Gave change twice ");
    expect(remarks).toBe("Cash short by 2.00; UPI over by 1.50.\nGave change twice");
    expect(reasonOf(remarks)).toBe("Gave change twice");
    expect(remarksOf(rows.slice(1, 2), "")).toBe("");
    expect(remarksOf([], "Counted twice")).toBe("Counted twice");
    expect(remarksOf(rows.slice(0, 1), "")).toBe("Cash short by 2.00.");
    // Remarks written by hand are all reason.
    expect([reasonOf("Float topped up"), reasonOf(""), reasonOf(null), reasonOf("Cash short by 2.00.")]).toEqual(["Float topped up", "", "", ""]);
  });
});

describe("the Z report", () => {
  const report: Report = {
    rows: [{ session: "POS-OPEN-1", cashier: "asha@shop.test", mode_of_payment: "Cash <b>", payments: 4, amount: "774.45" }],
    totals: { amount: "774.45" },
    meta: {
      sales: 8,
      returns: 1,
      net_total: "700.00",
      total_taxes: "70.00",
      grand_total: "770.00",
      session: {
        number: "POS-OPEN-1",
        cashier: "asha@shop.test",
        status: "Closed",
        opened_at: "2026-11-01T04:00:00Z",
        closed_at: "2026-11-01T12:00:00Z",
        report: "Z",
        reconciliation: [{ mode: "cash", mode_of_payment: "Cash", opening: "500", expected: "774.45", counted: "772.45", difference: "-2" }],
      },
    },
  };

  it("prints what was sold, taken and counted, with everything escaped", () => {
    const html = fallbackShiftHtml({ profile_name: "Front <Counter>", print_format: "Thermal 80mm" }, report, "Cash short by 2.00");
    expect(html).toContain("Z REPORT");
    expect(html).toContain("Front &#60;Counter&#62;");
    expect(html).toContain("Cash &#60;b&#62;");
    expect(html).not.toContain("<b>Cash");
    expect(html).toMatch(/Total<\/b><\/td><td class="r"><b>770\.00/);
    expect(html).toMatch(/short<\/small><\/td><td class="r">-2\.00/);
    expect(html).toContain("Cash short by 2.00");
  });

  it("leaves out what a blind register expected until that method is counted", () => {
    const blind = { ...report, meta: { ...report.meta, session: { ...report.meta.session!, reconciliation: [{ ...report.meta.session!.reconciliation[0], expected: "777.00", counted: null }] } } };
    expect(fallbackShiftHtml({ profile_name: "Counter" }, blind, null, true)).not.toContain("777.00");
    expect(fallbackShiftHtml({ profile_name: "Counter" }, blind, null, false)).toContain("777.00");
    expect(fallbackShiftHtml({ profile_name: "Counter" }, blind)).toContain("not the register&#39;s report");
  });

  it("is an X report while the shift is open and leaves out a count that was not made", () => {
    const open = { ...report, meta: { ...report.meta, session: { ...report.meta.session!, report: "X" as const, closed_at: null, reconciliation: [{ ...report.meta.session!.reconciliation[0], counted: null }] } } };
    const html = fallbackShiftHtml({ profile_name: "Counter" }, open);
    expect(html).toContain("X REPORT");
    expect(html).not.toContain("counted");
    expect(html).not.toContain("Closed");
  });
});
