// Goods that come back with no receipt, and exchanges: the return desk's other two doors. A return
// that names no sale (a customer if they give one; items scanned or searched; each line's condition,
// which says the warehouse it goes to and the restocking fee) is priced by the register's return
// policy, and the price and fee are shown before it is confirmed: they are the server's (`_calc`),
// the fee from the policy. It is refunded as the policy allows, store credit by default (a card's
// code, or a new store credit the server makes, shown once). An exchange is one flow, what comes back
// and what goes out and the one difference to pay or refund, sent as one transaction (`/exchange`).
// Both need the connection (the price, the approval and the store credit are the server's), and a
// person whose limits do not allow a return without a receipt, or a refund this size, gets another
// person's approval first.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Plus } from "lucide-react";
import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { docPath, errorMessage, newKey, t, isolate } from "@ferrum/client";
import { Alert, Button, Field, useDebounced } from "@ferrum/kit";
import { LinkInput, type Doc } from "@ferrum/records";
import { useAsk } from "./Approval";
import { CardInputs, CodeOnce, makeCode } from "./Card";
import type { DeskProps } from "./Returns";
import { num, str, titleOf, useMoney } from "./fmt";
import { till } from "./lib/offline";
import { exchange as sendExchange } from "./lib/server";
import { addItem, invoiceBody, paymentRows, setQty as setCartQty, withMethodNames, type CartLine } from "./lib/pos";
import { backItems, CONDITIONS, enteredPriceProblem, exchange, parsePolicy, refundPayments, restockingFee, unreceiptedBody, type BackLine, type CardProof, type Condition } from "./lib/returns";
import { allows, asksFor, type Approval, type Ask } from "./lib/rights";
import { codeOk } from "./lib/stored";

interface Picked {
  id: string;
  name: string;
}

/** Scan a code or search by name; a code that names one item adds it, otherwise the matches are listed to tap. */
function Finder({ label, onPick }: { label: string; onPick: (item: Picked, qty: number) => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 250);
  const found = useQuery({
    queryKey: ["pos", "find-item", q],
    enabled: q.length > 0,
    queryFn: ({ signal }) =>
      till<{ rows: Doc[] }>(docPath("Item"), { query: { search: q, fields: "id,item_code,item_name,barcode", filters: JSON.stringify({ disabled: false }), limit: 8 }, signal }),
    staleTime: 30_000,
  });
  const name = (r: Doc) => str(r.item_name) || str(r.item_code);
  const rows = found.data?.rows ?? [];
  const pick = (r: Doc, qty = 1) => (onPick({ id: str(r.id), name: name(r) }, qty), setText(""));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const code = text.trim();
    if (!code) return;
    try {
      // A pack barcode (a case of six scans as six), else an exact barcode or code, else the only match.
      const packs = await till<{ rows: Doc[] }>(docPath("ItemBarcode"), { query: { filters: JSON.stringify({ barcode: code }), fields: "item,qty", titles: true, limit: 1 } });
      const pack = packs.rows[0];
      if (pack) return void (onPick({ id: str(pack.item), name: titleOf(pack, "item") }, num(pack.qty) || 1), setText(""));
    } catch {
      // packs are an extra: the search below still answers
    }
    const exact = rows.filter((r) => str(r.barcode) === code || str(r.item_code).toLowerCase() === code.toLowerCase());
    const one = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : undefined;
    if (one) pick(one);
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="pos-returns">
      <Field label={label} htmlFor={id} hint={t("Scan a barcode, or type a name and tap the item.")}>
        <input id={id} className="input" autoComplete="off" autoCapitalize="off" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      {q && rows.length > 0 && (
        <ul className="pos-found" aria-label={t("Items")}>
          {rows.map((r) => (
            <li key={str(r.id)}>
              <button type="button" className="pos-found-row" onClick={() => pick(r)}>
                <span className="pos-found-main">
                  <strong>{isolate(name(r))}</strong>
                  <span className="faint">{isolate(str(r.item_code))}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {q && found.data && rows.length === 0 && <p className="muted">{t("Nothing matches “{text}”", { text: q })}</p>}
      <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
    </form>
  );
}

function Qty({ name, qty, onChange }: { name: string; qty: number; onChange: (qty: number) => void }) {
  return (
    <span className="pos-qty">
      <Button className="pos-step" aria-label={t("One less {item_name}", { item_name: name })} onClick={() => onChange(qty - 1)}>
        <Minus className="size-4" aria-hidden="true" />
      </Button>
      <input
        className="input pos-qty-box"
        inputMode="decimal"
        aria-label={t("Quantity of {label}", { label: name })}
        value={qty}
        onFocus={(e) => e.target.select()}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
      <Button className="pos-step" aria-label={t("One more {item_name}", { item_name: name })} onClick={() => onChange(qty + 1)}>
        <Plus className="size-4" aria-hidden="true" />
      </Button>
    </span>
  );
}

export default function Unreceipted({
  profile,
  session,
  modes,
  limits,
  reasons,
  mode,
  onBack,
  onDone,
}: DeskProps & { mode: "return" | "exchange"; onBack: () => void; onDone: (receipt: Doc) => void }) {
  const qc = useQueryClient();
  const money = useMoney();
  const profileId = str(profile.id);
  const policyId = str(profile.return_policy);
  const policyQ = useQuery({ queryKey: ["pos", "policy", policyId], enabled: !!policyId, queryFn: ({ signal }) => till<Doc>(docPath("PosReturnPolicy", policyId), { signal }), staleTime: 60_000 });
  const policy = useMemo(() => (policyQ.data ? parsePolicy(policyQ.data) : null), [policyQ.data]);
  const why = reasons.filter((r) => r.applies_to === "Return" && r.disabled !== true);

  const [customer, setCustomer] = useState<{ id: string | null; title?: string }>({ id: null });
  const [back, setBack] = useState<BackLine[]>([]);
  const [out, setOut] = useState<CartLine[]>([]);
  const [reason, setReason] = useState("");
  const [refundMode, setRefundMode] = useState("");
  const [payMode, setPayMode] = useState("");
  const [card, setCard] = useState<CardProof>({ code: "" });
  const [made, setMade] = useState<string | null>(null);
  const [approved, setApproved] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ json: string; back: string; out: string } | null>(null);
  const asker = useAsk(profileId, () => false);
  const exchanging = mode === "exchange";

  const methods = ((profile.payments as Doc[] | undefined) ?? []).map((r) => {
    const id = str(r.mode_of_payment);
    const m = modes.find((x) => x.id === id);
    return { id, name: titleOf(r, "mode_of_payment"), kind: str(m?.mode_type), card: str(m?.stored_value_kind) };
  });
  const refundable = methods.filter((m) => policy && (m.id === policy.store_credit || policy.refund_modes.includes(m.id)));
  const payable = methods.filter((m) => ["Cash", "Bank", "General"].includes(m.kind));
  const refundWith = refundMode || policy?.store_credit || refundable[0]?.id || "";
  const payWith = payMode || payable.find((m) => m.kind === "Cash")?.id || payable[0]?.id || "";
  const refundVia = methods.find((m) => m.id === refundWith);

  // The price and fee the policy gives, and what goes out, as the server works them out.
  const backBody = useMemo(
    () => (back.length && policy ? unreceiptedBody({ profile: profileId, session, customer: customer.id, reason: "", items: backItems(back, policy.price_basis) }) : null),
    [back, policy, profileId, session, customer.id],
  );
  const backCalc = useQuery({
    queryKey: ["pos", "unreceipted", JSON.stringify(backBody)],
    enabled: !!backBody,
    queryFn: ({ signal }) => till<Doc>(docPath("PosInvoice", "_calc"), { method: "POST", body: backBody, signal }),
    staleTime: 0,
  });
  const outBody = useMemo(() => (exchanging && out.length ? invoiceBody({ profile: profileId, session, customer: customer.id, lines: out, tenders: [] }) : null), [exchanging, out, profileId, session, customer.id]);
  const outCalc = useQuery({
    queryKey: ["pos", "exchange-out", JSON.stringify(outBody)],
    enabled: !!outBody,
    queryFn: ({ signal }) => till<Doc>(docPath("PosInvoice", "_calc"), { method: "POST", body: outBody, signal }),
    staleTime: 0,
  });
  const backSettled = !!backBody && !backCalc.isFetching && !!backCalc.data;
  const outSettled = !exchanging || (!!outBody && !outCalc.isFetching && !!outCalc.data);
  const backTotal = backSettled ? Math.max(0, -num(backCalc.data?.rounded_total ?? backCalc.data?.grand_total)) : 0;
  const outTotal = exchanging && outSettled ? num(outCalc.data?.rounded_total ?? outCalc.data?.grand_total) : 0;
  const split = exchanging ? exchange(backTotal, outTotal) : { carried: 0, due: 0, refund: backTotal };
  const priceProblem = back.map((l) => (policy ? enteredPriceProblem(policy.price_basis, l.price) : null)).find(Boolean) ?? null;
  const cardless = split.refund > 0 && refundVia?.kind === "Stored Value" && !codeOk(card.code);
  const ready =
    !!policy && back.length > 0 && backSettled && outSettled && (!exchanging || out.length > 0) && !priceProblem && !!reason && !cardless && !busy &&
    (split.refund > 0 ? !!refundWith : true) && (split.due > 0 ? !!payWith : true) && (exchanging || backTotal > 0);

  const lineOf = (i: number) => (backCalc.data?.items as Doc[] | undefined)?.[i];
  const patch = (key: string, p: Partial<BackLine>) => setBack((l) => l.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const submit = () => {
    if (!policy) return;
    const refunds = split.refund > 0 ? refundPayments([{ mode: refundWith, amount: split.refund }], {}, { [refundWith]: card }) : [];
    const draft = (ids: string[]) =>
      unreceiptedBody({ profile: profileId, session, customer: customer.id, reason, items: backItems(back, policy.price_basis), payments: refunds, ...(ids.length ? { approvals: ids } : {}) });
    const tender = split.due > 0 ? paymentRows([{ mode_of_payment: payWith, amount: String(split.due) }]) : [];
    const json = JSON.stringify([draft([]), out, tender]);
    if (attempt.current?.json !== json) attempt.current = { json, back: newKey(), out: newKey() };
    const ids = attempt.current;
    // A return without a receipt, and a refund this size, are beyond some cashiers' limits: another person approves, for this return's own id.
    const found: { line: number; act: Ask["act"]; figure: number; why: string }[] = [];
    if (!allows(limits, "Return Without Receipt")) found.push({ line: 0, act: "Return Without Receipt", figure: 0, why: t("you may not take returns without a receipt") });
    if (!allows(limits, "Refund", split.refund)) found.push({ line: 0, act: "Refund", figure: split.refund, why: t("a refund of {total} is more than you may give", { total: money(split.refund) }) });
    const have = approved;
    const need = asksFor(found, have);
    if (!need.length) return void send(draft, tender, ids, have);
    asker.ask({
      title: t("Approval for this return"),
      sale: ids.back,
      steps: need,
      done: (got) => {
        setApproved([...have, ...got]);
        void send(draft, tender, ids, [...have, ...got]);
      },
    });
  };

  const send = async (draft: (ids: string[]) => Doc, tender: Doc[], ids: { back: string; out: string }, ap: Approval[]) => {
    setBusy(true);
    setError(null);
    try {
      const half = { ...draft(ap.map((a) => a.id)), id: ids.back };
      if (!exchanging) {
        const done = await till<Doc>(docPath("PosInvoice"), { method: "POST", body: half, query: { submit: true }, idempotencyKey: ids.back });
        void qc.invalidateQueries({ queryKey: ["list", "PosInvoice"] });
        return onDone(withMethodNames(profile, { ...done, is_return: true }));
      }
      const sale = invoiceBody({ id: ids.out, profile: profileId, session, customer: customer.id, lines: out, tenders: [] });
      const res = await sendExchange(half, { ...sale, payments: tender }, ids.back);
      void qc.invalidateQueries({ queryKey: ["list", "PosInvoice"] });
      onDone(withMethodNames(profile, res.sale));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const both = (m: "return" | "exchange") => (m === "return" ? t("What comes back") : t("What goes out"));
  return (
    <div className="pos-returns">
      <div className="pos-return-head">
        <Button icon="left" onClick={onBack} disabled={busy}>
          {t("Other sales")}
        </Button>
        <p className="muted">{exchanging ? t("Goods back and goods out, with one difference to pay or refund. Needs the connection.") : t("Priced and refunded as the register's return policy says. Needs the connection.")}</p>
      </div>
      {policyQ.error && <Alert tone="error">{isolate(errorMessage(policyQ.error))}</Alert>}
      {policy && (
        <>
          <LinkInput to="Customer" value={customer.id} title={customer.title} onChange={(id, title) => setCustomer({ id, title })} label={t("Customer (if they give one)")} placeholder={t("Walk-in customer")} />

          <h3 className="pos-sub">{both("return")}</h3>
          <Finder label={t("Item coming back")} onPick={(i, qty) => setBack((l) => (l.some((x) => x.item === i.id) ? l.map((x) => (x.item === i.id ? { ...x, qty: x.qty + qty } : x)) : [...l, { key: newKey(), item: i.id, item_name: i.name, qty, condition: "Resaleable" }]))} />
          <ul className="pos-return-lines">
            {back.map((l, i) => {
              const priced = lineOf(i);
              const fee = restockingFee(policy.fees, l.condition);
              return (
                <li key={l.key}>
                  <div className="pos-return-line">
                    <strong>{isolate(l.item_name)}</strong>
                    <span className="muted">
                      {priced && backSettled
                        ? t("comes back at {price} each, less {fee}% restocking: {amount}", { price: money(priced.price_list_rate), fee: String(fee), amount: money(Math.abs(num(priced.amount))) })
                        : t("Working out the price…")}
                    </span>
                  </div>
                  <Qty name={l.item_name} qty={l.qty} onChange={(qty) => (qty > 0 ? patch(l.key, { qty }) : setBack((x) => x.filter((y) => y.key !== l.key)))} />
                  <label className="field">
                    <span className="field-label">{t("Condition")}</span>
                    <select className="input" value={l.condition} onChange={(e) => patch(l.key, { condition: e.target.value as Condition })}>
                      {CONDITIONS.map((c) => (
                        <option key={c} value={c}>
                          {c === "Resaleable" ? t("Resaleable") : c === "Damaged" ? t("Damaged") : t("Scrap")}
                        </option>
                      ))}
                    </select>
                  </label>
                  {policy.price_basis === "Entered" && (
                    <label className="field">
                      <span className="field-label">{t("Price it comes back at")}</span>
                      <input className="input" inputMode="decimal" value={l.price ?? ""} onChange={(e) => patch(l.key, { price: e.target.value })} />
                    </label>
                  )}
                  <Button variant="ghost" aria-label={t("Take {item_name} off the list", { item_name: l.item_name })} onClick={() => setBack((x) => x.filter((y) => y.key !== l.key))}>
                    {t("Remove")}
                  </Button>
                </li>
              );
            })}
          </ul>
          {priceProblem && <p className="pos-error" role="alert">{priceProblem}</p>}
          {backCalc.error && <Alert tone="error">{isolate(errorMessage(backCalc.error))}</Alert>}

          {exchanging && (
            <>
              <h3 className="pos-sub">{both("exchange")}</h3>
              <Finder label={t("Item going out")} onPick={(i, qty) => setOut((l) => addItem(l, i, qty, newKey()))} />
              <ul className="pos-return-lines">
                {out.map((l, i) => (
                  <li key={l.key}>
                    <div className="pos-return-line">
                      <strong>{isolate(l.item_name)}</strong>
                      <span className="muted">{(outCalc.data?.items as Doc[] | undefined)?.[i] && outSettled ? t("{value} each", { value: money((outCalc.data?.items as Doc[])[i].rate) }) : t("Working out the price…")}</span>
                    </div>
                    <Qty name={l.item_name} qty={l.qty} onChange={(qty) => setOut((x) => setCartQty(x, l.key, qty))} />
                  </li>
                ))}
              </ul>
              {outCalc.error && <Alert tone="error">{isolate(errorMessage(outCalc.error))}</Alert>}
            </>
          )}

          <Field label={t("Why are they coming back?")} htmlFor="unreceipted-reason" required hint={why.length ? t("One of the business's reasons; kept with the return.") : t("No reasons for returns are set up: ask a manager to add them.")}>
            <select id="unreceipted-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="" />
              {why.map((r) => (
                <option key={str(r.id)} value={str(r.id)}>
                  {str(r.reason)}
                </option>
              ))}
            </select>
          </Field>

          {back.length > 0 && backSettled && outSettled && (
            <>
              <h3 className="pos-sub">{exchanging ? t("The difference") : t("Refund")}</h3>
              <p className="pos-due">
                <span className="muted">{t("Coming back is worth")}</span>
                <strong>{isolate(money(backTotal))}</strong>
              </p>
              {exchanging && (
                <>
                  <p className="pos-due">
                    <span className="muted">{t("Going out is worth")}</span>
                    <strong>{isolate(money(outTotal))}</strong>
                  </p>
                  <p className="pos-status pos-status-due" aria-live="polite">
                    {split.due > 0 ? t("The customer pays {due}", { due: money(split.due) }) : split.refund > 0 ? t("The customer is refunded {refund}", { refund: money(split.refund) }) : t("Even: nothing to pay or refund")}
                  </p>
                </>
              )}
              {split.refund > 0 && (
                <>
                  <div className="pos-methods" role="group" aria-label={t("Refund to")}>
                    {refundable.map((m) => (
                      <button key={m.id} type="button" className="pos-method" aria-pressed={m.id === refundWith} onClick={() => (setRefundMode(m.id), setCard({ code: "" }))}>
                        {isolate(m.name)}
                        {m.id === policy.store_credit ? t(" (store credit)") : ""}
                      </button>
                    ))}
                  </div>
                  {refundVia?.kind === "Stored Value" && (
                    <div className="pos-card">
                      <p className="faint pos-hint">{t("Onto a card: scan its code, or have the server make a new store credit.")}</p>
                      <CardInputs id="unreceipted-card" code={card.code} pin={card.pin ?? ""} onCode={(code) => setCard((c) => ({ ...c, code }))} onPin={(pin) => setCard((c) => ({ ...c, pin }))} />
                      <Button
                        disabled={!refundVia.card}
                        onClick={() =>
                          void makeCode(refundVia.card)
                            .then((code) => (setCard((c) => ({ ...c, code })), setMade(code)))
                            .catch((e: unknown) => setError(errorMessage(e)))
                        }
                      >
                        {t("New store credit")}
                      </Button>
                    </div>
                  )}
                </>
              )}
              {split.due > 0 && (
                <div className="pos-methods" role="group" aria-label={t("Way of paying")}>
                  {payable.map((m) => (
                    <button key={m.id} type="button" className="pos-method" aria-pressed={m.id === payWith} onClick={() => setPayMode(m.id)}>
                      {isolate(m.name)}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
      {error && <Alert tone="error">{isolate(error)}</Alert>}
      <div className="pos-sticky">
        <span className="spacer" />
        <Button onClick={onBack} disabled={busy}>
          {t("Back")}
        </Button>
        <Button variant="primary" className="pos-btn" disabled={!ready} loading={busy} onClick={submit}>
          {exchanging ? t("Complete the exchange") : backTotal > 0 ? t("Refund {total}", { total: money(backTotal) }) : t("Refund")}
        </Button>
      </div>
      {asker.node}
      {made && <CodeOnce profile={profile} code={made} onClose={() => setMade(null)} />}
    </div>
  );
}
