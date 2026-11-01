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
import { PayDialog, ReceiptDialog } from "./Pay";
import ReturnDesk, { Sale } from "./Returns";
import ShiftPage from "./Shift";
import { Till } from "./Till";
import { Currency } from "./fmt";
import { ownerOf, saveCart } from "./lib/held";
import { rightsOf } from "./lib/rights";
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
  const props = { profile, modes, due: 252.95, grand: 252.97, walkIn: true, customer: null, program: null, offline: false, steps: [10, 50, 100, 500, 2000], onClose: () => {}, onComplete: async () => null };

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
  const show = (rights: ReturnType<typeof rightsOf>, editing: string | null) =>
    draw(
      <CartLines
        lines={lines}
        priced={priced}
        pending={false}
        selected="cake"
        editing={editing}
        rights={rights}
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
      <CartLines lines={lines} priced={[priced[1], priced[0]]} pending selected={null} editing={null} rights={rightsOf(profile, false)} baseOf={() => null} onSelect={() => {}} onEdit={() => {}} onQty={() => {}} onChange={() => {}} onRemove={() => {}} />,
    );
    expect(html).not.toContain("40.50");
    expect(html).toContain("Pricing…");
  });

  it("opens a line's editor with the cap before typing, as far as the role allows", () => {
    const cashier = show(rightsOf(profile, false), "cake");
    expect(cashier).toContain("You can give up to 10%.");
    expect(cashier).toContain("List price 45.00");
    expect(cashier).not.toContain(">Price<");
    const priceToo = show(rightsOf({ ...profile, allow_rate_change: true }, false), "cake");
    expect(priceToo).toContain(">Price<");
    expect(show(rightsOf({ allow_discount_change: false }, false), "cake")).toContain("does not let cashiers give discounts");
    expect(show(rightsOf({}, true), "cake")).toContain("No limit for you.");
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
  it("asks which sale, with today's sales waiting for the server", () => {
    const html = draw(<ReturnDesk profile={profile} session="s1" onClose={() => {}} onDone={() => {}} />);
    expect(html).toContain("Return goods");
    expect(html).toContain("Receipt number or customer");
  });

  it("shows a sale's lines, the reason and where the refund goes", () => {
    const html = draw(<Sale profile={profile} session="s1" sale="sale1" onBack={() => {}} onDone={() => {}} />, (qc) => qc.setQueryData(["pos", "return-sheet", "p1", "sale1"], sheet));
    expect(html).toContain("C1-2026-27-000004");
    expect(html).toContain("Pen");
    expect(html).toContain("1 already returned");
    expect(html).toContain("Why are they coming back?");
    expect(html).toContain("Choose what comes back to see the refund.");
    expect(html).toContain("Changed their mind");
  });

  it("says why a sale cannot come back yet", () => {
    const html = draw(<Sale profile={profile} session="s1" sale="sale1" onBack={() => {}} onDone={() => {}} />, (qc) => qc.setQueryData(["pos", "return-sheet", "p1", "sale1"], { ...sheet, blocked: "it is still in another open session" }));
    expect(html).toContain("Cannot be returned yet: it is still in another open session.");
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

  it("holds the closing back while sales wait on the device", () => {
    localStorage.setItem("ferrum.pos.outbox", JSON.stringify([{ key: "q1", at: "2026-11-01T10:00:00Z", body: { pos_opening_entry: "s1" } }]));
    expect(draw(<ShiftPage />, seed)).toMatch(/A sale is\s+still waiting on this device/);
  });

  it("says plainly when no register was chosen", () => {
    expect(draw(<ShiftPage />)).toContain("No register chosen");
  });
});
