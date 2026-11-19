import { describe, expect, it } from "vitest";
import { groupOf, tabsOf, under, type Group } from "./groups";

const g = (id: string, group_name: string, parent_group: string | null = null): Group => ({ id, group_name, parent_group });
// A tree as a business keeps it: one group at the top, the shop's groups under it, sub-groups under those.
const tree = [g("root", "All Item Groups"), g("d", "Drinks", "root"), g("b", "Bakery", "root"), g("hot", "Hot drinks", "d"), g("tea", "Tea", "hot"), g("s", "Snacks", "root")];

describe("item groups as tabs", () => {
  it("are the register's shown groups when it names some, else one level under the top, or the top ones of a flat list; by name", () => {
    expect(tabsOf(tree, ["s", "d", "gone"]).map((x) => x.id)).toEqual(["d", "s"]);
    expect(tabsOf(tree, []).map((x) => x.group_name)).toEqual(["Bakery", "Drinks", "Snacks"]);
    expect(tabsOf([g("z", "Zest"), g("a", "Apples"), g("m", "Milk")], []).map((x) => x.group_name)).toEqual(["Apples", "Milk", "Zest"]);
    expect(tabsOf([], [])).toEqual([]);
  });

  it("hold their group and every group below it, and a loop in the data ends", () => {
    expect([...under(tree, "d")].sort()).toEqual(["d", "hot", "tea"]);
    expect([...under(tree, "b")]).toEqual(["b"]);
    expect([...under([g("x", "X", "y"), g("y", "Y", "x")], "x")].sort()).toEqual(["x", "y"]);
  });

  it("read a group from the list, and skip a row without an id", () => {
    expect(groupOf({ id: "d", group_name: "Drinks", parent_group: "root" })).toEqual(g("d", "Drinks", "root"));
    expect(groupOf({ id: "n" })).toEqual(g("n", "n"));
    expect(groupOf({ group_name: "No id" })).toBeNull();
  });
});
