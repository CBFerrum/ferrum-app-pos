import { describe, expect, it } from "vitest";
import { fromServer, heldBody, heldSummary, loadCart, loadGone, loadHeld, mergeHeld, ownerOf, putAside, saveCart, saveGone, saveHeld, takeHeld, takeOut, totalOf, type Cart, type HeldSale } from "./held";

const memory = (start: Record<string, string> = {}) => {
  const mem = new Map(Object.entries(start));
  return { mem, getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
};

const cart = (key: string, ...names: string[]): Cart => ({
  key,
  customer: { id: null },
  lines: names.map((n) => ({ key: n, item: n, item_name: n, qty: 1 })),
});

describe("a held sale keeps its discount", () => {
  it("gives it back when resumed, and a sale kept without one still loads", () => {
    const list = putAside([], { ...cart("a", "Tea"), discount: "7.5" }, "t");
    expect(takeOut(list, "a").sale?.discount).toBe("7.5");
    const storage = memory();
    const mine = ownerOf("p1", "asha@shop.test");
    expect(saveHeld(mine, putAside([], cart("b", "Cake"), "t"), storage)).toBe(true);
    const back = loadHeld(mine, storage);
    expect([back.length, back[0].discount]).toEqual([1, undefined]);
  });
});

describe("sales set aside", () => {
  it("keeps the newest first and leaves an empty basket out", () => {
    let list = putAside([], cart("a", "Tea"), "2026-11-01T10:00:00Z", "20.00");
    list = putAside(list, cart("b", "Cake", "Tea"), "2026-11-01T10:05:00Z");
    expect(list.map((s) => s.key)).toEqual(["b", "a"]);
    expect(list[1].total).toBe("20.00");
    expect("total" in list[0]).toBe(false);
    expect(putAside(list, cart("c"), "2026-11-01T10:06:00Z")).toBe(list);
  });

  it("takes one back out and leaves the rest", () => {
    const list = putAside(putAside([], cart("a", "Tea"), "t1"), cart("b", "Cake"), "t2");
    const { sale, rest } = takeOut(list, "a");
    expect([sale?.key, rest.map((s) => s.key)]).toEqual(["a", ["b"]]);
    expect(takeOut(list, "zzz")).toEqual({ sale: null, rest: list });
  });

  it("keeps that a card was on a held sale, never the card's code", () => {
    const storage = memory();
    const mine = ownerOf("p1", "asha@shop.test");
    const list = putAside([], { ...cart("a", "Gift card"), cardAgain: true }, "t");
    expect(saveHeld(mine, list, storage)).toBe(true);
    expect(loadHeld(mine, storage)[0].cardAgain).toBe(true);
    expect([...storage.mem.values()].join()).not.toMatch(/stored_value|code|pin/i);
    expect("cardAgain" in putAside([], cart("b", "Tea"), "t")[0]).toBe(false);
  });

  it("belongs to one register and one cashier", () => {
    const storage = memory();
    const mine = ownerOf("p1", "Asha@Shop.test");
    expect(mine).toBe("p1:asha@shop.test");
    expect(saveHeld(mine, putAside([], cart("a", "Tea"), "t"), storage)).toBe(true);
    expect(saveHeld(ownerOf("p2", "asha@shop.test"), putAside([], cart("b", "Cake"), "t"), storage)).toBe(true);
    expect(loadHeld(mine, storage).map((s) => s.key)).toEqual(["a"]);
    expect(loadHeld(ownerOf("p1", "other@shop.test"), storage)).toEqual([]);
    saveHeld(mine, [], storage);
    expect(loadHeld(mine, storage)).toEqual([]);
    expect(loadHeld(ownerOf("p2", "asha@shop.test"), storage)).toHaveLength(1);
  });

  it("shows who and how many", () => {
    const sale = { ...cart("a", "Tea", "Cake"), customer: { id: "c1", title: "Asha Rao" }, at: "t" };
    expect(heldSummary(sale)).toEqual({ who: "Asha Rao", lines: "2 lines" });
    expect(heldSummary({ ...sale, customer: { id: null }, lines: sale.lines.slice(0, 1) })).toEqual({ who: "Walk-in customer", lines: "1 line" });
    expect([totalOf({ rounded_total: "252.95", grand_total: "252.97" }), totalOf({ grand_total: "9" }), totalOf(null), totalOf({ rounded_total: "" })]).toEqual(["252.95", "9", undefined, undefined]);
  });
});

describe("the sale in progress", () => {
  it("comes back after a reload, and is forgotten once empty", () => {
    const storage = memory();
    const me = ownerOf("p1", "asha@shop.test");
    expect(loadCart(me, storage)).toBeNull();
    expect(saveCart(me, cart("a", "Tea"), storage)).toBe(true);
    expect(loadCart(me, storage)?.lines.map((l) => l.item_name)).toEqual(["Tea"]);
    expect(saveCart(me, cart("a"), storage)).toBe(true);
    expect(loadCart(me, storage)).toBeNull();
    expect(saveCart(me, null, storage)).toBe(true);
  });

  it("survives storage that is empty, corrupt, full or blocked", () => {
    const me = ownerOf("p1", "asha@shop.test");
    expect(loadCart(me, memory({ "ferrum.pos.cart": "{not json" }))).toBeNull();
    expect(loadCart(me, memory({ "ferrum.pos.cart": "[1,2]" }))).toBeNull();
    expect(loadCart(me, memory({ "ferrum.pos.cart": JSON.stringify({ [me]: { lines: "no", key: 3 } }) }))).toBeNull();
    expect(loadHeld(me, memory({ "ferrum.pos.held": JSON.stringify({ [me]: [{ lines: [], key: "k", customer: { id: null } }, "junk"] }) }))).toEqual([]);
    const full = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(saveCart(me, cart("a", "Tea"), full)).toBe(false);
    expect(saveHeld(me, putAside([], cart("a", "Tea"), "t"), full)).toBe(false);
    expect(saveCart(me, cart("a", "Tea"), undefined)).toBe(false);
    expect(loadHeld(me, undefined)).toEqual([]);
  });
});

describe("the register's copy of a held sale", () => {
  const sale = (key: string, more: Partial<HeldSale> = {}): HeldSale => ({ ...cart(key, "Tea"), at: "2026-11-19T10:00:00Z", ...more });
  const row = (key: string, more: Record<string, unknown> = {}) => ({
    id: key,
    cashier: "asha@shop.test",
    customer: null,
    customer_title: null,
    held_at: "2026-11-19T10:00:00Z",
    total: "20.00",
    cart: { key, customer: { id: null }, lines: [{ key: "Tea", item: "Tea", item_name: "Tea", qty: 1 }] },
    ...more,
  });

  it("is sent with its key as the id, the basket as the till keeps it, the sale's discount inside, and never a card's code", () => {
    const body = heldBody(sale("k1", { total: "20.00", discount: "5", cardAgain: true, sent: false, by: "x@shop.test" }), "p1");
    expect([body.id, body.pos_profile, body.held_at, body.total]).toEqual(["k1", "p1", "2026-11-19T10:00:00Z", "20.00"]);
    expect(body.cart).toMatchObject({ key: "k1", discount: "5", cardAgain: true, lines: [{ item: "Tea", qty: 1 }] });
    for (const k of ["sent", "by", "at"]) expect(k in (body.cart as object)).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/stored_value_(code|pin)/);
  });

  it("is read as untrusted: a good row, one whose basket was erased, and a malformed one", () => {
    const good = fromServer(row("k1", { cashier: "ravi@shop.test" }), "asha@shop.test");
    expect([good?.key, good?.sent, good?.by, good?.lines.length, good?.total]).toEqual(["k1", true, "ravi@shop.test", 1, "20.00"]);
    expect(fromServer(row("k2"), "ASHA@shop.test")?.by).toBeUndefined();
    const erased = fromServer(row("k3", { cart: null, customer_title: "Acme" }), "asha@shop.test");
    expect([erased?.erased, erased?.lines.length, erased?.customer.title]).toEqual([true, 0, "Acme"]);
    for (const bad of [{ cart: "lines" }, { cart: { lines: [] } }, { cart: { lines: [{ item: "Tea", qty: 0 }] } }, { held_at: null }]) expect(fromServer(row("k4", bad), "asha@shop.test")).toBeNull();
    expect("extra" in (fromServer(row("k5", { cart: { ...row("k5").cart, extra: "x" } }), "a@b.c") as object)).toBe(false);
  });

  it("shows the device's rows, then the register's the device does not hold, and drops a sent row a whole answer no longer lists", () => {
    const deviceOnly = sale("d", { sent: false });
    const both = sale("b", { sent: true });
    const taken = sale("t", { sent: true });
    const serverOnly = { ...sale("s"), sent: true };
    const server = [{ ...both }, serverOnly];
    const whole = mergeHeld([deviceOnly, both, taken], server, [], true);
    expect([whole.device.map((x) => x.key), whole.shown.map((x) => x.key)]).toEqual([["d", "b"], ["d", "b", "s"]]);
    // A partial answer proves nothing: the sent row stays.
    expect(mergeHeld([deviceOnly, both, taken], server, [], false).device.map((x) => x.key)).toEqual(["d", "b", "t"]);
    // A row taken here, its delete still to go, is not shown again.
    expect(mergeHeld([deviceOnly], server, ["s"], true).shown.map((x) => x.key)).toEqual(["d", "b"]);
  });

  it("takes a held sale once: deleted there, then taken from here; another till took it; a refusal changes nothing", async () => {
    const list = [sale("a", { sent: true }), sale("b", { sent: false })];
    const kept: string[][] = [];
    const io = (del: (k: string) => Promise<unknown>) => ({ del, lost: (e: unknown) => e instanceof TypeError, keepGone: (k: string[]) => void kept.push(k) });
    const done = await takeHeld("a", list, [], io(async () => undefined));
    expect([done.taken, done.sale?.key, done.list.map((x) => x.key), done.gone, kept]).toEqual([true, "a", ["b"], [], [["a"], []]]);
    const elsewhere = await takeHeld("a", list, [], io(async () => Promise.reject(Object.assign(new Error("not found"), { status: 404 }))));
    expect([elsewhere.taken, elsewhere.why, elsewhere.list.map((x) => x.key), elsewhere.gone]).toEqual([false, "elsewhere", ["b"], []]);
    await expect(takeHeld("a", list, ["z"], io(async () => Promise.reject(Object.assign(new Error("no"), { status: 403 }))))).rejects.toThrow("no");
    expect(kept.at(-1)).toEqual(["z"]);
    // Never sent: the register has nothing to delete.
    const local = await takeHeld("b", list, [], io(async () => Promise.reject(new Error("must not be called"))));
    expect([local.taken, local.sale?.key]).toEqual([true, "b"]);
  });

  it("a_lost_delete_resumes_from_the_device: the delete's answer lost, the sale is taken from the device and its key waits", async () => {
    const list = [sale("a", { sent: true })];
    const io = { del: async () => Promise.reject(new DOMException("timed out", "TimeoutError")), lost: () => true, keepGone: () => undefined };
    const took = await takeHeld("a", list, [], io);
    expect([took.taken, took.sale?.key, took.list, took.gone]).toEqual([true, "a", [], ["a"]]);
  });

  it("keeps the keys still to delete per register and cashier, through storage that fails", () => {
    const storage = memory();
    const mine = ownerOf("p1", "asha@shop.test");
    expect(saveGone(mine, ["a", "b"], storage)).toBe(true);
    expect(loadGone(mine, storage)).toEqual(["a", "b"]);
    expect(loadGone(ownerOf("p1", "ravi@shop.test"), storage)).toEqual([]);
    expect(loadGone(mine, memory({ "ferrum.pos.held.gone": "{" }))).toEqual([]);
  });
});
