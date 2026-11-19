// A template's variants as one tile (POS-11): where ERP's Stock Operations add-on marks items as variants of a
// template, the price book carries each item's `variant_of` and the templates' names, and the till draws one tile per
// template with a chooser. The same tiles online and offline, since the grouping comes from the book; no book, flat tiles.

import type { Doc } from "@ferrum/records";
import type { BookItem, PriceBook } from "./offline";
import { str } from "./pos";

/** A tile: one item, or a template standing for its variants (`count`: how many the book holds). */
export type Tile = { item: Doc } | { group: string; name: string; count: number };

/** The listed rows as tiles: the variants of one template become one tile in the first one's place, and the template's own
 *  row goes; a template with a single variant listed stays that variant's tile. */
export function tilesOf(rows: Doc[], book: PriceBook | null): Tile[] {
  if (!book) return rows.map((item) => ({ item }));
  const of = new Map(book.catalog.map((i) => [i.id, i.variant_of ?? null]));
  const names = new Map((book.templates ?? []).map((t) => [t.id, t.name]));
  const listed = new Map<string, Doc[]>();
  const out: ({ item: Doc } | { group: string })[] = [];
  for (const r of rows) {
    const t = of.get(str(r.id));
    if (!t) {
      out.push({ item: r });
      continue;
    }
    if (!listed.has(t)) {
      listed.set(t, []);
      out.push({ group: t });
    }
    listed.get(t)!.push(r);
  }
  return out
    .filter((x) => !("item" in x) || !listed.has(str(x.item.id)))
    .map((x) => {
      if ("item" in x) return x;
      const mine = listed.get(x.group)!;
      return mine.length === 1 ? { item: mine[0] } : { group: x.group, name: names.get(x.group) || str(mine[0].item_name) || str(mine[0].item_code), count: variantsOf(book, x.group).length };
    });
}

/** Every variant of `template` the book holds, by name. */
export function variantsOf(book: PriceBook, template: string): BookItem[] {
  return book.catalog.filter((i) => i.variant_of === template).sort((a, b) => a.name.localeCompare(b.name));
}

/** A variant's name without its template's name at the start and the separators after it ("Tee-S-RED" of "Tee": "S-RED");
 *  the whole name when that leaves nothing or it does not start so. */
export function shortName(variant: string, template: string): string {
  const v = variant.trim();
  const t = template.trim();
  if (!t || !v.startsWith(t)) return v;
  return v.slice(t.length).replace(/^[\s\-–—_:,./|·]+/u, "") || v;
}
