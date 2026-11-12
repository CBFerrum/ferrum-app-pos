// The end of a shift, on one page: for every way of paying, what the register expects, what was
// counted and how far apart they are; the cash counted note by note; the reason when they differ;
// the cash that moved in and out; and the Z report. The server works out what is expected and books
// any difference when the closing is submitted. A cashier saves their count as a draft and a POS
// manager closes the shift (the register's roles); a manager can do both at once. Closing is held
// back while sales made offline are still on this device, since the session would refuse them.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router";
import { api, docPath, errorMessage, formatDecimal, formatMoment, t as tr, isolate } from "@ferrum/client";
import { Alert, Badge, Button, confirmDialog, Field, toast, useShellTitle, placed, FormSkeleton, StatePanel } from "@ferrum/kit";
import { Problem } from "./ui";
import { LinkInput, type Doc } from "@ferrum/records";
import { CashCounter, countTotal, type Counted } from "./Count";
import { Currency, localDate, myEmail, num, remembered, str, titleOf } from "./fmt";
import { useManager, useOutbox } from "./hooks";
import { loadHeld, ownerOf } from "./lib/held";
import { till, unreachable } from "./lib/offline";
import { paperOf } from "./lib/server";
import { difference, closingBody, countsOf, denominations, expectedOf, fallbackShiftHtml, movedOf, movementBody, reasonOf, remarksOf, sentOf, standing, typedAmount, uncounted, type Report } from "./lib/shift";
import { printHtml } from "./print";

const rowsOf = <T,>(entity: string, query: Record<string, string | number | boolean>, signal?: AbortSignal) => api.get<{ rows: T[] }>(docPath(entity), query, signal).then((r) => r.rows);

export default function ShiftPage() {
  useShellTitle(tr("Close the shift"));
  const profileId = remembered();
  if (!profileId) {
    return (
      <StatePanel kind="empty" title={tr("No register chosen")}>
        <Link to="/">{tr("Go to the till")}</Link> {tr("and choose a register first.")}
      </StatePanel>
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
  const modes = useQuery({ queryKey: ["pos", "modes", "rows"], queryFn: ({ signal }) => rowsOf<Doc>("ModeOfPayment", { fields: "id,mode_name,mode_type", limit: 200 }, signal), staleTime: 300_000 });
  const open = useQuery({
    queryKey: ["pos", "session", "rows", profileId, email],
    enabled: !!email,
    queryFn: ({ signal }) => rowsOf<Doc>("PosOpeningEntry", { filters: JSON.stringify({ pos_profile: profileId, status: "Open", user: email }), fields: "id,number,period_start", limit: 1 }, signal),
  });
  // Once closed the session is no longer "open", but its Z report is still what this page shows.
  const [closed, setClosed] = useState<string | null>(null);
  const sid = closed ?? str(open.data?.[0]?.id);

  if (profile.error || modes.error || open.error) return <Problem error={profile.error ?? modes.error ?? open.error} onRetry={() => void Promise.all([profile.refetch(), modes.refetch(), open.refetch()])} />;
  if (!profile.data || !modes.data || !open.data) return <FormSkeleton fields={5} />;
  if (!sid) {
    return (
      <StatePanel kind="empty" title={tr("No shift is open")}>
        <Link to="/">{tr("Go to the till")}</Link> {tr("to open the register.")}
      </StatePanel>
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
    queryFn: ({ signal }) => rowsOf<Doc>("PosCashMovement", { filters: JSON.stringify({ pos_opening_entry: session.id, docstatus: 1 }), fields: "id,number,movement_type,amount,reason", sort: "created_at asc", limit: 100 }, signal),
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

  // A blind register: the server sends what a method was expected to hold only once its count is in; the page shows what it is sent, and adds nothing up.
  const blind = profile.blind_close === true;
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
  // What the closing saved last says per counted method: on a blind register the only expected figures there are before the report has them.
  const closing = saved ?? draft.data ?? null;
  const sent = sentOf(closing);
  const ended = closed || report.data?.meta.session?.report === "Z";
  const lines = recon.map((r) => {
    const expected = expectedOf(sent, r.mode, r.expected);
    const got = countedOf(r.mode);
    const text = typed[r.mode];
    return { ...r, expected, opening: num(r.opening), got, bad: !(r.mode === drawer && counting) && !!text?.trim() && got === null, diff: expected === null ? 0 : difference(expected, got, places), name: r.mode_of_payment ?? "" };
  });
  const off = lines.filter((l) => l.diff !== 0);
  const anyCounted = lines.some((l) => l.got !== null);
  const unsent = outbox.queued.filter((s) => s.body.pos_opening_entry === session.id);
  const heldAside = loadHeld(ownerOf(profileId, myEmail())).length;
  const drafts = unfinished.data?.length ?? 0;
  const left = blind ? uncounted(lines.map((l) => l.got)) : 0;
  const invalid = lines.some((l) => l.bad) || (off.length > 0 && !reason.trim());
  // Sending a blind count reveals the differences, which is when the reason is asked: the count itself is not held back by it.
  const cannotSend = blind ? lines.some((l) => l.bad) : invalid;
  const cannotClose = invalid || (blind && left > 0);

  const save = async (submit: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (submit && !blind && !anyCounted && !(await confirmDialog({ title: tr("Close without counting?"), message: tr("Nothing was counted, so the shift closes as the register expects it."), confirmLabel: tr("Close the shift") }))) return;
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
        toast(tr("Shift closed"));
        setSaved(doc);
        onClosed();
      } else {
        toast(blind ? tr("Count sent") : tr("Count saved"));
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

  // The report on paper is the server's template on the closing (`pos.shift_report`): a draft one for the X report while the shift is open, the
  // submitted one for the Z report. A shift with no closing yet gets an empty draft to print from (nothing is counted or sent by it).
  const [printing, setPrinting] = useState(false);
  const [note, setNote] = useState<{ tone: "warning" | "error"; text: string } | null>(null);
  const printPaper = async () => {
    if (printing || !report.data) return;
    setPrinting(true);
    setNote(null);
    try {
      let target = saved ?? draft.data;
      if (!target) {
        target = await api.post<Doc>(docPath("PosClosingEntry"), closingBody({ session: session.id, drawer: null, counts: {}, other: 0, typed: [], remarks: "" }));
        setSaved(target);
        void qc.invalidateQueries({ queryKey: ["pos", "closing", session.id] });
      }
      printHtml(await paperOf("PosClosingEntry", str(target.id), "pos.shift_report"));
    } catch (e) {
      if (unreachable(e) || (e as { status?: number })?.status === 0) {
        printHtml(fallbackShiftHtml(profile, report.data, ended ? str((saved ?? draft.data)?.remarks) : null));
        setNote({ tone: "warning", text: tr("The register could not be reached, so this is the till's own report, marked as such.") });
      } else setNote({ tone: "error", text: errorMessage(e) });
    } finally {
      setPrinting(false);
    }
  };

  if (report.error) return <Problem error={report.error} onRetry={() => void report.refetch()} />;
  if (!report.data || draft.isLoading) return <FormSkeleton fields={5} />;
  const meta = report.data.meta;
  const z = closed || meta.session?.report === "Z";
  // The server leaves the sales of a session still open on a blind register out of a cashier's reports (a POS manager's have them): what it
  // sends then is no count of the shift's sales. The closing's own figures come with the last count, and are shown when they are there.
  const withheld = blind && !z && !manager;
  const sales = withheld
    ? closing?.grand_total != null
      ? { sales: num(closing.invoice_count), returns: num(closing.return_count), net: closing.net_total, taxes: closing.total_taxes, total: closing.grand_total }
      : null
    : { sales: meta.sales, returns: meta.returns, net: meta.net_total, taxes: meta.total_taxes, total: meta.grand_total };

  return (
    <Currency.Provider value={{ precision: places, code }}>
      <div className="pos-shift">
        <header className="pos-shift-head">
          <div>
            <h1>{z ? tr("Shift closed") : tr("Close the shift")}</h1>
            <p className="muted">
              {isolate(str(profile.profile_name))} {tr("· session")} {meta.session?.number ?? session.number}
              {meta.session?.opened_at ? tr(" · opened {value}", { value: formatMoment(meta.session.opened_at, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) }) : ""}
            </p>
          </div>
          <span className="spacer" />
          <Button icon="printer" loading={printing} onClick={() => void printPaper()}>
            {placed(tr("Print the {p1} report"), { p1: z ? "Z" : "X" })}
          </Button>
          <Link className="btn btn-default btn-md" to="/">
            {tr("Back to the till")}
          </Link>
        </header>

        {note && <Alert tone={note.tone}>{isolate(note.text)}</Alert>}
        {!z && (
          <>
            {unsent.length > 0 && (
              <Alert tone="warning" action={<Button onClick={() => void outbox.flush()}>{tr("Send now")}</Button>}>
                {placed(tr("{p1} still waiting on this device to be sent. Send {p2} before closing: once the shift is closed the register refuses them."), { p1: unsent.length === 1 ? tr("A sale is") : tr("{length} sales are", { length: unsent.length }), p2: unsent.length === 1 ? tr("it") : tr("them") })}
              </Alert>
            )}
            {drafts > 0 && (
              <Alert tone="warning">
                {placed(tr("{p1} unfinished in this shift. Finish or delete {p2} first, or the shift cannot close. {p3}"), { p1: drafts === 1 ? tr("A sale is") : tr("{drafts} sales are", { drafts }), p2: drafts === 1 ? tr("it") : tr("them"), p3: <Link to="/e/PosInvoice">{tr("Open the sales")}</Link> })}
              </Alert>
            )}
            {heldAside > 0 && <Alert tone="info">{(heldAside === 1 ? tr("A sale is on hold at this till. They stay on this device for the next shift.") : tr("{heldAside} sales are on hold at this till. They stay on this device for the next shift.", { heldAside }))}</Alert>}

            <section className="pos-card" aria-label={tr("Count the drawer")}>
              <h2>{tr("Count the drawer")}</h2>
              <p className="muted">
                {blind
                  ? tr("This register closes blind: count every way of paying first. What each was expected to hold is shown only once its count is sent.")
                  : tr("Count what is in the drawer and on each terminal. Leave a line empty if it is as expected.")}
              </p>
              <div className="pos-recon" role="table" aria-label={tr("Expected against counted")}>
                <div className="pos-recon-head" role="row">
                  <span role="columnheader">{tr("Way of paying")}</span>
                  <span role="columnheader" className="num">{tr("Opening")}</span>
                  <span role="columnheader" className="num">{tr("Expected")}</span>
                  <span role="columnheader">{tr("Counted")}</span>
                  <span role="columnheader" className="num">{tr("Difference")}</span>
                </div>
                {lines.map((l) => (
                  <div className="pos-recon-row" role="row" key={l.mode}>
                    <span role="cell" className="pos-recon-name">{isolate(l.name)}</span>
                    <span role="cell" data-label="Opening" className="num faint">{isolate(money(l.opening))}</span>
                    <span role="cell" data-label="Expected" className="num">
                      {l.expected === null ? <span className="faint">{tr("after the count is sent")}</span> : isolate(money(l.expected))}
                    </span>
                    <span role="cell" data-label="Counted">
                      {l.mode === drawer && counting ? (
                        <strong className="num">{isolate(money(countTotal(counted, places)))}</strong>
                      ) : (
                        <input
                          className="input num"
                          inputMode="decimal"
                          placeholder={blind ? tr("count it") : tr("as expected")}
                          aria-label={tr("{name} counted", { name: l.name })}
                          aria-invalid={l.bad || undefined}
                          value={typed[l.mode] ?? ""}
                          onChange={(e) => setTyped((t) => ({ ...t, [l.mode]: e.target.value }))}
                        />
                      )}
                      {l.mode === drawer && (
                        <Button onClick={() => setCounting((c) => !c)}>{counting ? tr("Type the total") : tr("Count notes and coins")}</Button>
                      )}
                    </span>
                    <span role="cell" data-label="Difference" className="num" data-standing={l.got === null || l.expected === null ? undefined : standing(l.diff)}>
                      {l.got === null || l.expected === null ? "" : l.diff === 0 ? tr("Right") : l.diff < 0 ? tr("Short {amount}", { amount: money(Math.abs(l.diff)) }) : tr("Over {amount}", { amount: money(Math.abs(l.diff)) })}
                    </span>
                  </div>
                ))}
              </div>
              {lines.some((l) => l.got !== null && l.expected !== null) && (
                <p className="pos-counter-total" aria-live="polite">
                  <span className="muted">{tr("Over and short")}</span>
                  <strong>{isolate(money(lines.reduce((sum, l) => (l.got !== null && l.expected !== null ? sum + l.diff : sum), 0)))}</strong>
                </p>
              )}
              {counting && drawer && <CashCounter value={counted} onChange={setCounted} />}
              {off.length > 0 && (
                <Field label={tr("What happened?")} htmlFor="shift-reason" required hint={tr("Kept with the closing, so whoever checks the books can read why the drawer was not as expected.")}>
                  <textarea id="shift-reason" className="textarea" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
              )}
              {error && <Alert tone="error">{isolate(error)}</Alert>}
              {saved && !manager && (
                <Alert tone="success">
                  {tr("Your count is saved. A POS manager closes the shift: they find it in")} <Link to={`/e/PosClosingEntry/${str(saved.id)}`}>{tr("POS Closing Entries")}</Link>.
                </Alert>
              )}
              <div className="pos-sticky">
                <span className="spacer" />
                <Button disabled={busy || cannotSend} onClick={() => void save(false)}>
                  {blind ? tr("Send the count") : tr("Save the count")}
                </Button>
                {manager && (
                  <Button variant="primary" className="pos-btn" loading={busy} disabled={cannotClose || unsent.length > 0 || drafts > 0} onClick={() => void save(true)}>
                    {tr("Close the shift")}
                  </Button>
                )}
              </div>
              {blind && left > 0 && <p className="faint">{left === 1 ? tr("One way of paying is not counted yet: a blind register closes only when every one is.") : tr("{left} ways of paying are not counted yet: a blind register closes only when every one is.", { left })}</p>}
              {!manager && <p className="faint">{tr("Only a POS manager can close the shift. Saving the count lets them do it without counting again.")}</p>}
            </section>
          </>
        )}

        <section className="pos-card" aria-label={tr("{value} report", { value: z ? "Z" : "X" })}>
          <h2>
            {z ? tr("Z report") : tr("So far")} <Badge tone={z ? "green" : "blue"}>{z ? tr("Closed") : tr("Open")}</Badge>
          </h2>
          {sales ? (
            <dl className="pos-totals">
              <dt>{tr("Sales")}</dt>
              <dd>{sales.sales}</dd>
              <dt>{tr("Returns")}</dt>
              <dd>{sales.returns}</dd>
              <dt>{tr("Net sales")}</dt>
              <dd>{isolate(money(sales.net))}</dd>
              <dt>{tr("Taxes")}</dt>
              <dd>{isolate(money(sales.taxes))}</dd>
              <dt className="pos-total-label">{tr("Total")}</dt>
              <dd className="pos-total">{isolate(money(sales.total))}</dd>
            </dl>
          ) : (
            <p className="faint">{tr("This register closes blind: the shift's sales and takings are shown once every way of paying is counted.")}</p>
          )}
          {!withheld && report.data.rows.length > 0 && (
            <>
              <h3 className="pos-sub">{tr("Taken, by way of paying")}</h3>
              <ul className="pos-taken">
                {report.data.rows.map((r) => (
                  <li key={r.mode_of_payment}>
                    <span>
                      {isolate(r.mode_of_payment)} <span className="faint">{tr("{payments} payments", { payments: r.payments })}</span>
                    </span>
                    <strong>{isolate(money(r.amount))}</strong>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <Figures closing={closing} moves={moves.data ?? []} money={money} />

        {!z && <Cash session={session.id} company={company} moves={moves.data ?? []} money={money} onMoved={() => { void moves.refetch(); void report.refetch(); }} />}
      </div>
    </Currency.Provider>
  );
}

/** What the shift moved besides sales, and the tax of its sales by rate: the cash paid in and out and dropped to the safe from the movements as they stand, refunds and the tax by
 *  rate from the closing as it was last saved (the server works them out when a closing is saved). Neither is the expected figure of a method. */
function Figures({ closing, moves, money }: { closing: Doc | null; moves: Doc[]; money: (v: unknown) => string }) {
  const moved = movedOf(moves);
  const tax = ((closing?.tax_rows as Doc[] | undefined) ?? []).filter((r) => num(r.tax_amount) !== 0 || num(r.taxable_amount) !== 0);
  return (
    <section className="pos-card" aria-label={tr("What else moved")}>
      <h2>{tr("What else moved")}</h2>
      <dl className="pos-totals">
        <dt>{tr("Paid in")}</dt>
        <dd>{isolate(money(moved.paidIn))}</dd>
        <dt>{tr("Paid out")}</dt>
        <dd>{isolate(money(moved.paidOut))}</dd>
        <dt>{tr("Dropped to the safe")}</dt>
        <dd>{isolate(money(moved.dropped))}</dd>
        {closing && (
          <>
            <dt>{tr("Refunded on returns")}</dt>
            <dd>{isolate(money(closing.refund_total))}</dd>
          </>
        )}
      </dl>
      {closing ? (
        tax.length > 0 && (
          <>
            <h3 className="pos-sub">{tr("Tax by rate")}</h3>
            <ul className="pos-taken">
              {tax.map((r, i) => (
                <li key={str(r.id) || i}>
                  <span>
                    {isolate(str(r.description))}
                    {num(r.rate) !== 0 ? ` ${isolate(formatDecimal(r.rate, 2))}%` : ""} <span className="faint">{tr("on {amount}", { amount: money(r.taxable_amount) })}</span>
                  </span>
                  <strong>{isolate(money(r.tax_amount))}</strong>
                </li>
              ))}
            </ul>
          </>
        )
      ) : (
        <p className="faint">{tr("Refunds and the tax by rate appear once the count is saved.")}</p>
      )}
    </section>
  );
}

/** Cash put into or taken out of the drawer during the shift: a float top-up, a payout for milk, a drop to the safe (the register's safe account, never more than the drawer holds). */
function Cash({ session, company, moves, money, onMoved }: { session: string; company: string; moves: Doc[]; money: (v: unknown) => string; onMoved: () => void }) {
  const [kind, setKind] = useState<"Cash In" | "Cash Out" | "Safe Drop">("Cash Out");
  const [amount, setAmount] = useState("");
  const [why, setWhy] = useState("");
  const [account, setAccount] = useState<{ id: string | null; title?: string }>({ id: null });
  const [busy, setBusy] = useState(false);
  const [slip, setSlip] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = typedAmount(amount);
  const drop = kind === "Safe Drop";
  const ok = value !== null && value > 0 && (drop || (!!why.trim() && !!account.id));
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await till(docPath("PosCashMovement"), { method: "POST", query: { submit: true }, body: movementBody({ session, kind, amount: value ?? 0, reason: why, account: account.id, date: localDate(new Date()) }) });
      toast(kind === "Cash In" ? tr("Cash put in") : kind === "Cash Out" ? tr("Cash taken out") : tr("Cash dropped to the safe"));
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
  // The slip is the server's template for a movement (`pos.cash_slip`), signed by hand.
  const printSlip = async (id: string) => {
    if (slip) return;
    setSlip(id);
    setError(null);
    try {
      printHtml(await paperOf("PosCashMovement", id, "pos.cash_slip"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSlip(null);
    }
  };
  const words = (k: string) => (k === "Cash In" ? tr("Paid in") : k === "Safe Drop" ? tr("Safe drop") : tr("Paid out"));
  return (
    <section className="pos-card" id="cash" aria-label={tr("Cash in and out")}>
      <h2>{tr("Cash in and out")}</h2>
      {moves.length === 0 ? (
        <p className="muted">{tr("Nothing has moved in or out of the drawer this shift.")}</p>
      ) : (
        <ul className="pos-taken">
          {moves.map((m, i) => (
            <li key={str(m.id) || i}>
              <span>
                {isolate(words(str(m.movement_type)))} <span className="faint">{isolate(str(m.reason))}</span>
                {!!m.id && (
                  <Button variant="ghost" icon="printer" loading={slip === str(m.id)} disabled={!!slip} onClick={() => void printSlip(str(m.id))}>
                    {tr("Print slip")}
                  </Button>
                )}
              </span>
              <strong>
                {m.movement_type === "Cash In" ? "+" : "−"}
                {isolate(money(m.amount))}
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
        <div className="segmented" role="group" aria-label={tr("In, out or to the safe")}>
          {(["Cash Out", "Cash In", "Safe Drop"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === "Cash In" ? tr("Put in") : k === "Safe Drop" ? tr("Drop to the safe") : tr("Take out")}
            </button>
          ))}
        </div>
        <Field label={tr("Amount")} htmlFor="cash-amount" hint={drop ? tr("Never more than the drawer holds.") : undefined}>
          <input id="cash-amount" className="input" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {!drop && (
          <Field label={kind === "Cash In" ? tr("Where it came from") : tr("What it was for")} htmlFor="cash-account" required hint={kind === "Cash In" ? tr("The safe or bank account the cash came from.") : tr("The expense account it is booked to.")}>
            <LinkInput to="Account" id="cash-account" value={account.id} title={account.title} onChange={(id, title) => setAccount({ id, title })} linkFilters={{ is_group: false, company }} />
          </Field>
        )}
        <Field label={tr("Reason")} htmlFor="cash-reason" required={!drop} hint={drop ? tr("Goes to the register's safe account. A reason is optional.") : undefined}>
          <input id="cash-reason" className="input" autoComplete="off" value={why} onChange={(e) => setWhy(e.target.value)} placeholder={drop ? tr("End of the lunch rush") : tr("Milk for the staff room")} />
        </Field>
        {error && <Alert tone="error">{isolate(error)}</Alert>}
        <Button type="submit" variant="primary" loading={busy} disabled={!ok}>
          {words(kind)} {value ? money(value) : ""}
        </Button>
      </form>
    </section>
  );
}
