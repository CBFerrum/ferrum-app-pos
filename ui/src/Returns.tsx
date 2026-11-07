// The return desk: take goods back without leaving the till. Find the sale (by receipt number or
// customer: any cashier's, since the customer comes to whichever till is free), pick the lines and
// how many come back, say why, and refund the way the sale was paid. The server's rules are shown
// before it would refuse them: what is left on each line, what the customer still owes (cancelled
// first), points going back as points, and only what came in as money going back as money. Loaded
// when first asked for, and needing the server: the sale being returned is read from it.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Plus } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { docPath, errorMessage, newKey, t } from "@ferrum/client";
import { Alert, Badge, Button, Dialog, EmptyState, ErrorState, Field, PageLoading, useDebounced } from "@ferrum/kit";
import type { Doc } from "@ferrum/records";
import { Currency, num, str, useMoney } from "./fmt";
import { till } from "./lib/offline";
import { pointsValue } from "./lib/pay";
import { receiptHtml, withMethodNames } from "./lib/pos";
import { checkRefund, REASONS, refundPayments, refundPlan, returnBody, returnItems, type Found, type Picks, type RefundRow, type Sheet } from "./lib/returns";
import { printHtml } from "./print";

const when = (day: string, time: string | null) => {
  const d = new Date(`${day}T${time && /^\d\d:\d\d/.test(time) ? time.slice(0, 8) : "00:00:00"}`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
};

export default function ReturnDesk({ profile, session, onClose, onDone }: { profile: Doc; session: string; onClose: () => void; onDone: (receipt: Doc) => void }) {
  const [sale, setSale] = useState<string | null>(null);
  return (
    <Dialog open wide onClose={onClose} title={t("Return goods")}>
      {sale ? <Sale profile={profile} session={session} sale={sale} onBack={() => setSale(null)} onDone={onDone} /> : <Find profile={profile} onPick={setSale} onClose={onClose} />}
    </Dialog>
  );
}

function Find({ profile, onPick, onClose }: { profile: Doc; onPick: (id: string) => void; onClose: () => void }) {
  const money = useMoney();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 300);
  const found = useQuery({
    queryKey: ["pos", "returns", str(profile.id), q],
    queryFn: ({ signal }) => till<{ rows: Found[] }>("/api/app/pos/returns", { query: { profile: str(profile.id), q: q || undefined }, signal }),
    staleTime: 0,
  });
  return (
    <div className="pos-returns">
      <Field label={t("Receipt number or customer")} htmlFor="return-find" hint={q ? "Sales of the last 90 days that match." : "Today's sales. Type to look further back."}>
        <input id="return-find" className="input pos-amount" data-autofocus autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("C1-2026-27-000123, or a name")} />
      </Field>
      {found.error ? (
        <ErrorState error={found.error} onRetry={() => void found.refetch()} />
      ) : !found.data ? (
        <PageLoading label={t("Looking for sales…")} />
      ) : found.data.rows.length === 0 ? (
        <EmptyState title={q ? "No sale matches" : "No sales yet today"} icon="search">
          {q ? "Check the number on the receipt, or try the customer's name." : "Type the receipt number or the customer's name to find an older sale."}
        </EmptyState>
      ) : (
        <ul className="pos-found" aria-label={t("Sales")}>
          {found.data.rows.map((r) => (
            <li key={r.id}>
              <button type="button" className="pos-found-row" disabled={!!r.blocked} onClick={() => onPick(r.id)}>
                <span className="pos-found-main">
                  <strong>{r.number ?? "Sale"}</strong>
                  <span className="muted">
                    {when(r.posting_date, r.posting_time)} · {r.customer ?? "Walk-in"} {t("· sold by")} {r.cashier ?? "—"}
                    {r.register ? ` at ${r.register}` : ""}
                  </span>
                  {r.blocked && <span className="pos-found-why">{t("Cannot be returned yet: {blocked}.", { blocked: r.blocked })}</span>}
                </span>
                <span className="pos-found-total">{money(r.total)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="pos-sticky">
        <span className="spacer" />
        <Button onClick={onClose}>{t("Close")}</Button>
      </div>
    </div>
  );
}

export function Sale({ profile, session, sale, onBack, onDone }: { profile: Doc; session: string; sale: string; onBack: () => void; onDone: (receipt: Doc) => void }) {
  const qc = useQueryClient();
  const money = useMoney();
  const { precision } = useContext(Currency);
  const profileId = str(profile.id);
  const sheet = useQuery({
    queryKey: ["pos", "return-sheet", profileId, sale],
    queryFn: ({ signal }) => till<Sheet>(`/api/app/pos/returns/${encodeURIComponent(sale)}`, { query: { profile: profileId }, signal }),
    staleTime: 0,
  });
  const [picks, setPicks] = useState<Picks>({});
  const [reason, setReason] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [points, setPoints] = useState("");
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ json: string; key: string } | null>(null);

  const data = sheet.data;
  const items = useMemo(() => (data ? returnItems(data, picks) : []), [data, picks]);
  const preview = useQuery({
    queryKey: ["pos", "return-calc", sale, JSON.stringify(items)],
    enabled: !!data && items.length > 0,
    queryFn: ({ signal }) => till<Doc>(docPath("PosInvoice", "_calc"), { method: "POST", body: returnBody({ profile: profileId, session, sale, items }), signal }),
    staleTime: 0,
  });
  const total = items.length ? Math.max(0, -num(preview.data?.rounded_total ?? preview.data?.grand_total)) : 0;
  const settled = items.length > 0 && !preview.isFetching && !!preview.data;

  // The refunds start where the plan puts them each time what is returned changes; the cashier may then change them.
  const plan = useMemo(() => (data && total > 0 ? refundPlan(total, data, precision) : { rows: [] as RefundRow[], problem: null as string | null }), [data, total, precision]);
  useEffect(() => {
    setAmounts(Object.fromEntries(plan.rows.filter((r) => !r.points).map((r) => [r.mode, String(r.amount)])));
    setPoints(String(plan.rows.find((r) => r.points)?.points ?? ""));
  }, [plan]);

  const methods = data?.methods ?? [];
  const rows: RefundRow[] = [];
  for (const m of methods) {
    if (!m.usable) continue;
    if (m.kind === "Loyalty Points") {
      const n = Math.floor(num(points));
      if (n > 0 && data?.loyalty) rows.push({ mode: m.mode, amount: pointsValue(n, num(data.loyalty.factor), precision), points: n });
    } else if (num(amounts[m.mode]) > 0) rows.push({ mode: m.mode, amount: num(amounts[m.mode]) });
  }
  const problem = data && total > 0 ? checkRefund(total, rows, data, precision) : null;
  const why = data?.blocked ? `Cannot be returned yet: ${data.blocked}.` : null;
  const ready = !!data && !data.blocked && settled && total > 0 && !problem && !plan.problem && reason.trim() !== "" && !busy;

  const setQty = (id: string, qty: number, left: number) => setPicks((p) => ({ ...p, [id]: { qty: Math.max(0, Math.min(left, qty)), serials: [] } }));
  const toggleSerial = (id: string, serial: string, all: string[]) =>
    setPicks((p) => {
      const now = p[id]?.serials ?? [];
      const serials = all.filter((s) => (s === serial ? !now.includes(s) : now.includes(s)));
      return { ...p, [id]: { qty: serials.length, serials } };
    });

  const refund = async () => {
    if (!data) return;
    setBusy(true);
    setError(null);
    const base = returnBody({ profile: profileId, session, sale, reason, items, payments: refundPayments(rows, refs) });
    // The same return sent again is the same return; a changed one is a new one.
    const json = JSON.stringify(base);
    if (attempt.current?.json !== json) attempt.current = { json, key: newKey() };
    const key = attempt.current.key;
    try {
      const done = await till<Doc>(docPath("PosInvoice"), { method: "POST", body: { ...base, id: key }, query: { submit: true }, idempotencyKey: key });
      void qc.invalidateQueries({ queryKey: ["list", "PosInvoice"] });
      onDone(withMethodNames(profile, { ...done, is_return: true, against: data.sale.number }));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  if (sheet.error) return <ErrorState error={sheet.error} onRetry={() => void sheet.refetch()} />;
  if (!data) return <PageLoading label={t("Opening the sale…")} />;
  return (
    <div className="pos-returns">
      <div className="pos-return-head">
        <Button icon="left" onClick={onBack} disabled={busy}>
          {t("Other sales")}
        </Button>
        <div>
          <strong>{data.sale.number}</strong>
          <span className="muted">
            {" "}
            · {data.sale.posting_date} · {data.sale.customer_name ?? "Walk-in"} {t("· sold by")} {data.sale.cashier ?? "—"}
          </span>
        </div>
        <span className="spacer" />
        <Button icon="printer" onClick={() => printHtml(receiptHtml(profile, data.receipt))}>
          {t("Copy of the receipt")}
        </Button>
      </div>
      {why && <Alert tone="warning">{why}</Alert>}

      <h3 className="pos-sub">{t("What comes back")}</h3>
      <ul className="pos-return-lines">
        {data.lines.map((l) => {
          const left = num(l.left);
          const pick = picks[l.id];
          return (
            <li key={l.id}>
              <div className="pos-return-line">
                <strong>{l.item_name}</strong>
                <span className="muted">
                  sold {l.sold}
                  {num(l.returned) > 0 ? ` · ${l.returned} already returned` : ""}
                  {l.rate ? ` · ${money(l.rate)} each` : ""}
                </span>
                {l.note && <span className="faint">{l.note}</span>}
              </div>
              {left <= 0 ? (
                <Badge tone="neutral">{t("All returned")}</Badge>
              ) : l.serials.length > 0 ? (
                <div className="pos-serials" role="group" aria-label={`Serial numbers of ${l.item_name}`}>
                  {l.serials.map((s) => (
                    <button key={s} type="button" className="pos-method" aria-pressed={!!pick?.serials.includes(s)} onClick={() => toggleSerial(l.id, s, l.serials)}>
                      {s}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="pos-qty">
                  <Button className="pos-step" aria-label={`One less ${l.item_name}`} disabled={!pick?.qty} onClick={() => setQty(l.id, (pick?.qty ?? 0) - 1, left)}>
                    <Minus className="size-4" aria-hidden="true" />
                  </Button>
                  <input
                    className="input pos-qty-box"
                    inputMode="decimal"
                    aria-label={`How many ${l.item_name} come back`}
                    value={pick?.qty ?? 0}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setQty(l.id, Number(e.target.value) || 0, left)}
                  />
                  <Button className="pos-step" aria-label={`One more ${l.item_name}`} disabled={(pick?.qty ?? 0) >= left} onClick={() => setQty(l.id, (pick?.qty ?? 0) + 1, left)}>
                    <Plus className="size-4" aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" onClick={() => setQty(l.id, left, left)}>
                    {t("All {left}", { left: l.left })}
                  </Button>
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <Field label={t("Why are they coming back?")} htmlFor="return-reason" required hint={t("Kept with the return and shown in the returns report.")}>
        <input id="return-reason" className="input" maxLength={140} autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="pos-quick" role="group" aria-label={t("Common reasons")}>
        {REASONS.map((r) => (
          <Button key={r} onClick={() => setReason(r)}>
            {r}
          </Button>
        ))}
      </div>

      <h3 className="pos-sub">{t("Refund")}</h3>
      {items.length === 0 ? (
        <p className="muted">{t("Choose what comes back to see the refund.")}</p>
      ) : preview.error ? (
        <Alert tone="error">{errorMessage(preview.error)}</Alert>
      ) : !settled ? (
        <p className="muted">{t("Working out the refund…")}</p>
      ) : (
        <>
          <p className="pos-due">
            <span className="muted">{t("To refund")}</span>
            <strong>{money(total)}</strong>
          </p>
          {num(data.refundable.credit) > 0 && <p className="faint pos-hint">{t("The customer still owes")} {money(data.refundable.credit)} {t("on this sale: that is cancelled first, before anything is paid out.")}</p>}
          <ul className="pos-refunds">
            {methods.map((m) => {
              const amount = m.kind === "Loyalty Points" ? pointsValue(Math.floor(num(points)), num(data.loyalty?.factor), precision) : num(amounts[m.mode]);
              return (
                <li key={m.mode} data-off={!m.usable || undefined}>
                  <label htmlFor={`refund-${m.mode}`}>
                    {m.name}
                    {!m.usable && <span className="faint"> · {m.why ?? "not at this register"}</span>}
                  </label>
                  {!m.usable ? null : m.kind === "Credit" ? (
                    <span className="pos-refund-fixed">{money(amounts[m.mode] ?? 0)}</span>
                  ) : m.kind === "Loyalty Points" ? (
                    data.loyalty ? (
                      <span className="pos-refund-in">
                        <input
                          id={`refund-${m.mode}`}
                          className="input"
                          inputMode="numeric"
                          aria-label={t("Points to give back")}
                          value={points}
                          onChange={(e) => setPoints(e.target.value.replace(/\D/g, ""))}
                        />
                        <span className="muted">{t("points =")} {money(amount)} {t("(up to {points_left})", { points_left: data.loyalty.points_left })}</span>
                      </span>
                    ) : (
                      <span className="faint">{t("none were used")}</span>
                    )
                  ) : (
                    <span className="pos-refund-in">
                      <input id={`refund-${m.mode}`} className="input" inputMode="decimal" value={amounts[m.mode] ?? ""} placeholder="0" onChange={(e) => setAmounts((a) => ({ ...a, [m.mode]: e.target.value }))} />
                      {(m.kind === "Bank" || m.kind === "General") && num(amounts[m.mode]) > 0 && (
                        <input className="input" aria-label={`${m.name} reference`} placeholder={t("Reference")} value={refs[m.mode] ?? ""} onChange={(e) => setRefs((r) => ({ ...r, [m.mode]: e.target.value }))} />
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {(plan.problem || problem) && (
            <p className="pos-error" role="alert">
              {plan.problem ?? problem}
            </p>
          )}
        </>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <div className="pos-sticky">
        <span className="spacer" />
        <Button onClick={onBack} disabled={busy}>
          {t("Back")}
        </Button>
        <Button variant="primary" className="pos-btn" disabled={!ready} loading={busy} onClick={() => void refund()}>
          {total > 0 ? `Refund ${money(total)}` : "Refund"}
        </Button>
      </div>
    </div>
  );
}
