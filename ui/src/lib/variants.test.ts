import { describe, expect, it } from "vitest";
import type { BookItem, PriceBook } from "./offline";
import { shortName, tilesOf, variantsOf } from "./variants";

const item = (id: string, name: string, variant_of: string | null = null): BookItem => ({ id, code: name.toUpperCase(), name, barcode: null, variant_of });
const book = (catalog: BookItem[], templates: { id: string; name: string }[] = []) => ({ catalog, templates }) as unknown as PriceBook;
const row = (i: BookItem) => ({ id: i.id, item_code: i.code, item_name: i.name });
// A tee with three sizes, a mug that is no variant, and the tee's template itself (an item too).
const tee = item("tee", "Tee");
const [s, m, l] = [item("s", "Tee-S", "tee"), item("m", "Tee-M", "tee"), item("l", "Tee-L", "tee")];
const mug = item("mug", "Mug");
const shop = book([tee, s, m, l, mug], [{ id: "tee", name: "Tee" }]);

describe("a template's variants as one tile", () => {
  it("no book: one tile per row", () => {
    expect(tilesOf([s, m, mug].map(row), null)).toEqual([s, m, mug].map((i) => ({ item: row(i) })));
  });

  it("puts the variants listed in one tile in the first one's place, counts every variant of the book, and drops the template's own row", () => {
    expect(tilesOf([mug, m, tee, s].map(row), shop)).toEqual([{ item: row(mug) }, { group: "tee", name: "Tee", count: 3 }]);
  });

  it("keeps a single listed variant as its own tile", () => {
    expect(tilesOf([s, mug].map(row), shop)).toEqual([{ item: row(s) }, { item: row(mug) }]);
  });

  it("names a template it was not given after its first listed variant", () => {
    expect(tilesOf([m, s].map(row), book([s, m]))).toEqual([{ group: "tee", name: "Tee-M", count: 2 }]);
  });

  it("lists every variant of a template by name", () => {
    expect(variantsOf(shop, "tee").map((i) => i.id)).toEqual(["l", "m", "s"]);
    expect(variantsOf(shop, "mug")).toEqual([]);
  });

  it("shortens a variant's name to what follows its template's", () => {
    expect(shortName("Tee-S-RED", "Tee")).toBe("S-RED");
    expect(shortName("Tee - Large", "Tee")).toBe("Large");
    expect(shortName("Tee", "Tee")).toBe("Tee");
    expect(shortName("Mug-S", "Tee")).toBe("Mug-S");
  });
});
