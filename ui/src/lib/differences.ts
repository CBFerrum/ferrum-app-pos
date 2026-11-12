// Price Differences: a sale made offline that the server priced again with the snapshot its till used, and
// whose totals did not all agree (what the till took payment for, what the snapshot gives, what was recorded),
// or whose snapshot is no longer kept. The sale stands as the buyer paid it; a person looks at why. This
// says what the three numbers are, as facts: the till cannot know the cause (an old snapshot, a rule it
// does not run, a promotion the server applied), and the reviewer writes what was found.

import { formatDecimal, t } from "@ferrum/client";
import type { Doc } from "@ferrum/records";

export interface Difference {
  id: string;
  sale: string;
  saleNumber: string;
  register: string;
  snapshot: string | null;
  till: number | null;
  replay: number | null;
  recorded: number;
  kept: boolean;
  status: "Open" | "Reviewed";
  resolution: string;
  by: string;
  at: string;
}

const dec = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const title = (d: Doc, f: string) => String((d._titles as Record<string, unknown> | undefined)?.[f] ?? d[f] ?? "");

/** A `PosPriceDifference` row (listed with `titles`) as the screen reads it. */
export function differenceOf(d: Doc): Difference {
  return {
    id: String(d.id),
    sale: String(d.pos_invoice ?? ""),
    saleNumber: title(d, "pos_invoice"),
    register: title(d, "pos_profile"),
    snapshot: d.price_snapshot ? String(d.price_snapshot) : null,
    till: dec(d.till_total),
    replay: dec(d.replay_total),
    recorded: Number(d.sale_total ?? 0),
    kept: d.snapshot_kept !== false,
    status: d.status === "Reviewed" ? "Reviewed" : "Open",
    resolution: String(d.resolution ?? ""),
    by: String(d.resolved_by ?? ""),
    at: String(d.resolved_at ?? ""),
  };
}

/** What differs, one fact to a line, in the figures of the sale's currency. */
export function factsOf(d: Difference, precision = 2): string[] {
  const m = (n: number) => formatDecimal(n, precision);
  const out: string[] = [];
  if (d.till !== null && d.till !== d.recorded) out.push(t("The till took payment for {till}; the register recorded {recorded}.", { till: m(d.till), recorded: m(d.recorded) }));
  if (!d.kept) out.push(t("The snapshot the till used is no longer kept, so the sale could not be priced again with it."));
  else if (d.replay !== null && d.replay !== d.recorded) out.push(t("Priced again with the snapshot it comes to {replay}, not {recorded}.", { replay: m(d.replay), recorded: m(d.recorded) }));
  return out;
}

/** How far the recorded total is from what the till took: positive when the register recorded more. */
export const gapOf = (d: Difference): number | null => (d.till === null ? null : Math.round((d.recorded - d.till) * 1e6) / 1e6);
