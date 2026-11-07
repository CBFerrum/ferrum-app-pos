// A shift's two ends: opening it with a counted float, and closing it with the drawer counted
// against what the register expects, the difference explained, and the Z report. The server works
// out what is expected (`pos_sales_summary` for the session) and books the difference when the
// closing is submitted; this is the counting and the page that is printed.

import { formatDecimal, formatMoment, t as tr } from "@ferrum/client";
import type { Doc } from "@ferrum/records";
import { round } from "./pay";
import { esc, printPage } from "./pos";

export interface Denoms {
  notes: number[];
  coins: number[];
  /** The steps cash is likely to be handed over in, for the quick amounts of the pay dialog. */
  quick: number[];
}

const KNOWN: Record<string, Denoms> = {
  INR: { notes: [2000, 500, 200, 100, 50, 20, 10], coins: [5, 2, 1], quick: [10, 50, 100, 500, 2000] },
  USD: { notes: [100, 50, 20, 10, 5, 2, 1], coins: [0.5, 0.25, 0.1, 0.05, 0.01], quick: [1, 5, 10, 20, 50, 100] },
  EUR: { notes: [200, 100, 50, 20, 10, 5], coins: [2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01], quick: [5, 10, 20, 50, 100] },
  GBP: { notes: [50, 20, 10, 5], coins: [2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01], quick: [5, 10, 20, 50] },
  AED: { notes: [1000, 500, 200, 100, 50, 20, 10, 5], coins: [1, 0.5, 0.25], quick: [5, 10, 50, 100, 500] },
  SAR: { notes: [500, 200, 100, 50, 20, 10, 5], coins: [2, 1, 0.5, 0.25, 0.1, 0.05], quick: [5, 10, 50, 100, 500] },
};

/** The notes and coins of a currency to count with; one this list does not know starts from a
 *  general set, and anything else goes in "Other". */
export function denominations(currency: string | null | undefined): Denoms {
  return KNOWN[(currency ?? "").toUpperCase()] ?? { notes: [1000, 500, 100, 50, 20, 10], coins: [5, 2, 1, 0.5], quick: [10, 50, 100, 500, 1000] };
}

/** What a count of notes and coins comes to: `counts` is how many of each value, by value. */
export function cashCounted(counts: Record<string, number>, other = 0, precision = 2): number {
  return round(Object.entries(counts).reduce((s, [value, n]) => s + Number(value) * Math.max(0, Math.floor(n || 0)), 0) + Math.max(0, other || 0), precision);
}

/** One way of paying in a shift's reconciliation. */
export interface Recon {
  mode: string;
  mode_of_payment: string | null;
  opening: string | null;
  expected: string | null;
  counted: string | null;
  difference: string | null;
}

export interface Report {
  rows: { session: string; cashier: string; mode_of_payment: string; payments: number; amount: string }[];
  totals: { amount: string };
  meta: {
    sales: number;
    returns: number;
    net_total: string;
    total_taxes: string;
    grand_total: string;
    company?: string;
    currency?: string;
    session?: { number: string | null; cashier: string | null; status: string | null; opened_at: string | null; closed_at: string | null; report: "X" | "Z"; reconciliation: Recon[] };
  };
}

/** How far a counted amount is from the expected one; nothing counted is as expected. */
export const difference = (expected: number, counted: number | null, precision = 2) => (counted === null ? 0 : round(counted - expected, precision));

/** "Short", "Over" or "Right" for a difference: coloured and worded, never colour alone. */
export const standing = (diff: number): "short" | "over" | "right" => (diff < 0 ? "short" : diff > 0 ? "over" : "right");

/** A typed amount: nothing typed is nothing counted (null), not zero. A comma is refused rather
 *  than guessed at ("12,50" is not twelve hundred and fifty). */
export function typedAmount(text: string | undefined): number | null {
  if (text === undefined || text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The closing entry for a session: notes and coins counted for the drawer, a total for every other
 *  way of paying, and what the person said about any difference. */
export function closingBody(o: {
  session: string;
  /** The drawer's cash method, when its cash is counted note by note. */
  drawer: string | null;
  counts: Record<string, number>;
  other: number;
  typed: { mode: string; amount: number | null }[];
  remarks: string;
}): Doc {
  const denominations = [
    ...Object.entries(o.counts)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => Number(b) - Number(a))
      .map(([value, n]) => ({ ...(o.drawer ? { mode_of_payment: o.drawer } : {}), denomination: value, count: Math.floor(n) })),
    ...(o.other > 0 ? [{ ...(o.drawer ? { mode_of_payment: o.drawer } : {}), denomination: String(o.other), count: 1 }] : []),
  ];
  return {
    pos_opening_entry: o.session,
    payments: o.typed.filter((t) => t.amount !== null).map((t) => ({ mode_of_payment: t.mode, closing_amount: String(t.amount) })),
    denominations,
    remarks: o.remarks.trim() || null,
  };
}

/** The counts a saved closing holds, as the page shows them: by value, with what is not a known
 *  note or coin as "other". */
export function countsOf(rows: Doc[], known: number[]): { counts: Record<string, number>; other: number } {
  const counts: Record<string, number> = {};
  let other = 0;
  for (const r of rows) {
    const value = Number(r.denomination);
    const n = Number(r.count) || 0;
    if (known.includes(value)) counts[String(value)] = (counts[String(value)] ?? 0) + n;
    else other += value * n;
  }
  return { counts, other: round(other, 6) };
}

/** What a closing's remarks say: first line which counts were off, then what the person said
 *  about it. The server only keeps the text; the page writes it so a saved count reads back. */
export function remarksOf(rows: { name: string; difference: number }[], reason: string, precision = 2): string {
  const off = rows.filter((r) => r.difference !== 0).map((r) => (r.difference < 0 ? tr("{name} short by {amount}", { name: r.name, amount: formatDecimal(Math.abs(r.difference), precision) }) : tr("{name} over by {amount}", { name: r.name, amount: formatDecimal(Math.abs(r.difference), precision) })));
  return [off.length ? `${off.join("; ")}.` : "", reason.trim()].filter(Boolean).join("\n");
}

/** What the person said, from remarks written by `remarksOf` (or by hand). */
export function reasonOf(remarks: string | null | undefined): string {
  const [first = "", ...rest] = (remarks ?? "").split("\n");
  return /\b(short|over) by [\d.,]+\.?$/.test(first) ? rest.join("\n") : (remarks ?? "");
}

/** The X report (a shift still open) or the Z report (once it is closed), ready to print. */
export function zReportHtml(profile: Doc, report: Report, remarks?: string | null): string {
  const money = (v: unknown) => formatDecimal(v ?? 0, 2);
  const s = report.meta.session;
  const at = (v: string | null | undefined) => formatMoment(v, { dateStyle: "medium", timeStyle: "medium" });
  const takings = report.rows.map((r) => `<tr><td>${esc(r.mode_of_payment)}<br><small>${esc(r.payments)} payments</small></td><td class="r">${esc(money(r.amount))}</td></tr>`).join("");
  const drawer = (s?.reconciliation ?? [])
    .map(
      (r) =>
        `<tr><td>${esc(r.mode_of_payment)}</td><td class="r">${esc(money(r.expected))}</td></tr>` +
        (r.counted == null ? "" : `<tr><td><small>counted</small></td><td class="r">${esc(money(r.counted))}</td></tr><tr><td><small>${Number(r.difference) < 0 ? "short" : Number(r.difference) > 0 ? "over" : "difference"}</small></td><td class="r">${esc(money(r.difference))}</td></tr>`),
    )
    .join("");
  return printPage(
    profile,
    tr("{value} report {value2}", { value: s?.report ?? "X", value2: s?.number ?? "" }),
    `
    <h1>${esc(profile.profile_name)}</h1>
    <p><b>${s?.report === "Z" ? "Z REPORT" : "X REPORT"}</b><br>Session ${esc(s?.number)} · ${esc(s?.cashier)}<br>Opened ${esc(at(s?.opened_at))}${s?.closed_at ? `<br>Closed ${esc(at(s.closed_at))}` : ""}</p><hr>
    <table><tr><td>Sales</td><td class="r">${esc(report.meta.sales)}</td></tr><tr><td>Returns</td><td class="r">${esc(report.meta.returns)}</td></tr>
    <tr><td>Net sales</td><td class="r">${esc(money(report.meta.net_total))}</td></tr><tr><td>Taxes</td><td class="r">${esc(money(report.meta.total_taxes))}</td></tr>
    <tr><td><b>Total</b></td><td class="r"><b>${esc(money(report.meta.grand_total))}</b></td></tr></table><hr>
    <p><b>Taken, by way of paying</b></p><table>${takings}</table><hr>
    <p><b>In the drawer</b></p><table>${drawer}</table>
    ${remarks ? `<hr><p>${esc(remarks)}</p>` : ""}
  `,
  );
}
