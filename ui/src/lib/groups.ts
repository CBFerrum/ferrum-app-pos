// Item groups as tabs above the item tiles (POS-10, the categories): which groups are tabs, and every group under one.
// The groups are the server's (`ItemGroup`, read as the cashier) and remembered for offline with the register.

import type { Doc } from "@ferrum/records";
import { str } from "./pos";

export interface Group {
  id: string;
  group_name: string;
  parent_group: string | null;
}

/** A group as the list gives it, or null for a row without an id. */
export const groupOf = (d: Doc): Group | null => (str(d.id) ? { id: str(d.id), group_name: str(d.group_name) || str(d.id), parent_group: str(d.parent_group) || null } : null);

/** The tabs: the register's Item Groups Shown when it names some; otherwise the groups one level under the top of the
 *  tree, or the top ones when the tree is flat. By name. */
export function tabsOf(groups: Group[], shown: string[]): Group[] {
  const byName = (a: Group, b: Group) => a.group_name.localeCompare(b.group_name);
  if (shown.length) return groups.filter((g) => shown.includes(g.id)).sort(byName);
  const tops = groups.filter((g) => !g.parent_group);
  const top = new Set(tops.map((g) => g.id));
  const kids = groups.filter((g) => g.parent_group !== null && top.has(g.parent_group));
  return (kids.length ? kids : tops).slice().sort(byName);
}

/** `id` and every group below it. A loop in the data (a group its own ancestor) ends. */
export function under(groups: Group[], id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const g of groups) {
      if (g.parent_group && out.has(g.parent_group) && !out.has(g.id)) {
        out.add(g.id);
        grew = true;
      }
    }
  }
  return out;
}
