// The return desk: take goods back without leaving the till. Find the sale (by receipt number or
// customer: any cashier's, since the customer comes to whichever till is free), pick the lines and
// how many come back, say why, and refund the way the sale was paid. The server's rules are shown
// before it would refuse them: what is left on each line, what the customer still owes (cancelled
// first), points going back as points, and only what came in as money going back as money; what a
// card paid goes back onto stored value (a card's code, or a new store credit the server makes). A
// refund beyond the cashier's limit asks another person's approval first. Returns without a receipt
// and exchanges are Unreceipted.tsx. Loaded when first asked for, and needing the server: the sale
// being returned is read from it.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Plus } from "lucide-react";
import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from "react";
import { docPath, errorMessage, newKey, t, isolate } from "@ferrum/client";
import { Alert, Badge, Button, Dialog, Field, useDebounced, placed, FormSkeleton, ListSkeleton, StatePanel } from "@ferrum/kit";
import { Problem } from "./ui";
import type { Doc } from "@ferrum/records";
import { useAsk } from "./Approval";
import { CardInputs, CodeOnce, makeCode } from "./Card";
import { Currency, num, str, useMoney } from "./fmt";
import { till } from "./lib/offline";
import { pointsValue } from "./lib/pay";
import { withMethodNames } from "./lib/pos";
import { checkRefund, REASONS, refundPayments, refundPlan, returnBody, returnItems, type CardProof, type Found, type Picks, type RefundRow, type Sheet } from "./lib/returns";
import { allows, asksFor, type Approval, type Limits } from "./lib/rights";
import { codeOk } from "./lib/stored";
import { useReprint } from "./ReceiptMore";

// Returns without a receipt and exchanges load only when chosen.
const Unreceipted = lazy(() => import("./Unreceipted"));

export interface DeskProps {
  profile: Doc;
  session: string;
  modes: Doc[];
  limits: Limits;
  reasons: Doc[];
}

const when = (day: string, time: string | null) => {
  const d = new Date(`${day}T${time && /^\d\d:\d\d/.test(time) ? time.slice(0, 8) : "00:00:00"}`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
};

export default function ReturnDesk({ onClose, onDone, ...desk }: DeskProps & { onClose: () => void; onDone: (receipt: Doc) => void }) {
  const [sale, setSale] = useState<string | null>(null);
  const [other, setOther] = useState<"return" | "exchange" | null>(null);
  const back = () => (setSale(null), setOther(null));
  return (
    <Dialog open wide onClose={onClose} title={other === "exchange" ? t("Exchange goods") : other ? t("Return without a receipt") : t("Return goods")}>
      {other ? (
        <Suspense fallback={<ListSkeleton rows={4} />}>
          <Unreceipted {...desk} mode={other} onBack={back} onDone={onDone} />
        </Suspense>
      ) : sale ? (
        <Sale {...desk} sale={sale} onBack={back} onDone={onDone} />
      ) : (
        <Find profile={desk.profile} onPick={setSale} onOther={setOther} onClose={onClose} />
      )}
    </Dialog>
  );
}

function Find({ profile, onPick, onOther, onClose }: { profile: Doc; onPick: (id: string) => void; onOther: (m: "return" | "exchange") => void; onClose: () => void }) {
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
      <Field label={t("Receipt number or customer")} htmlFor="return-find" hint={q ? t("Sales of the last 90 days that match.") : t("Today's sales. Type to look further back.")}>
        <input id="return-find" className="input pos-amount" data-autofocus autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("C1-2026-27-000123, or a name")} />
      </Field>
      {found.error ? (
        <Problem error={found.error} onRetry={() => void found.refetch()} />
      ) : !found.data ? (
        <ListSkeleton rows={4} />
      ) : found.data.rows.length === 0 ? (
        <StatePanel kind={q ? "no-matches" : "empty"} title={q ? t("No sale matches") : t("No sales yet today")} onClear={q ? () => setText("") : undefined} clearLabel={t("Clear the search")}>
          {q ? t("Check the number on the receipt, or try the customer's name.") : t("Type the receipt number or the customer's name to find an older sale.")}
        </StatePanel>
      ) : (
        <ul className="pos-found" aria-label={t("Sales")}>
          {found.data.rows.map((r) => (
            <li key={r.id}>
              <button type="button" className="pos-found-row" disabled={!!r.blocked} onClick={() => onPick(r.id)}>
                <span className="pos-found-main">
                  <strong>{r.number ?? t("Sale")}</strong>
                  <span className="muted">
                    {isolate(when(r.posting_date, r.posting_time))} · {r.customer ?? t("Walk-in")} {t("· sold by")} {r.cashier ?? "—"}
                    {r.register ? t(" at {register}", { register: r.register }) : ""}
                  </span>
                  {r.blocked && <span className="pos-found-why">{t("Cannot be returned yet: {blocked}.", { blocked: r.blocked })}</span>}
                </span>
                <span className="pos-found-total">{isolate(money(r.total))}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="pos-sticky">
        <Button disabled={!profile.return_policy} onClick={() => onOther("return")}>
          {t("Return without a receipt")}
        </Button>
        <Button disabled={!profile.return_policy} onClick={() => onOther("exchange")}>
          {t("Exchange")}
        </Button>
        {!profile.return_policy && <span className="faint">{t("This register has no return policy.")}</span>}
        <span className="spacer" />
        <Button onClick={onClose}>{t("Close")}</Button>
      </div>
    </div>
  );
}

export function Sale({ profile, session, modes, limits, reasons, sale, onBack, onDone }: DeskProps & { sale: string; onBack: () => void; onDone: (receipt: Doc) => void }) {
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
  // A card's code and PIN, for the refund onto it: in memory, sent with the return, never kept.
  const [cards, setCards] = useState<Record<string, CardProof>>({});
  const [made, setMade] = useState<string | null>(null);
  const [approved, setApproved] = useState<{ key: string; list: Approval[] }>({ key: "", list: [] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ json: string; key: string } | null>(null);
  const asker = useAsk(profileId, () => false);
  // A copy of the sale's receipt is the server's: marked COPY, counted, and asked for with the reason and approval the register wants.
  const copies = useReprint(profile, limits, reasons, false);

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
  const why = data?.blocked ? t("Cannot be returned yet: {blocked}.", { blocked: data.blocked }) : null;
  const cardless = rows.some((r) => methods.find((m) => m.mode === r.mode)?.kind === "Stored Value" && !codeOk(cards[r.mode]?.code ?? ""));
  const ready = !!data && !data.blocked && settled && total > 0 && !problem && !plan.problem && reason.trim() !== "" && !cardless && !busy;

  const setQty = (id: string, qty: number, left: number) => setPicks((p) => ({ ...p, [id]: { qty: Math.max(0, Math.min(left, qty)), serials: [] } }));
  const toggleSerial = (id: string, serial: string, all: string[]) =>
    setPicks((p) => {
      const now = p[id]?.serials ?? [];
      const serials = all.filter((s) => (s === serial ? !now.includes(s) : now.includes(s)));
      return { ...p, [id]: { qty: serials.length, serials } };
    });

  const refund = () => {
    if (!data) return;
    const base = returnBody({ profile: profileId, session, sale, reason, items, payments: refundPayments(rows, refs, cards) });
    // The same return sent again is the same return; a changed one is a new one.
    const json = JSON.stringify(base);
    if (attempt.current?.json !== json) attempt.current = { json, key: newKey() };
    const key = attempt.current.key;
    const have = approved.key === key ? approved.list : [];
    // A refund beyond the cashier's limit needs another person's approval, for this return's own id.
    const need = allows(limits, "Refund", total) ? [] : asksFor([{ line: 0, act: "Refund", figure: total, why: t("a refund of {total} is more than you may give", { total: money(total) }) }], have);
    if (!need.length) return void send(base, key, have);
    asker.ask({
      title: t("Approval for this refund"),
      sale: key,
      steps: need,
      done: (got) => {
        setApproved({ key, list: [...have, ...got] });
        void send(base, key, [...have, ...got]);
      },
    });
  };
  const send = async (base: Doc, key: string, ap: Approval[]) => {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      const body = { ...base, id: key, ...(ap.length ? { approvals: ap.map((a) => ({ approval: a.id })) } : {}) };
      const done = await till<Doc>(docPath("PosInvoice"), { method: "POST", body, query: { submit: true }, idempotencyKey: key });
      void qc.invalidateQueries({ queryKey: ["list", "PosInvoice"] });
      onDone(withMethodNames(profile, { ...done, is_return: true, against: data.sale.number }));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  if (sheet.error) return <Problem error={sheet.error} onRetry={() => void sheet.refetch()} />;
  if (!data) return <FormSkeleton fields={4} />;
  return (
    <div className="pos-returns">
      <div className="pos-return-head">
        <Button icon="left" onClick={onBack} disabled={busy}>
          {t("Other sales")}
        </Button>
        <div>
          <strong>{isolate(data.sale.number ?? "")}</strong>
          <span className="muted">
            {isolate(" ")}
            · {isolate(data.sale.posting_date)} · {data.sale.customer_name ?? t("Walk-in")} {t("· sold by")} {data.sale.cashier ?? "—"}
          </span>
        </div>
        <span className="spacer" />
        <Button icon="printer" disabled={copies.busy || busy} onClick={() => copies.copy(data.sale.id, data.sale.number ?? "")}>
          {t("Copy of the receipt")}
        </Button>
      </div>
      {why && <Alert tone="warning">{isolate(why)}</Alert>}
      {copies.note && <Alert tone={copies.note.tone}>{isolate(copies.note.text)}</Alert>}
      {copies.asker.node}

      <h3 className="pos-sub">{t("What comes back")}</h3>
      <ul className="pos-return-lines">
        {data.lines.map((l) => {
          const left = num(l.left);
          const pick = picks[l.id];
          return (
            <li key={l.id}>
              <div className="pos-return-line">
                <strong>{isolate(l.item_name)}</strong>
                <span className="muted">
                  {(num(l.returned) > 0 ? (l.rate ? t("sold {sold} · {returned} already returned · {value} each", { sold: l.sold, returned: l.returned, value: money(l.rate) }) : t("sold {sold} · {returned} already returned", { sold: l.sold, returned: l.returned })) : (l.rate ? t("sold {sold} · {value} each", { sold: l.sold, value: money(l.rate) }) : t("sold {sold}", { sold: l.sold })))}
                </span>
                {l.note && <span className="faint">{isolate(l.note)}</span>}
              </div>
              {left <= 0 ? (
                <Badge tone="neutral">{t("All returned")}</Badge>
              ) : l.serials.length > 0 ? (
                <div className="pos-serials" role="group" aria-label={t("Serial numbers of {item_name}", { item_name: l.item_name })}>
                  {l.serials.map((s) => (
                    <button key={s} type="button" className="pos-method" aria-pressed={!!pick?.serials.includes(s)} onClick={() => toggleSerial(l.id, s, l.serials)}>
                      {isolate(s)}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="pos-qty">
                  <Button className="pos-step" aria-label={t("One less {item_name}", { item_name: l.item_name })} disabled={!pick?.qty} onClick={() => setQty(l.id, (pick?.qty ?? 0) - 1, left)}>
                    <Minus className="size-4" aria-hidden="true" />
                  </Button>
                  <input
                    className="input pos-qty-box"
                    inputMode="decimal"
                    aria-label={t("How many {item_name} come back", { item_name: l.item_name })}
                    value={pick?.qty ?? 0}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setQty(l.id, Number(e.target.value) || 0, left)}
                  />
                  <Button className="pos-step" aria-label={t("One more {item_name}", { item_name: l.item_name })} disabled={(pick?.qty ?? 0) >= left} onClick={() => setQty(l.id, (pick?.qty ?? 0) + 1, left)}>
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
            {isolate(r)}
          </Button>
        ))}
      </div>

      <h3 className="pos-sub">{t("Refund")}</h3>
      {items.length === 0 ? (
        <p className="muted">{t("Choose what comes back to see the refund.")}</p>
      ) : preview.error ? (
        <Alert tone="error">{isolate(errorMessage(preview.error))}</Alert>
      ) : !settled ? (
        <p className="muted">{t("Working out the refund…")}</p>
      ) : (
        <>
          <p className="pos-due">
            <span className="muted">{t("To refund")}</span>
            <strong>{isolate(money(total))}</strong>
          </p>
          {num(data.refundable.credit) > 0 && <p className="faint pos-hint">{placed(t("The customer still owes {p1} on this sale: that is cancelled first, before anything is paid out."), { p1: isolate(money(data.refundable.credit)) })}</p>}
          <ul className="pos-refunds">
            {methods.map((m) => {
              const amount = m.kind === "Loyalty Points" ? pointsValue(Math.floor(num(points)), num(data.loyalty?.factor), precision) : num(amounts[m.mode]);
              return (
                <li key={m.mode} data-off={!m.usable || undefined}>
                  <label htmlFor={`refund-${m.mode}`}>
                    {isolate(m.name)}
                    {!m.usable && <span className="faint"> · {m.why ?? t("not at this register")}</span>}
                  </label>
                  {!m.usable ? null : m.kind === "Stored Value" ? (
                    <span className="pos-refund-in">
                      <input id={`refund-${m.mode}`} className="input" inputMode="decimal" value={amounts[m.mode] ?? ""} placeholder="0" onChange={(e) => setAmounts((a) => ({ ...a, [m.mode]: e.target.value }))} />
                      {num(amounts[m.mode]) > 0 && (
                        <span className="pos-card">
                          <CardInputs
                            id={`refund-card-${m.mode}`}
                            code={cards[m.mode]?.code ?? ""}
                            pin={cards[m.mode]?.pin ?? ""}
                            onCode={(code) => setCards((c) => ({ ...c, [m.mode]: { ...c[m.mode], code } }))}
                            onPin={(pin) => setCards((c) => ({ ...c, [m.mode]: { code: c[m.mode]?.code ?? "", pin } }))}
                          />
                          <Button
                            disabled={!modes.find((x) => x.id === m.mode)?.stored_value_kind}
                            onClick={() =>
                              void makeCode(str(modes.find((x) => x.id === m.mode)?.stored_value_kind))
                                .then((code) => (setCards((c) => ({ ...c, [m.mode]: { ...c[m.mode], code } })), setMade(code)))
                                .catch((e: unknown) => setError(errorMessage(e)))
                            }
                          >
                            {t("New store credit")}
                          </Button>
                        </span>
                      )}
                    </span>
                  ) : m.kind === "Credit" ? (
                    <span className="pos-refund-fixed">{isolate(money(amounts[m.mode] ?? 0))}</span>
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
                        <span className="muted">{t("points =")} {isolate(money(amount))} {t("(up to {points_left})", { points_left: data.loyalty.points_left })}</span>
                      </span>
                    ) : (
                      <span className="faint">{t("none were used")}</span>
                    )
                  ) : (
                    <span className="pos-refund-in">
                      <input id={`refund-${m.mode}`} className="input" inputMode="decimal" value={amounts[m.mode] ?? ""} placeholder="0" onChange={(e) => setAmounts((a) => ({ ...a, [m.mode]: e.target.value }))} />
                      {(m.kind === "Bank" || m.kind === "General") && num(amounts[m.mode]) > 0 && (
                        <input className="input" aria-label={t("{name} reference", { name: m.name })} placeholder={t("Reference")} value={refs[m.mode] ?? ""} onChange={(e) => setRefs((r) => ({ ...r, [m.mode]: e.target.value }))} />
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
      {error && <Alert tone="error">{isolate(error)}</Alert>}
      <div className="pos-sticky">
        <span className="spacer" />
        <Button onClick={onBack} disabled={busy}>
          {t("Back")}
        </Button>
        <Button variant="primary" className="pos-btn" disabled={!ready} loading={busy} onClick={refund}>
          {total > 0 ? t("Refund {total}", { total: money(total) }) : t("Refund")}
        </Button>
      </div>
      {asker.node}
      {made && <CodeOnce profile={profile} code={made} onClose={() => setMade(null)} />}
    </div>
  );
}
