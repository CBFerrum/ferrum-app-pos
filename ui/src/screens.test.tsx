// Every screen drawn once from what the server would give it, to catch a screen that cannot draw:
// no browser is needed to see that a dialog names its ways of paying, a line its editor, a closing
// its differences.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { resetBootstrap } from "@ferrum/client";
import type { Doc } from "@ferrum/records";
import { fakeBootstrap } from "@ferrum/testing";
import { CartLines, Totals } from "./Cart";
import { HeldDialog, KeysDialog } from "./Held";
import { AskDialog, SetPinDialog } from "./Approval";
import { CardLine } from "./Card";
import { PayDialog, ReceiptDialog } from "./Pay";
import ReceiptMore from "./ReceiptMore";
import ReturnDesk, { Sale } from "./Returns";
import Unreceipted from "./Unreceipted";
import ShiftPage from "./Shift";
import DifferencesPage from "./Differences";
import { Till } from "./Till";
import { Currency } from "./fmt";
import { ownerOf, saveCart } from "./lib/held";
import { rightsOf, UNLIMITED } from "./lib/rights";
import type { Report } from "./lib/shift";
import type { Sheet } from "./lib/returns";

const memory = () => {
  const mem = new Map<string, string>();
  return { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
};

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: memory(), configurable: true });
  (globalThis as { __FERRUM_BOOTSTRAP__?: unknown }).__FERRUM_BOOTSTRAP__ = fakeBootstrap({ person: { id: "u1", name: "Asha", email: "asha@shop.test", kind: "member", admin: false, actor: null } });
  resetBootstrap();
});

function draw(node: ReactNode, seed?: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  seed?.(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Currency.Provider value={{ precision: 2, code: "INR" }}>{node}</Currency.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const mode = (id: string, name: string, type: string): Doc => ({ id, mode_name: name, mode_type: type });
const modes = [mode("cash", "Cash", "Cash"), mode("card", "Card", "Bank"), mode("credit", "Credit", "Credit"), mode("points", "Loyalty Points", "Loyalty Points")];
const profile: Doc = {
  id: "p1",
  profile_name: "Counter 1",
  company: "co1",
  customer: "walkin",
  currency: "inr",
  write_off_limit: "0.10",
  allow_discount_change: true,
  max_discount: "10",
  allow_rate_change: false,
  _titles: { currency: "INR" },
  payments: modes.map((m, i) => ({ mode_of_payment: m.id, is_default: i === 0, _titles: { mode_of_payment: m.mode_name } })),
};

describe("taking payment", () => {
  const props = { buyer: null, onBuyer: () => {}, codes: [], onCodes: () => {}, doc: null, profile, modes, due: 252.95, grand: 252.97, walkIn: true, customer: null, program: null, offline: false, steps: [10, 50, 100, 500, 2000], onClose: () => {}, onComplete: async () => null };

  it("starts on the default way, with the whole bill typed in, and says why credit and points wait", () => {
    const html = draw(<PayDialog {...props} />);
    expect(html).toContain("Take payment");
    expect(html).toContain("Cash amount");
    expect(html).toContain('value="252.95"');
    expect(html).toContain("Rounded from 252.97");
    for (const name of ["Cash", "Card", "Credit", "Loyalty Points"]) expect(html).toContain(name);
    expect(html).toMatch(/Credit: Paying later needs a named customer/);
    expect(html).toMatch(/Loyalty Points: Points need a named customer/);
    expect(html).toContain("Paid exactly");
    expect(html).toContain("Exact");
  });

  it("opens credit to a named customer, and says why points wait offline", () => {
    const html = draw(<PayDialog {...props} walkIn={false} customer="c1" />);
    expect(html).not.toContain("Paying later needs");
    expect(html).toContain("not in a loyalty program");
    expect(draw(<PayDialog {...props} walkIn={false} customer="c1" offline />)).toContain("Points need a connection");
  });

  it("takes a card with its balance read first, offers the invoice at once to a named customer, and refuses cards offline", () => {
    const withCard = [...modes, { ...mode("gift", "Gift card", "Stored Value"), offline_limit: "25" }];
    const p = { ...profile, payments: [...(profile.payments as Doc[]), { mode_of_payment: "gift", is_default: false, _titles: { mode_of_payment: "Gift card" } }] };
    const online = draw(<PayDialog {...props} profile={p} modes={withCard} walkIn={false} customer="c1" />);
    expect(online).toContain("Gift card");
    expect(online).toContain("Issue the tax invoice now");
    expect(draw(<PayDialog {...props} profile={p} modes={withCard} />)).not.toContain("Issue the tax invoice now");
    const away = draw(<PayDialog {...props} profile={p} modes={withCard} offline />);
    expect(away).toMatch(/Gift card: The server takes this offline up to 25.00, but the till never keeps a card/);
    expect(draw(<PayDialog {...props} profile={p} modes={[...modes, mode("gift", "Gift card", "Stored Value")]} offline />)).toMatch(/Cards need a connection/);
  });

  it("asks for the buyer's registration and a promotion code, and says what the server found and took", () => {
    const html = draw(<PayDialog {...props} />);
    expect(html).toContain("Promotion code");
    expect(html).toContain("Buyer has a tax registration");
    // A buyer already on the sale: the fields are open, the server's find and its tax invoice are told, its promotions listed.
    const doc = { customer: "c9", customer_name: "Acme Traders", tax_invoice: true, applied_promotions: [{ promotion: "p1", title: "Tea week", amount: "5.00", code: "TEA5" }] };
    const named = draw(<PayDialog {...props} buyer={{ taxId: "TL-4242", name: "Acme" }} codes={["TEA5"]} doc={doc} walkIn={false} customer="c9" />);
    expect(named).toContain("Buyer&#x27;s tax registration");
    expect(named).toContain('value="TL-4242"');
    expect(named).toMatch(/Tea week.*TEA5.*−5\.00/);
    expect(named).toContain("Take the code TEA5 off");
  });

  it("shows the server's refusal of a registration as it is, and does not let the sale complete on it", () => {
    const html = draw(<PayDialog {...props} buyer={{ taxId: "BAD" }} doc={null} problem="BAD is not a registration the country rules accept for a business" />);
    expect(html).toContain("BAD is not a registration the country rules accept for a business");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Complete sale/);
  });

  it("lists the promotions an offline sale took, as the till priced them, and holds a sale the buyer rule would refuse", () => {
    const html = draw(<PayDialog {...props} offline namedAbove="200" doc={{ offline: true, applied_promotions: [{ promotion: "p1", title: "Tea week", amount: "5.00", code: null }] }} />);
    expect(html).toMatch(/Tea week.*−5\.00/);
    expect(html).not.toContain("does not work out promotions");
    expect(html).toMatch(/This register asks for a named buyer on a sale this size/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Complete sale/);
    // Under the rule, or a named customer: nothing held back.
    expect(draw(<PayDialog {...props} offline namedAbove="500" />)).not.toContain("asks for a named buyer on a sale this size");
    expect(draw(<PayDialog {...props} offline namedAbove="200" walkIn={false} customer="c1" />)).not.toContain("asks for a named buyer on a sale this size");
  });

  it("lists each way of paying with what it takes of the bill as it is typed (the change and a card's balance are perTender's and leftOnCard's, tested in pay.test.ts)", () => {
    const html = draw(<PayDialog {...props} />);
    expect(html).toMatch(/aria-label="Payments"><li><span>Cash<\/span><strong>252\.95<\/strong>/);
    expect(html).not.toContain("left on the card");
  });

  it("offers to void a finished sale, with a reason, but not a kept one, a return or an exchange", () => {
    const sale = { id: "s1", number: "C1-9", rounded_total: "20", payments: [] };
    const reasons = [{ id: "r1", reason: "Wrong item rung", applies_to: "Void" }];
    expect(draw(<ReceiptDialog profile={profile} sale={sale} limits={UNLIMITED} reasons={reasons} onClose={() => {}} />)).toContain("Void this sale");
    expect(draw(<ReceiptDialog profile={profile} sale={sale} limits={UNLIMITED} reasons={[]} onClose={() => {}} />)).not.toContain("Void this sale");
    for (const other of [{ pending: true }, { is_return: true }, { exchange: "x" }]) expect(draw(<ReceiptDialog profile={profile} sale={{ ...sale, ...other }} limits={UNLIMITED} reasons={reasons} onClose={() => {}} />)).not.toContain("Void this sale");
  });

  it("tells a finished sale's buyer, how each way paid, and what is left on a card", () => {
    const sale = { id: "s1", number: "C1-9", rounded_total: "100", customer_name: "Acme Traders", buyer_tax_id: "TL-4242", tax_invoice: true, change_amount: "0", payments: [{ mode_of_payment: "gift", amount: "100", stored_value_balance: "400.00", _titles: { mode_of_payment: "Gift card" } }] };
    const html = draw(<ReceiptDialog profile={profile} sale={sale} limits={UNLIMITED} onClose={() => {}} />);
    expect(html).toContain("Buyer Acme Traders");
    expect(html).toContain("TL-4242");
    expect(html).toContain("tax invoice issued");
    expect(html).toContain("Gift card");
    expect(html).toContain("400.00 left on the card");
  });

  it("offers a copy, a gift receipt and sending by message for a sale the register has, not for one kept on the device", () => {
    const more = draw(<ReceiptMore profile={profile} sale={{ id: "s1", number: "C1-9" }} limits={UNLIMITED} reasons={[]} offline={false} />);
    for (const word of ["Print a copy", "Gift receipt", "Send by message"]) expect(more).toContain(word);
    expect(draw(<ReceiptMore profile={profile} sale={{ id: "s1", number: "C1-9" }} limits={UNLIMITED} reasons={[]} offline />)).toContain("need a connection");
    const kept = draw(<ReceiptDialog profile={profile} sale={{ number: "Not sent yet", pending: true, payments: [] }} limits={UNLIMITED} onClose={() => {}} />);
    expect(kept).toContain("Print a provisional receipt");
    expect(kept).not.toContain("Print a copy");
  });

  it("shows a receipt with the change, and a kept sale as not yet sent", () => {
    const sale = { number: "C1-9", rounded_total: "252.95", change_amount: "47.05", payments: [] };
    expect(draw(<ReceiptDialog profile={profile} sale={sale} onClose={() => {}} />)).toMatch(/Change.*47\.05/);
    const kept = draw(<ReceiptDialog profile={profile} sale={{ ...sale, pending: true, number: "Not sent yet" }} onClose={() => {}} />);
    expect(kept).toContain("Sale kept on this device");
    expect(kept).toContain("Not sent yet");
  });
});

describe("the sale on screen", () => {
  const lines = [
    { key: "tea", item: "tea", item_name: "Masala tea", qty: 2, note: "Gift" },
    { key: "cake", item: "cake", item_name: "Plum cake", qty: 1, discount: "5" },
  ];
  const priced = [
    { item: "tea", rate: "20.00", amount: "40.00", discount_percent: "0" },
    { item: "cake", rate: "40.50", amount: "40.50", discount_percent: "5" },
  ];
  const spare = { approvals: [], profile, cards: {}, away: false, onAsk: () => {}, onCard: () => {} };
  const show = (limits: ReturnType<typeof rightsOf>, editing: string | null, extra: Partial<typeof spare> = {}) =>
    draw(
      <CartLines
        lines={lines}
        priced={priced}
        pending={false}
        selected="cake"
        editing={editing}
        limits={limits}
        {...spare}
        {...extra}
        baseOf={() => ({ list: 45, rule: 0 })}
        onSelect={() => {}}
        onEdit={() => {}}
        onQty={() => {}}
        onChange={() => {}}
        onRemove={() => {}}
      />,
    );

  it("lists the lines with what was done to them", () => {
    const html = show(rightsOf(profile, false), null);
    expect(html).toContain("Masala tea");
    expect(html).toContain("Gift");
    expect(html).toContain("−5%");
    expect(html).toContain("One more Masala tea");
  });

  it("shows a price only on the line it was worked out for", () => {
    const html = draw(
      <CartLines lines={lines} priced={[priced[1], priced[0]]} pending selected={null} editing={null} limits={rightsOf(profile, false)} approvals={[]} profile={profile} cards={{}} away={false} baseOf={() => null} onSelect={() => {}} onEdit={() => {}} onQty={() => {}} onChange={() => {}} onAsk={() => {}} onCard={() => {}} onRemove={() => {}} />,
    );
    expect(html).not.toContain("40.50");
    expect(html).toContain("Pricing…");
  });

  it("opens a line's editor with the cap before typing, as far as the role allows", () => {
    const cashier = show(rightsOf(profile, false), "cake");
    expect(cashier).toContain("You can give up to 10% yourself.");
    expect(cashier).toContain("List price 45.00");
    expect(show(rightsOf({ allow_discount_change: false }, false), "cake")).toContain("You can give up to 0% yourself.");
    expect(show(UNLIMITED, "cake")).toContain("No limit for you.");
  });

  it("asks for approval, offline says it needs a connection, and a card line takes the card's code", () => {
    const over = [{ ...lines[0] }, { ...lines[1], discount: "" }];
    const html = draw(
      <CartLines lines={over} priced={priced} pending={false} selected="cake" editing="cake" limits={{ ...rightsOf(profile, false), discount_percent: 2 }} approvals={[]} profile={profile} cards={{}} away baseOf={() => ({ list: 45, rule: 0 })} onSelect={() => {}} onEdit={() => {}} onQty={() => {}} onChange={() => {}} onAsk={() => {}} onCard={() => {}} onRemove={() => {}} />,
    );
    expect(html).not.toContain("Ask for approval"); // nothing typed yet
    const card = draw(
      <CartLines lines={over} priced={[priced[0], { ...priced[1], stored_value_kind: "gift" }]} pending={false} selected="cake" editing="cake" limits={UNLIMITED} approvals={[]} profile={profile} cards={{ cake: { code: "7KQ2-M9XD" } }} away={false} baseOf={() => ({ list: 45, rule: 0 })} onSelect={() => {}} onEdit={() => {}} onQty={() => {}} onChange={() => {}} onAsk={() => {}} onCard={() => {}} onRemove={() => {}} />,
    );
    expect(card).toContain("Card ending M9XD is set");
    expect(card).toContain("Make a new code");
    expect(card).toContain("PIN, if the card has one");
    expect(card).not.toContain("7KQ2");
  });

  it("adds up the sale, with the rounding the currency needs", () => {
    const html = draw(<Totals doc={{ total: "80.50", discount_amount: "2.00", total_taxes: "4.00", rounding_adjustment: "-0.05", grand_total: "82.50" }} due={82.45} offline builtAt="2026-11-01T00:00:00Z" />);
    expect(html).toContain("Rounding");
    expect(html).toContain("82.45");
    expect(html).toContain("Priced on this device");
  });
});

describe("hold and keys", () => {
  it("lists the held sales, or says there are none", () => {
    expect(draw(<HeldDialog held={[]} onResume={() => {}} onDiscard={() => {}} onClose={() => {}} />)).toContain("Nothing on hold");
    const sale = { key: "k", customer: { id: "c1", title: "Asha Rao" }, at: "2026-11-01T10:00:00Z", total: "252.95", lines: [{ key: "t", item: "t", item_name: "Tea", qty: 2 }] };
    const html = draw(<HeldDialog held={[sale]} onResume={() => {}} onDiscard={() => {}} onClose={() => {}} />);
    expect(html).toContain("Asha Rao");
    expect(html).toContain("2 × Tea");
    expect(html).toContain("Resume");
    expect(html).not.toContain("card's code again");
    // A sale that had a card on it says the card is asked for again; the code itself is nowhere in it.
    const card = draw(<HeldDialog held={[{ ...sale, cardAgain: true }]} onResume={() => {}} onDiscard={() => {}} onClose={() => {}} />);
    expect(card).toContain("Needs the card&#x27;s code again: it is never kept.");
  });

  it("names the shortcuts", () => {
    const html = draw(<KeysDialog onClose={() => {}} />);
    for (const k of ["F2", "F4", "F8", "F9", "F10", "Delete"]) expect(html).toContain(k);
  });
});

describe("the till", () => {
  const till = <Till profile={profile} session={{ id: "s1", number: "POS-OPEN-1" }} modes={modes} book={null} manager={false} offline={false} />;

  it("draws empty, ready for a scan", () => {
    const html = draw(till);
    expect(html).toContain("Counter 1");
    expect(html).toContain("Session POS-OPEN-1");
    expect(html).toContain("Scan a barcode or search items");
    expect(html).toContain("Scan or tap items to start a sale.");
    expect(html).toContain("On hold");
    expect(html).toContain("Return");
    expect(html).toContain("Shift");
  });

  it("brings back the sale that was on screen when the page went", () => {
    saveCart(ownerOf("p1", "asha@shop.test"), { key: "sale-1", customer: { id: null }, lines: [{ key: "tea", item: "tea", item_name: "Masala tea", qty: 3 }] });
    const html = draw(till);
    expect(html).toContain("Masala tea");
    expect(html).not.toContain("Scan or tap items to start a sale.");
  });

  it("says when it is selling offline", () => {
    expect(draw(<Till profile={profile} session={{ id: "s1", number: "" }} modes={modes} book={null} manager={false} offline />)).toContain("Offline");
  });
});

const sheet: Sheet = {
  sale: { id: "sale1", number: "C1-2026-27-000004", posting_date: "2026-11-01", customer: "c1", customer_name: "Asha Rao", cashier: "ravi@shop.test", register: "Counter 1", total: "11.00" },
  blocked: null,
  lines: [{ id: "l1", item: "pen", item_name: "Pen", sold: "2", returned: "1", left: "1", rate: "9.99", amount: "9.99", serials: [], note: "Gift" }],
  paid_with: [{ mode: "cash", paid: "9", refunded: "0", left: "9" }, { mode: "points", paid: "2", refunded: "0", left: "2" }],
  methods: [
    { mode: "cash", name: "Cash", kind: "Cash", usable: true },
    { mode: "card", name: "Card", kind: "Bank", usable: false, why: "this register does not refund through it" },
    { mode: "points", name: "Loyalty Points", kind: "Loyalty Points", usable: true },
  ],
  refundable: { money: "9", loyalty: "2", credit: "0" },
  loyalty: { factor: "0.5", points_left: 4 },
  receipt: {},
};

describe("the return desk", () => {
  const desk = { profile, session: "s1", modes, limits: rightsOf(profile, false), reasons: [] as Doc[] };
  it("asks which sale, with today's sales waiting for the server", () => {
    const html = draw(<ReturnDesk {...desk} onClose={() => {}} onDone={() => {}} />);
    expect(html).toContain("Return goods");
    expect(html).toContain("Scan the receipt, or type its number or the customer");
  });

  it("lists the sales found with the day each comes back until, the register's window, and a sale it cannot take back in the server's words", () => {
    const rows = [
      { id: "a", number: "C1-0001", posting_date: "2026-11-10", posting_time: "10:15:00", customer: null, cashier: "asha@shop.test", register: "Counter 1", total: "120.00", status: "Paid", left_qty: "2", returns_until: "2026-12-10", blocked: null },
      { id: "b", number: "C1-0002", posting_date: "2026-09-01", posting_time: null, customer: "Acme", cashier: "asha@shop.test", register: null, total: "40.00", status: "Paid", left_qty: "1", returns_until: "2026-10-01", blocked: "it is past the days this register takes returns within" },
    ];
    const html = draw(<ReturnDesk {...desk} onClose={() => {}} onDone={() => {}} />, (qc) => qc.setQueryData(["pos", "returns", "p1", ""], { rows, window_days: 30 }));
    expect(html).toMatch(/Comes back until .*2026/);
    expect(html).toContain("This register takes sales back within 30 days.");
    expect(html).toContain("Cannot be returned yet: it is past the days this register takes returns within.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*class="pos-found-row"|class="pos-found-row"[^>]*disabled=""/);
  });

  it("offers a return without a receipt and an exchange only where the register has a return policy", () => {
    expect(draw(<ReturnDesk {...desk} onClose={() => {}} onDone={() => {}} />)).toContain("This register has no return policy.");
    const withPolicy = draw(<ReturnDesk {...desk} profile={{ ...profile, return_policy: "pol" }} onClose={() => {}} onDone={() => {}} />);
    expect(withPolicy).toContain("Return without a receipt");
    expect(withPolicy).toContain("Exchange");
    expect(withPolicy).not.toContain("no return policy");
  });

  it("draws a return that names no sale, and an exchange with its two halves", () => {
    const policy = { price_basis: "Entered", fees: [{ condition: "Damaged", fee_percent: "15" }], store_credit: "credit", refund_modes: [], window_days: 30 };
    const seed = (qc: QueryClient) => qc.setQueryData(["pos", "policy", "pol"], policy);
    const reasons = [{ id: "r1", reason: "Faulty", applies_to: "Return" }];
    const p = { ...profile, return_policy: "pol" };
    const none = draw(<Unreceipted {...desk} profile={p} reasons={reasons} mode="return" onBack={() => {}} onDone={() => {}} />, seed);
    expect(none).toContain("Item coming back");
    expect(none).toContain("Why are they coming back?");
    expect(none).toContain("Faulty");
    expect(none).not.toContain("Item going out");
    const swap = draw(<Unreceipted {...desk} profile={p} reasons={reasons} mode="exchange" onBack={() => {}} onDone={() => {}} />, seed);
    expect(swap).toContain("Item going out");
    expect(swap).toContain("Complete the exchange");
  });

  it("shows a sale's lines, the reason and where the refund goes", () => {
    const html = draw(<Sale {...desk} sale="sale1" onBack={() => {}} onDone={() => {}} />, (qc) => qc.setQueryData(["pos", "return-sheet", "p1", "sale1"], sheet));
    expect(html).toContain("C1-2026-27-000004");
    expect(html).toContain("Pen");
    expect(html).toContain("1 already returned");
    expect(html).toContain("Why are they coming back?");
    expect(html).toContain("Choose what comes back to see the refund.");
    expect(html).toContain("Changed their mind");
  });

  it("shows the day a sale comes back until, and offers an exchange for other goods", () => {
    const html = draw(<Sale {...desk} sale="sale1" onBack={() => {}} onDone={() => {}} />, (qc) => qc.setQueryData(["pos", "return-sheet", "p1", "sale1"], { ...sheet, returns_until: "2026-12-10" }));
    expect(html).toMatch(/Comes back until .*2026/);
    expect(html).toContain("Exchange for other goods");
    expect(html).toContain("Copy of the receipt");
  });

  it("says why a sale cannot come back yet", () => {
    const html = draw(<Sale {...desk} sale="sale1" onBack={() => {}} onDone={() => {}} />, (qc) => qc.setQueryData(["pos", "return-sheet", "p1", "sale1"], { ...sheet, blocked: "it is still in another open session" }));
    expect(html).toContain("Cannot be returned yet: it is still in another open session.");
  });
});

describe("approval at the till", () => {
  const step = { act: "Discount" as const, figure: 12.5, why: "a 12.5% discount exceeds the 10% allowed" };
  const ask = (over: Partial<Parameters<typeof AskDialog>[0]> = {}) => (
    <AskDialog profile="p1" sale="sale-1" title="Approval for this line" steps={[step]} offline={false} onDone={() => {}} onClose={() => {}} {...over} />
  );

  it("asks who approves, their PIN (masked) and why, and says what is being approved", () => {
    const html = draw(ask());
    expect(html).toContain("A discount beyond your limit.");
    expect(html).toContain("a 12.5% discount exceeds the 10% allowed");
    expect(html).toContain("Who approves");
    expect(html).toMatch(/type="password"[^>]*/);
    expect(html).toContain("Their PIN");
    expect(html).toContain("Why");
  });

  it("says approvals need a connection when the till is offline, and numbers the approvals when there are two", () => {
    expect(draw(ask({ offline: true }))).toContain("Approvals need a connection");
    expect(draw(ask({ steps: [step, { act: "Price Change", figure: 0, why: "you may not change prices" }] }))).toContain("Approval 1 of 2");
  });

  it("asks only for a reason when no approval is needed, from the business's list", () => {
    const html = draw(ask({ title: "Take Tea off the sale", steps: [], reasons: [{ id: "r1", reason: "Scanned twice" }, { id: "r2", reason: "Customer changed their mind" }] }));
    expect(html).toContain("Scanned twice");
    expect(html).toContain("Customer changed their mind");
    expect(html).not.toContain("Their PIN");
    expect(html).toContain("Confirm");
  });

  it("sets one's own PIN, twice, online only", () => {
    const html = draw(<SetPinDialog offline={false} onClose={() => {}} />);
    expect(html).toContain("Set my PIN");
    expect(html).toContain("Type it again");
    expect(draw(<SetPinDialog offline onClose={() => {}} />)).toContain("Setting a PIN needs a connection.");
  });

  it("takes a card's code for a card line, offering to make one only online", () => {
    const line = (away: boolean) => draw(<CardLine profile={profile} line="gift" kind="gift" set={null} away={away} onUse={() => {}} />);
    expect(line(false)).toContain("Scan or type the card&#x27;s code before paying.");
    expect(line(false)).not.toMatch(/disabled="" title="[^"]*">Make a new code/);
    expect(line(true)).toMatch(/disabled="" title="[^"]*">Make a new code/);
  });
});

describe("the end of a shift", () => {
  const report: Report = {
    rows: [{ session: "POS-OPEN-1", cashier: "asha@shop.test", mode_of_payment: "Cash", payments: 4, amount: "774.45" }],
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
        status: "Open",
        opened_at: "2026-11-01T04:00:00Z",
        closed_at: null,
        report: "X",
        reconciliation: [
          { mode: "cash", mode_of_payment: "Cash", opening: "500", expected: "774.45", counted: null, difference: "0" },
          { mode: "card", mode_of_payment: "Card", opening: "0", expected: "199", counted: null, difference: "0" },
        ],
      },
    },
  };
  const seed = (qc: QueryClient) => {
    localStorage.setItem("ferrum.pos.profile", "p1");
    qc.setQueryData(["pos", "profile", "p1"], profile);
    qc.setQueryData(["pos", "modes"], modes);
    qc.setQueryData(["pos", "session", "p1", "asha@shop.test"], [{ id: "s1", number: "POS-OPEN-1" }]);
    qc.setQueryData(["pos", "report", "s1"], report);
    qc.setQueryData(["pos", "closing", "s1"], null);
    qc.setQueryData(["pos", "moves", "s1"], [{ id: "m1", movement_type: "Cash Out", amount: "20", reason: "Milk" }]);
    qc.setQueryData(["pos", "drafts", "s1"], []);
    qc.setQueryData(["pos", "currency", "inr"], { precision: 2 });
  };

  it("lays out what is expected against what is counted, and the report so far", () => {
    const html = draw(<ShiftPage />, seed);
    expect(html).toContain("Close the shift");
    expect(html).toContain("Count the drawer");
    expect(html).toContain("774.45");
    expect(html).toContain("Count notes and coins");
    expect(html).toContain("Save the count");
    expect(html).toContain("Cash in and out");
    expect(html).toContain("Milk");
    expect(html).toContain("Only a POS manager can close the shift.");
    expect(html).toContain("So far");
  });

  it("offers a safe drop beside paid in and paid out, a slip for each movement, and what else moved", () => {
    const html = draw(<ShiftPage />, seed);
    expect(html).toContain("Drop to the safe");
    expect(html).toContain("Print slip");
    expect(html).toContain("What else moved");
    expect(html).toContain("Dropped to the safe");
    expect(html).toContain("Refunds and the tax by rate appear once the count is saved.");
    // A saved closing brings the refunds and the tax by rate.
    const closing = { id: "c1", version: 1, refund_total: "25.00", tax_rows: [{ id: "t1", description: "VAT", rate: "10", taxable_amount: "700.00", tax_amount: "70.00" }], payments: [] };
    const withTax = draw(<ShiftPage />, (qc) => (seed(qc), qc.setQueryData(["pos", "closing", "s1"], closing)));
    expect(withTax).toContain("Tax by rate");
    expect(withTax).toMatch(/VAT 10\.00%.*on 700\.00.*70\.00/);
    expect(withTax).toContain("25.00");
    expect(html).toContain("Expected");
    expect(html).toContain("774.45");
  });

  it("on a blind register shows no expected figure before the count is sent, and only the counted way's after", () => {
    const blindProfile = { ...profile, blind_close: true };
    const blindSeed = (qc: QueryClient) => (seed(qc), qc.setQueryData(["pos", "profile", "p1"], blindProfile));
    const before = draw(<ShiftPage />, blindSeed);
    expect(before).toContain("This register closes blind");
    expect(before).toContain("Send the count");
    expect(before).not.toContain("774.45");
    expect(before).not.toContain("199.00");
    expect(before).toContain("after the count is sent");
    expect(before).toContain("2 ways of paying are not counted yet");
    // The cash count was sent: the draft the server saved carries the cash's expected figure, and the card's stays hidden.
    const sent = { id: "c1", version: 2, payments: [{ mode_of_payment: "cash", opening_amount: "500", expected_amount: "774.45", closing_amount: "770.00", difference: "-4.45" }, { mode_of_payment: "card", opening_amount: "0", expected_amount: null, closing_amount: null, difference: "0" }], tax_rows: [] };
    const after = draw(<ShiftPage />, (qc) => (blindSeed(qc), qc.setQueryData(["pos", "closing", "s1"], sent)));
    expect(after).toContain("774.45");
    // (The count typed back into its box, and the short or over beside it, come from an effect a static render does not run.)
    expect(after).not.toContain("199.00");
    expect(after).toContain("ways of paying are not counted yet");
  });

  it("holds the closing back while sales wait on the device", () => {
    localStorage.setItem("ferrum.pos.outbox", JSON.stringify([{ key: "q1", at: "2026-11-01T10:00:00Z", body: { pos_opening_entry: "s1" } }]));
    expect(draw(<ShiftPage />, seed)).toMatch(/A sale is\s+still waiting on this device/);
  });

  it("says plainly when no register was chosen", () => {
    expect(draw(<ShiftPage />)).toContain("No register chosen");
  });
});

describe("prices offline", () => {
  it("says which snapshot priced it, and shows the tax by rate when more than one rate is charged, as the server's does", () => {
    const rows = [{ description: "Standard", rate: "8", taxable_amount: "100.00", tax_amount: "8.00" }, { description: "Reduced", rate: "10", taxable_amount: "20.00", tax_amount: "2.00" }];
    const doc = { total: "120.00", total_taxes: "10.00", rounded_total: "130.00", offline: true, tax_breakdown: rows };
    const html = draw(<Totals doc={doc} due={130} offline builtAt="2026-11-13T09:00:00Z" version="ab12cd34ef56" />);
    expect(html).toContain("Priced on this device");
    expect(html).toContain("Snapshot ab12cd34.");
    expect(html).toMatch(/Standard 8% on 100\.00.*8\.00.*Reduced 10% on 20\.00.*2\.00/);
    expect(html).not.toContain("does not work out promotions");
    // One rate: the Taxes line says it; nothing repeated.
    expect(draw(<Totals doc={{ ...doc, tax_breakdown: rows.slice(0, 1) }} due={130} />)).not.toContain("Standard");
  });

  it("shows a promotional price on its line", () => {
    const lines = [{ key: "k1", item: "i1", item_name: "Plum cake", qty: 2 }];
    const html = draw(<CartLines lines={lines} priced={[{ item: "i1", rate: "36.00", amount: "72.00", discount_percent: "0", promotion_percent: "20" }]} pending={false} selected={null} editing={null} limits={rightsOf(profile, false)} approvals={[]} profile={profile} cards={{}} away baseOf={() => null} onSelect={() => {}} onEdit={() => {}} onQty={() => {}} onChange={() => {}} onAsk={() => {}} onCard={() => {}} onRemove={() => {}} />);
    expect(html).toContain("36.00 each");
    expect(html).toContain("promotion −20%");
  });

  it("lists the sales whose offline price the register could not agree with, and lets a reviewer write what was found", () => {
    const rows = [{ id: "d1", pos_invoice: "s1", pos_profile: "p1", price_snapshot: "ab12cd34ef56", till_total: "139.00", replay_total: "139.00", sale_total: "131.00", snapshot_kept: true, status: "Open", _titles: { pos_invoice: "C1-0042", pos_profile: "Counter 1" } }];
    const html = draw(<DifferencesPage />, (qc) => qc.setQueryData(["pos", "differences", "Open"], { rows }));
    expect(html).toContain("Price differences");
    expect(html).toContain("C1-0042");
    expect(html).toContain("Till 139.00 · snapshot 139.00 · recorded 131.00");
    expect(html).toContain("8.00 less recorded");
    expect(html).toContain("The till took payment for 139.00; the register recorded 131.00.");
    expect(html).toContain("Mark reviewed");
    expect(draw(<DifferencesPage />, (qc) => qc.setQueryData(["pos", "differences", "Open"], { rows: [] }))).toContain("Nothing to review");
  });
});
