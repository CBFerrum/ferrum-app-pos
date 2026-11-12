import { beforeEach, describe, expect, it, vi } from "vitest";

// The answers below are the ones a walk against a running server recorded (gapwalk a4, "Shapes for the
// till"), trimmed to what the till reads; the requests are what that walk sent.
const sent = vi.hoisted(() => ({ calls: [] as { path: string; o: Record<string, unknown> }[], answer: undefined as unknown }));
vi.mock("./offline", () => ({
  till: async (path: string, o: Record<string, unknown> = {}) => {
    sent.calls.push({ path, o });
    return sent.answer;
  },
}));

import { approvalProblem } from "./approval";
import { parseLimits } from "./rights";
import { approve, cardBalance, exchange, madeCode, setPin, voidSale } from "./server";
import { cardProblem } from "./stored";
import { makeCode } from "../Card";

const last = () => sent.calls[sent.calls.length - 1];
const answer = (a: unknown) => (sent.answer = a);

beforeEach(() => {
  sent.calls.length = 0;
});

describe("what the server was seen to take and answer", () => {
  it("approves one act on one sale: the body the walk sent, the approval read from the answer", async () => {
    answer({ action: "Discount", approval: "01a1ce9d-bb9e-74e2-ac87-4a219f4742cf", approver: "manager@walk.test" });
    const ask = { profile: "reg1", approver: "manager@walk.test", pin: "4321", action: "Discount" as const, amount: "20", reason: "regular customer", sale: "sale-1" };
    expect((await approve(ask)).approval).toBe("01a1ce9d-bb9e-74e2-ac87-4a219f4742cf");
    expect(last()).toEqual({ path: "/api/app/pos/approve", o: { method: "POST", body: ask } });
  });

  it("sets a PIN with just the PIN", async () => {
    answer({ ok: true });
    expect((await setPin("4321")).ok).toBe(true);
    expect(last()).toEqual({ path: "/api/app/pos/pin", o: { method: "POST", body: { pin: "4321" } } });
  });

  it("reads a card's balance from the recorded answer, leaving the PIN out when there is none", async () => {
    const recorded = { account: "01a1ce9d-c1c3-7745-8241-97d572a59fa4", balance: "500", expires_on: null, holds: "Money", repeated: false, state: "Active" };
    answer(recorded);
    const card = await cardBalance("gift-mode", "TILL-0001");
    expect(last()).toEqual({ path: "/api/app/pos/balance", o: { method: "POST", body: { mode: "gift-mode", code: "TILL-0001" } } });
    expect(cardProblem(card, 110, "2026-11-12")).toBeNull();
    expect(cardProblem(card, 600, "2026-11-12")).toBe("The card holds 500.");
    await cardBalance("gift-mode", "TILL-0001", "1234");
    expect(last().o.body).toEqual({ mode: "gift-mode", code: "TILL-0001", pin: "1234" });
  });

  it("makes a code through the kind's prove, and reads it from the recorded answer", async () => {
    answer({ proof: "f".repeat(64), code: "40J8-AK2C-8D46-E80M", expires_in_minutes: 5 });
    expect((await madeCode("kind-1")).code).toBe("40J8-AK2C-8D46-E80M");
    expect(last()).toEqual({ path: "/api/v1/StoredValueKind/kind-1/actions/prove", o: { method: "POST", body: { operation: "issue" } } });
    expect(await makeCode("kind-1")).toBe("40J8-AK2C-8D46-E80M");
    // Asked about a code of its own, the server makes none: that is not a card.
    answer({ proof: "f".repeat(64), code: null, expires_in_minutes: 5 });
    await expect(makeCode("kind-1")).rejects.toThrow("The server made no code.");
  });

  it("voids a sale with a reason, and an approval only when there is one", async () => {
    answer({ status: "Cancelled" });
    await voidSale("sale-1", "reason-1", "approval-1");
    expect(last()).toEqual({ path: "/api/v1/PosInvoice/sale-1/actions/void", o: { method: "POST", body: { reason: "reason-1", approval: "approval-1" } } });
    await voidSale("sale-1", "reason-1");
    expect(last().o.body).toEqual({ reason: "reason-1" });
  });

  it("sends an exchange as the walk did, and finds the new sale in the answer", async () => {
    const sale = { id: "sale-2", number: "POS-2", status: "Paid", rounded_total: "220", total_taxes: "20", exchange: "ret-1", items: [], payments: [{ mode_of_payment: "cash", amount: "110" }] };
    answer({ carried: "110", due: "110", refund: "0", return: { id: "ret-1", rounded_total: "-110", exchange: "sale-2" }, sale });
    const back = { pos_profile: "reg1", return_against: "bought", items: [{ item: "widget", qty: "-1" }], payments: [] };
    const out = { pos_profile: "reg1", items: [{ item: "widget", qty: "2" }], payments: [{ mode_of_payment: "cash", amount: "110" }] };
    const done = await exchange(back, out, "key-1");
    expect(last()).toEqual({ path: "/api/app/pos/exchange", o: { method: "POST", body: { back, out }, idempotencyKey: "key-1" } });
    expect([done.sale.id, done.sale.rounded_total, done.carried, done.due, done.refund]).toEqual(["sale-2", "220", "110", "110", "0"]);
  });
});

describe("what the server was seen to refuse, in the cashier's words", () => {
  it("knows its own words for a wrong PIN, a lockout and a person whose limits do not reach", () => {
    expect(approvalProblem({ status: 422, message: "that person's PIN does not match" }, "m@x.test")).toBe("That PIN does not match. Check it and try again.");
    expect(approvalProblem({ status: 429, message: "too many wrong PINs for m@x.test: try again in 15 minutes" }, "m@x.test")).toMatch(/locked for 15 minutes/);
    expect(approvalProblem({ status: 403, message: "m@x.test may not approve this either" }, "m@x.test")).toMatch(/may not approve this either/);
    expect(approvalProblem({ status: 422, message: "approver: someone else approves what is beyond your own limits" }, "me@x.test")).toMatch(/someone else approves/);
  });

  it("reads the limits the server answered for a cashier", () => {
    const recorded = { change_price: false, discount_amount: "30", discount_percent: "5", open_drawer: false, refund: "50", reprint: true, return_without_receipt: false, void_line: true, void_sale: false };
    expect(parseLimits(recorded)).toEqual({ change_price: false, discount_amount: 30, discount_percent: 5, open_drawer: false, refund: 50, reprint: true, return_without_receipt: false, void_line: true, void_sale: false });
  });
});
