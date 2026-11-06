// The end of a shift, on one page: for every way of paying, what the register expects, what was
// counted and how far apart they are; the cash counted note by note; the reason when they differ;
// the cash that moved in and out; and the Z report. The server works out what is expected and books
// any difference when the closing is submitted. A cashier saves their count as a draft and a POS
// manager closes the shift (the register's roles); a manager can do both at once. Closing is held
// back while sales made offline are still on this device, since the session would refuse them.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router";
import { api, docPath, errorMessage, formatDecimal, formatMoment, request } from "@ferrum/client";
import { Alert, Badge, Button, confirmDialog, EmptyState, ErrorState, Field, PageLoading, toast, useShellTitle } from "@ferrum/kit";
import { LinkInput, type Doc } from "@ferrum/records";
import { CashCounter, countTotal, type Counted } from "./Count";
import { Currency, localDate, myEmail, num, remembered, str, titleOf } from "./fmt";
import { useManager, useOutbox } from "./hooks";
import { loadHeld, ownerOf } from "./lib/held";
import { till } from "./lib/offline";
import { difference, closingBody, countsOf, denominations, reasonOf, remarksOf, standing, typedAmount, zReportHtml, type Report } from "./lib/shift";
import { printHtml } from "./print";

const rowsOf = <T,>(entity: string, query: Record<string, string | number | boolean>, signal?: AbortSignal) => api.get<{ rows: T[] }>(docPath(entity), query, signal).then((r) => r.rows);

export default function ShiftPage() {
  useShellTitle("Close the shift");
  const profileId = remembered();
  if (!profileId) {
    return (
      <EmptyState title="No register chosen" icon="store">
        <Link to="/">Go to the till</Link> and choose a register first.
      </EmptyState>
    );
  }
  return <Shift profileId={profileId} />;
}

function Shift({ profileId }: { profileId: string }) {
  const qc = useQueryClient();
  const email = myEmail();
  const manager = useManager(undefined);
  const outbox = useOutbox();

  const profile = useQuery({ queryKey: ["pos", "profile", profileId], queryFn: ({ signal }) => till<Doc>(docPath("PosProfile", profileId), { query: { titles: true }, signal }) });
  const modes = useQuery({ queryKey: ["pos", "modes"], queryFn: ({ signal }) => rowsOf<Doc>("ModeOfPayment", { fields: "id,mode_name,mode_type", limit: 200 }, signal), staleTime: 300_000 });
  const open = useQuery({
    queryKey: ["pos", "session", profileId, email],
    enabled: !!email,
    queryFn: ({ signal }) => rowsOf<Doc>("PosOpeningEntry", { filters: JSON.stringify({ pos_profile: profileId, status: "Open", user: email }), fields: "id,number,period_start", limit: 1 }, signal),
  });
  // Once closed the session is no longer "open", but its Z report is still what this page shows.
  const [closed, setClosed] = useState<string | null>(null);
  const sid = closed ?? str(open.data?.[0]?.id);

  if (profile.error || modes.error || open.error) return <ErrorState error={profile.error ?? modes.error ?? open.error} onRetry={() => void Promise.all([profile.refetch(), modes.refetch(), open.refetch()])} />;
  if (!profile.data || !modes.data || !open.data) return <PageLoading label="Loading the shift…" />;
  if (!sid) {
    return (
      <EmptyState title="No shift is open" icon="store">
        <Link to="/">Go to the till</Link> to open the register.
      </EmptyState>
    );
  }
  return (
    <Closing
      key={sid}
      profile={profile.data}
      modes={modes.data}
      session={{ id: sid, number: str(open.data[0]?.number) }}
      manager={manager}
      outbox={outbox}
      closed={closed !== null}
      onClosed={() => {
        setClosed(sid);
        void qc.invalidateQueries({ queryKey: ["pos", "session"] });
      }}
    />
  );
}

type Typed = Record<string, string>;

function Closing({
  profile,
  modes,
  session,
  manager,
  outbox,
  closed,
  onClosed,
}: {
  profile: Doc;
  modes: Doc[];
  session: { id: string; number: string };
  manager: boolean;
  outbox: ReturnType<typeof useOutbox>;
  closed: boolean;
  onClosed: () => void;
}) {
  const qc = useQueryClient();
  const profileId = str(profile.id);
  const company = str(profile.company);
  const code = titleOf(profile, "currency");
  const precision = useQuery({
    queryKey: ["pos", "currency", str(profile.currency)],
    queryFn: ({ signal }) => api.get<Doc>(docPath("Currency", str(profile.currency)), undefined, signal),
    enabled: !!profile.currency,
    staleTime: 300_000,
  }).data?.precision;
  const places = typeof precision === "number" ? precision : 2;
  const money = (v: unknown) => formatDecimal(v ?? 0, places);

  const report = useQuery({
    queryKey: ["pos", "report", session.id],
    queryFn: ({ signal }) => api.get<Report>("/api/reports/pos_sales_summary", { pos_opening_entry: session.id, company }, signal),
    staleTime: 0,
  });
  const draft = useQuery({
    queryKey: ["pos", "closing", session.id],
    queryFn: async ({ signal }) => {
      const found = await rowsOf<Doc>("PosClosingEntry", { filters: JSON.stringify({ pos_opening_entry: session.id, docstatus: 0 }), fields: "id", limit: 1 }, signal);
      return found[0] ? api.get<Doc>(docPath("PosClosingEntry", str(found[0].id)), undefined, signal) : null;
    },
    staleTime: 0,
  });
  const moves = useQuery({
    queryKey: ["pos", "moves", session.id],
    queryFn: ({ signal }) => rowsOf<Doc>("PosCashMovement", { filters: JSON.stringify({ pos_opening_entry: session.id, docstatus: 1 }), fields: "movement_type,amount,reason", sort: "created_at asc", limit: 100 }, signal),
    staleTime: 0,
  });
  const unfinished = useQuery({
    queryKey: ["pos", "drafts", session.id],
    queryFn: ({ signal }) => rowsOf<Doc>("PosInvoice", { filters: JSON.stringify({ pos_opening_entry: session.id, docstatus: 0 }), fields: "id", limit: 50 }, signal),
    staleTime: 0,
  });

  // A link to the cash section (from the till's menu) lands on it once the page has drawn.
  const { hash } = useLocation();
  const drawn = !!report.data && !draft.isLoading;
  useEffect(() => {
    if (drawn && hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [drawn, hash]);

  const recon = report.data?.meta.session?.reconciliation ?? [];
  const kindOf = (mode: string) => str(modes.find((m) => m.id === mode)?.mode_type);
  const drawer = recon.find((r) => kindOf(r.mode) === "Cash")?.mode ?? null;
  const known = useMemo(() => [...denominations(code).notes, ...denominations(code).coins], [code]);

  const [counted, setCounted] = useState<Counted>({ counts: {}, other: "" });
  const [counting, setCounting] = useState(false);
  const [typed, setTyped] = useState<Typed>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Doc | null>(null);

  // A count saved earlier is what the page starts from.
  const draftId = str(draft.data?.id);
  useEffect(() => {
    const d = draft.data;
    if (!d) return;
    const back = countsOf((d.denominations as Doc[] | undefined) ?? [], known);
    if (Object.keys(back.counts).length || back.other) {
      setCounting(true);
      setCounted({ counts: back.counts, other: back.other ? String(back.other) : "" });
    }
    setTyped(Object.fromEntries(((d.payments as Doc[] | undefined) ?? []).filter((p) => p.closing_amount != null && p.mode_of_payment !== drawer).map((p) => [str(p.mode_of_payment), String(p.closing_amount)])));
    setReason(reasonOf(str(d.remarks)));
  }, [draftId]); // eslint-disable-line react-hooks/exhaustive-deps

  const countedOf = (mode: string): number | null => (mode === drawer && counting ? countTotal(counted, places) : typedAmount(typed[mode]));
  const lines = recon.map((r) => {
    const expected = num(r.expected);
    const got = countedOf(r.mode);
    const text = typed[r.mode];
    return { ...r, expected, opening: num(r.opening), got, bad: !(r.mode === drawer && counting) && !!text?.trim() && got === null, diff: difference(expected, got, places), name: r.mode_of_payment ?? "" };
  });
  const off = lines.filter((l) => l.diff !== 0);
  const anyCounted = lines.some((l) => l.got !== null);
  const unsent = outbox.queued.filter((s) => s.body.pos_opening_entry === session.id);
  const heldAside = loadHeld(ownerOf(profileId, myEmail())).length;
  const drafts = unfinished.data?.length ?? 0;
  const invalid = lines.some((l) => l.bad) || (off.length > 0 && !reason.trim());

  const save = async (submit: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (submit && !anyCounted && !(await confirmDialog({ title: "Close without counting?", message: "Nothing was counted, so the shift closes as the register expects it.", confirmLabel: "Close the shift" }))) return;
      const body = closingBody({
        session: session.id,
        drawer: counting ? drawer : null,
        counts: counted.counts,
        other: typedAmount(counted.other) ?? 0,
        typed: lines.filter((l) => !(l.mode === drawer && counting)).map((l) => ({ mode: l.mode, amount: l.got })),
        remarks: remarksOf(lines.map((l) => ({ name: l.name, difference: l.diff })), reason, places),
      });
      // The count saved a moment ago is the latest version, even before the page has read it back.
      const target = saved ?? draft.data;
      let doc = target ? await api.patch<Doc>(docPath("PosClosingEntry", str(target.id)), body, { ifMatch: Number(target.version) }) : await api.post<Doc>(docPath("PosClosingEntry"), body);
      if (submit) {
        doc = await api.post<Doc>(docPath("PosClosingEntry", str(doc.id), "submit"), undefined, { ifMatch: Number(doc.version) });
        toast("Shift closed");
        onClosed();
      } else {
        toast("Count saved");
        setSaved(doc);
      }
      void qc.invalidateQueries({ queryKey: ["pos", "closing", session.id] });
      void report.refetch();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (report.error) return <ErrorState error={report.error} onRetry={() => void report.refetch()} />;
  if (!report.data || draft.isLoading) return <PageLoading label="Working out what the register expects…" />;
  const meta = report.data.meta;
  const z = closed || meta.session?.report === "Z";

  return (
    <Currency.Provider value={{ precision: places, code }}>
      <div className="pos-shift">
        <header className="pos-shift-head">
          <div>
            <h1>{z ? "Shift closed" : "Close the shift"}</h1>
            <p className="muted">
              {str(profile.profile_name)} · session {meta.session?.number ?? session.number}
              {meta.session?.opened_at ? ` · opened ${formatMoment(meta.session.opened_at, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : ""}
            </p>
          </div>
          <span className="spacer" />
          <Button icon="printer" onClick={() => printHtml(zReportHtml(profile, report.data, z ? str(draft.data?.remarks) || remarksOf(lines.map((l) => ({ name: l.name, difference: l.diff })), reason, places) : null))}>
            Print the {z ? "Z" : "X"} report
          </Button>
          <Link className="btn btn-default btn-md" to="/">
            Back to the till
          </Link>
        </header>

        {!z && (
          <>
            {unsent.length > 0 && (
              <Alert tone="warning" action={<Button onClick={() => void outbox.flush()}>Send now</Button>}>
                {unsent.length === 1 ? "A sale is" : `${unsent.length} sales are`} still waiting on this device to be sent. Send {unsent.length === 1 ? "it" : "them"} before closing: once the shift is closed the register refuses them.
              </Alert>
            )}
            {drafts > 0 && (
              <Alert tone="warning">
                {drafts === 1 ? "A sale is" : `${drafts} sales are`} unfinished in this shift. Finish or delete {drafts === 1 ? "it" : "them"} first, or the shift cannot close.{" "}
                <Link to="/e/PosInvoice">Open the sales</Link>
              </Alert>
            )}
            {heldAside > 0 && <Alert tone="info">{heldAside === 1 ? "A sale is" : `${heldAside} sales are`} on hold at this till. They stay on this device for the next shift.</Alert>}

            <section className="pos-card" aria-label="Count the drawer">
              <h2>Count the drawer</h2>
              <p className="muted">Count what is in the drawer and on each terminal. Leave a line empty if it is as expected.</p>
              <div className="pos-recon" role="table" aria-label="Expected against counted">
                <div className="pos-recon-head" role="row">
                  <span role="columnheader">Way of paying</span>
                  <span role="columnheader" className="num">Opening</span>
                  <span role="columnheader" className="num">Expected</span>
                  <span role="columnheader">Counted</span>
                  <span role="columnheader" className="num">Difference</span>
                </div>
                {lines.map((l) => (
                  <div className="pos-recon-row" role="row" key={l.mode}>
                    <span role="cell" className="pos-recon-name">{l.name}</span>
                    <span role="cell" data-label="Opening" className="num faint">{money(l.opening)}</span>
                    <span role="cell" data-label="Expected" className="num">{money(l.expected)}</span>
                    <span role="cell" data-label="Counted">
                      {l.mode === drawer && counting ? (
                        <strong className="num">{money(countTotal(counted, places))}</strong>
                      ) : (
                        <input
                          className="input num"
                          inputMode="decimal"
                          placeholder="as expected"
                          aria-label={`${l.name} counted`}
                          aria-invalid={l.bad || undefined}
                          value={typed[l.mode] ?? ""}
                          onChange={(e) => setTyped((t) => ({ ...t, [l.mode]: e.target.value }))}
                        />
                      )}
                      {l.mode === drawer && (
                        <Button onClick={() => setCounting((c) => !c)}>{counting ? "Type the total" : "Count notes and coins"}</Button>
                      )}
                    </span>
                    <span role="cell" data-label="Difference" className="num" data-standing={l.got === null ? undefined : standing(l.diff)}>
                      {l.got === null ? "" : l.diff === 0 ? "Right" : `${l.diff < 0 ? "Short" : "Over"} ${money(Math.abs(l.diff))}`}
                    </span>
                  </div>
                ))}
              </div>
              {counting && drawer && <CashCounter value={counted} onChange={setCounted} />}
              {off.length > 0 && (
                <Field label="What happened?" htmlFor="shift-reason" required hint="Kept with the closing, so whoever checks the books can read why the drawer was not as expected.">
                  <textarea id="shift-reason" className="textarea" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
              )}
              {error && <Alert tone="error">{error}</Alert>}
              {saved && !manager && (
                <Alert tone="success">
                  Your count is saved. A POS manager closes the shift: they find it in <Link to={`/e/PosClosingEntry/${str(saved.id)}`}>POS Closing Entries</Link>.
                </Alert>
              )}
              <div className="pos-sticky">
                <span className="spacer" />
                <Button disabled={busy || invalid} onClick={() => void save(false)}>
                  Save the count
                </Button>
                {manager && (
                  <Button variant="primary" className="pos-btn" loading={busy} disabled={invalid || unsent.length > 0 || drafts > 0} onClick={() => void save(true)}>
                    Close the shift
                  </Button>
                )}
              </div>
              {!manager && <p className="faint">Only a POS manager can close the shift. Saving the count lets them do it without counting again.</p>}
            </section>
          </>
        )}

        <section className="pos-card" aria-label={`${z ? "Z" : "X"} report`}>
          <h2>
            {z ? "Z report" : "So far"} <Badge tone={z ? "green" : "blue"}>{z ? "Closed" : "Open"}</Badge>
          </h2>
          <dl className="pos-totals">
            <dt>Sales</dt>
            <dd>{meta.sales}</dd>
            <dt>Returns</dt>
            <dd>{meta.returns}</dd>
            <dt>Net sales</dt>
            <dd>{money(meta.net_total)}</dd>
            <dt>Taxes</dt>
            <dd>{money(meta.total_taxes)}</dd>
            <dt className="pos-total-label">Total</dt>
            <dd className="pos-total">{money(meta.grand_total)}</dd>
          </dl>
          {report.data.rows.length > 0 && (
            <>
              <h3 className="pos-sub">Taken, by way of paying</h3>
              <ul className="pos-taken">
                {report.data.rows.map((r) => (
                  <li key={r.mode_of_payment}>
                    <span>
                      {r.mode_of_payment} <span className="faint">{r.payments} payments</span>
                    </span>
                    <strong>{money(r.amount)}</strong>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {!z && <Cash session={session.id} company={company} moves={moves.data ?? []} money={money} onMoved={() => { void moves.refetch(); void report.refetch(); }} />}
      </div>
    </Currency.Provider>
  );
}

/** Cash put into or taken out of the drawer during the shift: a float top-up, a payout for milk. */
function Cash({ session, company, moves, money, onMoved }: { session: string; company: string; moves: Doc[]; money: (v: unknown) => string; onMoved: () => void }) {
  const [kind, setKind] = useState<"Cash In" | "Cash Out">("Cash Out");
  const [amount, setAmount] = useState("");
  const [why, setWhy] = useState("");
  const [account, setAccount] = useState<{ id: string | null; title?: string }>({ id: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = typedAmount(amount);
  const ok = value !== null && value > 0 && !!why.trim() && !!account.id;
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await request(docPath("PosCashMovement"), {
        method: "POST",
        query: { submit: true },
        body: { pos_opening_entry: session, movement_type: kind, amount: String(value), reason: why.trim(), account: account.id, posting_date: localDate(new Date()) },
      });
      toast(kind === "Cash In" ? "Cash put in" : "Cash taken out");
      setAmount("");
      setWhy("");
      setAccount({ id: null });
      onMoved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="pos-card" id="cash" aria-label="Cash in and out">
      <h2>Cash in and out</h2>
      {moves.length === 0 ? (
        <p className="muted">Nothing has moved in or out of the drawer this shift.</p>
      ) : (
        <ul className="pos-taken">
          {moves.map((m, i) => (
            <li key={str(m.id) || i}>
              <span>
                {str(m.movement_type)} <span className="faint">{str(m.reason)}</span>
              </span>
              <strong>
                {m.movement_type === "Cash Out" ? "−" : "+"}
                {money(m.amount)}
              </strong>
            </li>
          ))}
        </ul>
      )}
      <form
        className="pos-cash-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !busy) void add();
        }}
      >
        <div className="segmented" role="group" aria-label="In or out">
          {(["Cash Out", "Cash In"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === "Cash In" ? "Put in" : "Take out"}
            </button>
          ))}
        </div>
        <Field label="Amount" htmlFor="cash-amount">
          <input id="cash-amount" className="input" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label={kind === "Cash In" ? "Where it came from" : "What it was for"} htmlFor="cash-account" required hint={kind === "Cash In" ? "The safe or bank account the cash came from." : "The expense account it is booked to."}>
          <LinkInput to="Account" id="cash-account" value={account.id} title={account.title} onChange={(id, title) => setAccount({ id, title })} linkFilters={{ is_group: false, company }} />
        </Field>
        <Field label="Reason" htmlFor="cash-reason" required>
          <input id="cash-reason" className="input" autoComplete="off" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Milk for the staff room" />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" variant="primary" loading={busy} disabled={!ok}>
          {kind === "Cash In" ? "Put in" : "Take out"} {value ? money(value) : ""}
        </Button>
      </form>
    </section>
  );
}
