import { describe, expect, it } from "vitest";
import { heldSummary, loadCart, loadHeld, ownerOf, putAside, saveCart, saveHeld, takeOut, totalOf, type Cart } from "./held";

const memory = (start: Record<string, string> = {}) => {
  const mem = new Map(Object.entries(start));
  return { mem, getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
};

const cart = (key: string, ...names: string[]): Cart => ({
  key,
  customer: { id: null },
  lines: names.map((n) => ({ key: n, item: n, item_name: n, qty: 1 })),
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
