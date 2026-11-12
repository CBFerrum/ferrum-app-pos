import { describe, expect, it } from "vitest";
import type { Doc } from "@ferrum/records";
import { addItem, adjustLine, balance, carriesCard, flushOutbox, invoiceBody, isTransient, keptReceipt, loadOutbox, parseScan, paymentRows, offlineSale, quickCash, fallbackReceiptHtml, saveOutbox, setQty, withMethodNames, type QueuedSale } from "./pos";

const tea = { id: "i-tea", name: "Tea" };
const cake = { id: "i-cake", name: "Cake" };

describe("cart", () => {
  it("merges scans of the same item and removes lines at zero", () => {
    let lines = addItem([], tea);
    lines = addItem(lines, cake, 2);
    lines = addItem(lines, tea, 12); // a box barcode adds twelve
    expect(lines.map((l) => [l.item_name, l.qty])).toEqual([
      ["Tea", 13],
      ["Cake", 2],
    ]);
    expect(setQty(lines, "i-cake", 0).map((l) => l.item)).toEqual(["i-tea"]);
    expect(setQty(lines, "i-tea", 0.1 + 0.2)[0].qty).toBe(0.3);
  });

  it("builds the invoice body with only real tenders", () => {
    const body = invoiceBody({
      profile: "p",
      session: "s",
      customer: null,
      lines: addItem([], tea, 2),
      tenders: [
        { mode_of_payment: "cash", amount: "500" },
        { mode_of_payment: "card", amount: "" },
      ],
    });
    expect(body).toEqual({ pos_profile: "p", pos_opening_entry: "s", customer: null, items: [{ item: "i-tea", qty: "2" }], payments: [{ mode_of_payment: "cash", amount: "500" }] });
    expect(paymentRows([{ mode_of_payment: "x", amount: "-5" }])).toEqual([]);
  });
});

describe("the cashier's adjustments", () => {
  it("keeps what was typed on a line, and takes it off when it is emptied", () => {
    let lines = addItem([], tea, 2);
    lines = adjustLine(lines, "i-tea", { discount: "5", note: "Gift: wrap it" });
    lines = adjustLine(lines, "i-tea", { price: "18.50" });
    expect(lines[0]).toMatchObject({ discount: "5", price: "18.50", note: "Gift: wrap it" });
    lines = adjustLine(lines, "i-tea", { discount: "  ", price: "" });
    expect(Object.keys(lines[0]).sort()).toEqual(["item", "item_name", "key", "note", "qty"]);
    expect(adjustLine(lines, "elsewhere", { note: "x" })).toEqual(lines);
    expect(addItem(adjustLine(lines, "i-tea", { discount: "5" }), tea)[0]).toMatchObject({ qty: 3, discount: "5" });
  });

  it("sends them on the sale's line, with the sale's own id", () => {
    const lines = adjustLine(adjustLine(addItem([], tea, 2), "i-tea", { discount: "5", price: "18.5" }), "i-tea", { note: "Gift" });
    const body = invoiceBody({ id: "sale-1", profile: "p", session: "s", customer: "c", lines, tenders: [] });
    expect(body).toEqual({
      id: "sale-1",
      pos_profile: "p",
      pos_opening_entry: "s",
      customer: "c",
      items: [{ item: "i-tea", qty: "2", discount_percent: "5", manual_rate: "18.5", note: "Gift" }],
      payments: [],
    });
    expect("id" in invoiceBody({ profile: "p", session: "s", customer: null, lines, tenders: [] })).toBe(false);
  });

  it("reads a quantity before a code in the scan box", () => {
    expect([parseScan("8901234"), parseScan("3*8901234"), parseScan(" 12 × CASE6 "), parseScan("0.5*LOOSE")]).toEqual([
      { qty: 1, code: "8901234" },
      { qty: 3, code: "8901234" },
      { qty: 12, code: "CASE6" },
      { qty: 0.5, code: "LOOSE" },
    ]);
    // Not a quantity: nothing before the star, a zero, or nothing after it.
    expect([parseScan("*8901"), parseScan("0*8901"), parseScan("3*"), parseScan("ab*3")].map((s) => s.qty)).toEqual([1, 1, 1, 1]);
    expect(parseScan("  CAKE ").code).toBe("CAKE");
  });
});

describe("tenders", () => {
  it("works out change and likely notes", () => {
    expect(balance(472.5, 500)).toBe(-27.5);
    expect(balance(0.3, 0.1 + 0.2)).toBe(0);
    expect(quickCash(472.5)).toEqual([472.5, 480, 500, 2000]);
    expect(quickCash(0)).toEqual([]);
    // Notes of another currency step differently.
    expect(quickCash(17.35, [1, 5, 10, 20, 50, 100])).toEqual([17.35, 18, 20, 50]);
  });

  it("sends references and redeemed points, not amounts the server works out itself", () => {
    expect(
      paymentRows([
        { mode_of_payment: "card", amount: "100", reference_no: "  AUTH 1 " },
        { mode_of_payment: "cash", amount: "50", reference_no: "" },
        { mode_of_payment: "points", amount: "0", loyalty_points: 40 },
        { mode_of_payment: "upi", amount: "0" },
      ]),
    ).toEqual([
      { mode_of_payment: "card", amount: "100", reference_no: "AUTH 1" },
      { mode_of_payment: "cash", amount: "50" },
      { mode_of_payment: "points", loyalty_points: 40 },
    ]);
  });
});

describe("outbox", () => {
  const sale = (key: string): QueuedSale => ({ key, body: { pos_profile: "p" }, at: "2026-10-29T10:00:00Z" });

  it("survives storage that is empty, corrupt or blocked", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(loadOutbox(storage)).toEqual([]);
    saveOutbox([sale("a")], storage);
    expect(loadOutbox(storage).map((s) => s.key)).toEqual(["a"]);
    mem.set("ferrum.pos.outbox", "{not json");
    expect(loadOutbox(storage)).toEqual([]);
    expect(() => saveOutbox([sale("b")], { setItem: () => { throw new Error("quota"); } })).not.toThrow();
  });

  it("says when the device could not keep the queue", () => {
    expect(saveOutbox([sale("a")], { setItem: () => undefined })).toBe(true);
    expect(saveOutbox([sale("a")], { setItem: () => { throw new Error("quota"); } })).toBe(false);
    expect(saveOutbox([sale("a")], undefined)).toBe(false);
  });

  it("lets a sale go that an earlier try already got through", async () => {
    const refused = Object.assign(new Error("already exists"), { status: 409 });
    const left = await flushOutbox([sale("a"), sale("b")], async () => {
      throw refused;
    }, async (s) => s.key === "a");
    expect(left.map((s) => [s.key, s.error])).toEqual([["b", "already exists"]]);
    // Asking is only for refusals: a lost connection never reaches it.
    let asked = 0;
    await flushOutbox([sale("c")], async () => { throw new TypeError("offline"); }, async () => (asked++, true));
    expect(asked).toBe(0);
  });

  it("sends in order, stops when offline and keeps refusals for a person", async () => {
    const sent: string[] = [];
    const left = await flushOutbox([sale("a"), sale("b"), sale("c")], async (s) => {
      if (s.key === "b") throw Object.assign(new Error("Customer is required"), { status: 422 });
      sent.push(s.key);
    });
    expect(sent).toEqual(["a", "c"]);
    expect(left.map((s) => [s.key, s.error])).toEqual([["b", "Customer is required"]]);

    const offline = await flushOutbox([sale("x"), sale("y")], async () => {
      throw Object.assign(new Error("offline"), { status: 0 });
    });
    expect(offline.map((s) => [s.key, s.error])).toEqual([
      ["x", undefined],
      ["y", undefined],
    ]);
    expect([isTransient({ status: 503 }), isTransient({ status: 409 }), isTransient(new TypeError("fetch")), isTransient({ status: 401 })]).toEqual([true, false, true, true]);
  });
});

describe("receipt", () => {
  it("names the payment methods a saved sale does not", () => {
    const profile = { payments: [{ mode_of_payment: "m1", _titles: { mode_of_payment: "Cash" } }] };
    const named = withMethodNames(profile, { payments: [{ mode_of_payment: "m1", amount: "5" }, { mode_of_payment: "gone", amount: "1" }] });
    expect((named.payments as { _titles: { mode_of_payment: string } }[]).map((p) => p._titles.mode_of_payment)).toEqual(["Cash", ""]);
  });

  it("keeps the goods on the receipt of a sale that waits on the device", () => {
    const profile = { profile_name: "Counter", payments: [{ mode_of_payment: "m1", _titles: { mode_of_payment: "Cash" } }] };
    const priced = { items: [{ item: "i1", item_name: "Masala tea", qty: "3", rate: "20.00", amount: "60.00" }], total: "60.00", total_taxes: "3.00", grand_total: "63.00" };
    const sale = { items: [{ item: "i1", qty: "3" }], payments: [{ mode_of_payment: "m1", amount: "100" }], posting_date: "2026-11-01" };
    const doc = keptReceipt(profile, priced, sale, { customer: "Asha Rao", due: 63, change: 37 });
    expect(doc).toMatchObject({ number: "Not sent yet", pending: true, customer_name: "Asha Rao", rounded_total: "63", change_amount: "37", posting_date: "2026-11-01" });
    const html = fallbackReceiptHtml(profile, doc);
    for (const text of ["Masala tea", "3 × 20.00", "60.00", "Cash", "100.00", "Change", "37.00", "Not sent yet"]) expect(html).toContain(text);
    // Nothing priced yet: the sale is still kept, without lines to print.
    expect(keptReceipt(profile, null, sale, { due: 0, change: 0 })).toMatchObject({ pending: true });
  });

  it("prints a line's note, the rounding, and what a return is of", () => {
    const html = fallbackReceiptHtml(
      { profile_name: "Counter" },
      {
        number: "C1-9",
        posting_date: "2026-11-01",
        is_return: true,
        against: "C1-3",
        items: [{ item_name: "Tea", qty: "-1", rate: "10", amount: "-10", note: "<b>Gift</b>" }],
        payments: [],
        total: "-10",
        total_taxes: "0",
        rounding_adjustment: "-0.01",
        rounded_total: "-10.05",
      },
    );
    expect(html).toContain("<b>RETURN</b> of C1-3");
    expect(html).toContain("&#60;b&#62;Gift");
    expect(html).toMatch(/Rounding<\/td><td class="r">-0\.01/);
  });

  it("prints the sale with every value escaped", () => {
    const html = fallbackReceiptHtml(
      { profile_name: "Front <Counter>", print_format: "Thermal 58mm", receipt_footer: "Thanks!" },
      {
        number: "FC-1",
        posting_date: "2026-10-29",
        items: [{ item_name: '<img src=x onerror="alert(1)">', qty: "2", rate: "10", amount: "20" }],
        payments: [{ mode_of_payment: "m", _titles: { mode_of_payment: "Cash" }, amount: "50" }],
        total: "20",
        total_taxes: "0",
        rounded_total: "20",
        change_amount: "30",
      },
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&#60;img src=x");
    expect(html).toContain("Front &#60;Counter&#62;");
    expect(html).toContain("width:48mm");
    expect(html).toMatch(/Change<\/td><td class="r">30\.00/);
    expect(html).toContain("Cash");
  });
});

describe("what a sale carries beyond its lines", () => {
  const lines = [{ key: "gift", item: "i-card", item_name: "Gift card", qty: 1 }];
  const base = { id: "sale-1", profile: "p", session: "s", customer: "c", lines };

  it("names the approvals it uses, the lines taken off with why, and the invoice at once", () => {
    const body = invoiceBody({
      ...base,
      tenders: [],
      approvals: ["a1"],
      voided: [{ item: "i-tea", item_name: "Tea", qty: 2, amount: "40.00", reason: "r1" }],
      invoiceNow: true,
    });
    expect(body).toMatchObject({ approvals: [{ approval: "a1" }], voided_lines: [{ item: "i-tea", qty: "2", amount: "40.00", reason: "r1" }], invoice_now: true });
    const plain = invoiceBody({ ...base, tenders: [] });
    for (const k of ["approvals", "voided_lines", "invoice_now"]) expect(k in plain).toBe(false);
  });

  it("puts a card's code and PIN only on the line or tender they belong to, and knows a body that has them", () => {
    const body = invoiceBody({ ...base, tenders: [{ mode_of_payment: "gift", amount: "30", stored_value_code: " 7KQ2-M9XD ", stored_value_pin: "1234" }], cards: { gift: { code: "NEW-CARD-0001" } } });
    expect((body.items as Doc[])[0]).toMatchObject({ stored_value_code: "NEW-CARD-0001" });
    expect((body.payments as Doc[])[0]).toMatchObject({ stored_value_code: "7KQ2-M9XD", stored_value_pin: "1234" });
    expect(carriesCard(body)).toBe(true);
    expect(carriesCard(invoiceBody({ ...base, tenders: [{ mode_of_payment: "cash", amount: "30" }] }))).toBe(false);
  });
});

describe("what a sale carries for the register to settle", () => {
  const base = { profile: "p1", session: "s1", customer: null, lines: [{ key: "k", item: "i-tea", item_name: "Tea", qty: 1 }], tenders: [] };

  it("names a buyer's registration and name, and the promotion codes, only when they were given", () => {
    expect(invoiceBody(base)).not.toHaveProperty("buyer_tax_id");
    expect(invoiceBody(base)).not.toHaveProperty("promotion_codes");
    expect(invoiceBody({ ...base, buyer: { taxId: " TL-4242 ", name: "  Acme " }, codes: ["TEA5", "WELCOME"] })).toMatchObject({ buyer_tax_id: "TL-4242", buyer_name: "Acme", promotion_codes: "TEA5 WELCOME" });
    expect(invoiceBody({ ...base, buyer: { taxId: "TL-4242" } })).not.toHaveProperty("buyer_name");
    expect(invoiceBody({ ...base, buyer: { taxId: "  " } })).not.toHaveProperty("buyer_tax_id");
  });

  it("marks an unsent sale as sold offline with its total, and the snapshot only when this device priced it", () => {
    expect(offlineSale({ id: "x" }, { total: 139, snapshot: "v1" })).toEqual({ id: "x", sold_offline: true, till_total: "139", price_snapshot: "v1" });
    expect(offlineSale({ id: "x" }, { total: "139.00" })).toEqual({ id: "x", sold_offline: true, till_total: "139.00" });
  });

  it("says on its face that the till's own receipt is not the register's", () => {
    expect(fallbackReceiptHtml({ profile_name: "Counter" }, { number: "N", items: [], payments: [] })).toContain("Printed on this device: not the register&#39;s receipt");
  });
});
