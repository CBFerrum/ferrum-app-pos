import { describe, expect, it } from "vitest";
import { addItem, balance, flushOutbox, invoiceBody, isTransient, loadOutbox, paymentRows, quickCash, receiptHtml, saveOutbox, setQty, type QueuedSale } from "./pos";

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

describe("tenders", () => {
  it("works out change and likely notes", () => {
    expect(balance(472.5, 500)).toBe(-27.5);
    expect(balance(0.3, 0.1 + 0.2)).toBe(0);
    expect(quickCash(472.5)).toEqual([472.5, 480, 500, 2000]);
    expect(quickCash(0)).toEqual([]);
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
  it("prints the sale with every value escaped", () => {
    const html = receiptHtml(
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
