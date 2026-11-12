// The reviewer's list of Price Differences (a manager's): sales the till made offline, which the server priced
// again with the snapshot the till used and got another total from, or could not price again. The sale stands
// as the buyer paid it; here a person sees what the three totals were and writes what was found and done
// (the `review` action). Needs the connection and the right to read and review them: a person without it
// is told so, never shown an empty list.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { docPath, errorMessage, formatDecimal, formatMoment, t as tr, isolate } from "@ferrum/client";
import { Alert, Badge, Button, Dialog, Field, ListSkeleton, StatePanel, toast, useShellTitle } from "@ferrum/kit";
import type { Doc } from "@ferrum/records";
import { Problem } from "./ui";
import { differenceOf, factsOf, gapOf, type Difference } from "./lib/differences";
import { till } from "./lib/offline";
import { reviewDifference } from "./lib/server";

const FIELDS = "id,pos_invoice,pos_profile,price_snapshot,till_total,replay_total,sale_total,snapshot_kept,status,resolution,resolved_by,resolved_at,created_at";

export default function DifferencesPage() {
  useShellTitle(tr("Price differences"));
  const qc = useQueryClient();
  const [status, setStatus] = useState<"Open" | "Reviewed">("Open");
  const [reviewing, setReviewing] = useState<Difference | null>(null);
  const list = useQuery({
    queryKey: ["pos", "differences", status],
    queryFn: ({ signal }) => till<{ rows: Doc[] }>(docPath("PosPriceDifference"), { query: { filters: JSON.stringify({ status }), fields: FIELDS, titles: true, sort: "created_at desc", limit: 100 }, signal }),
    staleTime: 0,
  });
  const rows = (list.data?.rows ?? []).map(differenceOf);
  const money = (n: number | null) => (n === null ? "—" : formatDecimal(n, 2));
  return (
    <div className="pos-shift">
      <header className="pos-shift-head">
        <div>
          <h1>{tr("Price differences")}</h1>
          <p className="muted">{tr("Sales made offline that the register priced again with the snapshot their till used, and got another total from. Each stands as the buyer paid it.")}</p>
        </div>
        <span className="spacer" />
        <Link className="btn btn-default btn-md" to="/">
          {tr("Back to the till")}
        </Link>
      </header>
      <div className="segmented" role="group" aria-label={tr("Which to show")}>
        {(["Open", "Reviewed"] as const).map((s) => (
          <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s === "Open" ? tr("To review") : tr("Reviewed")}
          </button>
        ))}
      </div>
      {list.error ? (
        <Problem error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <ListSkeleton rows={4} />
      ) : rows.length === 0 ? (
        <StatePanel kind="empty" title={status === "Open" ? tr("Nothing to review") : tr("Nothing reviewed yet")}>
          {status === "Open" ? tr("No offline sale has come to another total than the till's.") : tr("Differences appear here once someone has written what was found.")}
        </StatePanel>
      ) : (
        <ul className="pos-found pos-found-all" aria-label={tr("Price differences")}>
          {rows.map((d) => {
            const gap = gapOf(d);
            return (
              <li key={d.id} className="pos-found-row" data-static>
                <span className="pos-found-main">
                  <strong>
                    <Link to={`/e/PosInvoice/${encodeURIComponent(d.sale)}`}>{isolate(d.saleNumber || d.sale)}</Link>
                    {d.register ? <span className="muted"> · {isolate(d.register)}</span> : null}
                  </strong>
                  <span className="muted">
                    {tr("Till {till} · snapshot {replay} · recorded {recorded}", { till: money(d.till), replay: money(d.replay), recorded: money(d.recorded) })}
                    {gap !== null && gap !== 0 ? ` · ${gap > 0 ? tr("{amount} more recorded", { amount: money(Math.abs(gap)) }) : tr("{amount} less recorded", { amount: money(Math.abs(gap)) })}` : ""}
                  </span>
                  {factsOf(d).map((f) => (
                    <span key={f} className="faint">
                      {isolate(f)}
                    </span>
                  ))}
                  {d.snapshot && <span className="faint">{tr("Snapshot {version}", { version: d.snapshot.slice(0, 8) })}</span>}
                  {d.status === "Reviewed" && (
                    <span className="muted">
                      {isolate(d.resolution)}
                      {d.by ? ` — ${isolate(d.by)}` : ""}
                      {d.at ? ` · ${isolate(formatMoment(d.at, { dateStyle: "medium", timeStyle: "short" }))}` : ""}
                    </span>
                  )}
                </span>
                {d.status === "Open" ? <Button onClick={() => setReviewing(d)}>{tr("Mark reviewed")}</Button> : <Badge tone="green">{tr("Reviewed")}</Badge>}
              </li>
            );
          })}
        </ul>
      )}
      {reviewing && (
        <Review
          d={reviewing}
          onClose={() => setReviewing(null)}
          onDone={() => {
            setReviewing(null);
            toast(tr("Marked as reviewed"));
            void qc.invalidateQueries({ queryKey: ["pos", "differences"] });
          }}
        />
      )}
    </div>
  );
}

/** What was found and done, written by the reviewer (required: the server keeps it with who and when). */
function Review({ d, onClose, onDone }: { d: Difference; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await reviewDifference(d.id, text.trim());
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title={tr("Review {number}", { number: d.saleNumber || d.sale })}
      footer={
        <>
          <Button className="pos-btn" onClick={onClose} disabled={busy}>
            {tr("Cancel")}
          </Button>
          <Button variant="primary" className="pos-btn" form="pos-review" type="submit" loading={busy} disabled={!text.trim()}>
            {tr("Mark reviewed")}
          </Button>
        </>
      }
    >
      <form id="pos-review" className="pos-paying" onSubmit={(e) => void submit(e)}>
        {factsOf(d).map((f) => (
          <p key={f} className="muted">
            {isolate(f)}
          </p>
        ))}
        <Field label={tr("What was found and done")} htmlFor="review-text" required hint={tr("Kept with who reviewed it and when.")}>
          <textarea id="review-text" className="textarea" rows={3} data-autofocus maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        {error && <Alert tone="error">{isolate(error)}</Alert>}
      </form>
    </Dialog>
  );
}
