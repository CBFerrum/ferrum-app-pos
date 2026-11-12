// Taking payment, and the receipt after it. The cashier picks a way of paying, types what was
// handed over (cash may be more than the bill: the rest is change), and adds another way for a split
// payment; what is still due after each one is already in the next. Enter adds the payment, or
// completes the sale once the bill is covered. The server settles it the same way (`settle_sale`):
// only cash can come to more than the bill, a shortfall inside the register's write-off limit is
// forgiven, a sale on account and points need a named customer. A card (stored value) is read first:
// its balance and expiry are shown before it is taken, and what it cannot cover goes to another way
// of paying; its code and PIN live in this window and the one request, never in storage or the queue.
// With a customer on the sale, the tax invoice can be issued at once.

import { useQuery } from "@tanstack/react-query";
import { useContext, useMemo, useState, type FormEvent } from "react";
import { docPath, errorMessage, t as tr, isolate } from "@ferrum/client";
import { Alert, Badge, Button, confirmDialog, Dialog, Field, Icon, placed, toast } from "@ferrum/kit";
import type { Doc } from "@ferrum/records";
import { AskDialog } from "./Approval";
import { CardInputs } from "./Card";
import { Currency, localDate, num, titleOf, useMoney, str } from "./fmt";
import { pointsAvailable, pointsFor, pointsValue, round, stillDue, tally, type Paid } from "./lib/pay";
import { quickCash, receiptHtml, type Tender } from "./lib/pos";
import { till, tillAll } from "./lib/offline";
import { cardBalance, voidSale } from "./lib/server";
import { allows, type Limits } from "./lib/rights";
import { cardProblem, codeOk, lastFour, type CardBalance } from "./lib/stored";
import { printHtml } from "./print";

interface Method {
  id: string;
  name: string;
  kind: string;
  isDefault: boolean;
  /** What the server takes of a card offline (0: none). */
  offlineLimit: number;
}

export interface PayProps {
  profile: Doc;
  /** Every way of paying, with its kind (cash gives change, bank takes a reference). */
  modes: Doc[];
  /** What the sale comes to, rounded as the company rounds. */
  due: number;
  /** Before rounding. */
  grand: number;
  /** A named customer is needed for a sale on account and for points. */
  walkIn: boolean;
  customer: string | null;
  /** The loyalty program the server put the customer in. */
  program: string | null;
  /** Priced on this device: the server has not said whether the customer is in a program. */
  offline: boolean;
  /** Steps cash is likely to be handed over in. */
  steps: number[];
  onClose: () => void;
  /** Sells; the answer is what went wrong, or null once it is done. */
  onComplete: (tenders: Tender[], o: { invoiceNow: boolean }) => Promise<string | null>;
}

export function PayDialog({ profile, modes, due, grand, walkIn, customer, program, offline, steps, onClose, onComplete }: PayProps) {
  const money = useMoney();
  const { precision } = useContext(Currency);
  const methods: Method[] = useMemo(
    () =>
      ((profile.payments as Doc[] | undefined) ?? []).map((r) => {
        const id = str(r.mode_of_payment);
        const mode = modes.find((m) => m.id === id);
        return { id, name: titleOf(r, "mode_of_payment"), kind: str(mode?.mode_type) || "General", isDefault: r.is_default === true, offlineLimit: num(mode?.offline_limit) };
      }),
    [profile, modes],
  );
  const writeOff = num(profile.write_off_limit);
  const hasPoints = methods.some((m) => m.kind === "Loyalty Points");
  const named = !walkIn && !!customer;

  const balance = useQuery({
    queryKey: ["pos", "points", program, customer],
    enabled: hasPoints && named && !!program,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const [p, e] = await Promise.all([
        till<Doc>(docPath("LoyaltyProgram", program!), { signal }),
        // Every entry: a balance over one page of them would be wrong for a long-standing customer.
        tillAll<Doc>(docPath("LoyaltyPointEntry"), { filters: JSON.stringify({ loyalty_program: program, customer }), fields: "points,remaining,expiry_date" }, signal),
      ]);
      return {
        factor: num(p.conversion_factor),
        available: pointsAvailable(e.map((r) => ({ points: num(r.points), remaining: num(r.remaining), expiry_date: str(r.expiry_date) || null })), localDate(new Date())),
      };
    },
  });
  const factor = balance.data?.factor ?? 0;
  const available = Math.max(0, balance.data?.available ?? 0);

  /** Why a way of paying cannot be used for this sale, if it cannot. */
  const whyNot = (m: Method): string | null => {
    if (m.kind === "Credit" && !named) return tr("Paying later needs a named customer: pick one on the sale first.");
    if (m.kind === "Stored Value" && offline) {
      return m.offlineLimit > 0
        ? tr("The server takes this offline up to {limit}, but the till never keeps a card's code on this device. Take it when the connection is back.", { limit: money(m.offlineLimit) })
        : tr("Cards need a connection: the balance is the server's.");
    }
    if (m.kind === "Loyalty Points") {
      if (!named) return tr("Points need a named customer: pick one on the sale first.");
      if (offline) return tr("Points need a connection to read the customer's balance.");
      if (!program) return tr("This customer is not in a loyalty program.");
      if (balance.data && available <= 0) return tr("This customer has no points to use.");
    }
    return null;
  };
  const usable = (m: Method) => !whyNot(m);

  const first = methods.find((m) => m.isDefault && usable(m)) ?? methods.find((m) => m.kind === "Cash" && usable(m)) ?? methods.find(usable);
  const [added, setAdded] = useState<Tender[]>([]);
  const [method, setMethod] = useState(first?.id ?? "");
  const [amount, setAmount] = useState(String(due));
  const [reference, setReference] = useState("");
  const [points, setPoints] = useState("");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [card, setCard] = useState<CardBalance | null>(null);
  const [checking, setChecking] = useState(false);
  const [invoiceNow, setInvoiceNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const kindOf = (id: string) => methods.find((m) => m.id === id)?.kind ?? "General";
  const paidOf = (list: Tender[]): Paid[] => list.map((t) => ({ kind: kindOf(t.mode_of_payment), amount: num(t.amount) }));
  const current = methods.find((m) => m.id === method);
  const usingPoints = current?.kind === "Loyalty Points";
  const usingCard = current?.kind === "Stored Value";
  const typed = usingPoints ? pointsValue(Math.floor(num(points)), factor, precision) : num(amount);
  const cardWhy = usingCard && card ? cardProblem(card, typed, localDate(new Date())) : null;
  // A card is taken only once its balance has been read and covers what is typed.
  const cardReady = !usingCard || (!!card && !cardWhy);
  const pending: Tender | null =
    current && typed > 0 && cardReady
      ? {
          mode_of_payment: current.id,
          amount: String(typed),
          ...(reference.trim() ? { reference_no: reference } : {}),
          ...(usingPoints ? { loyalty_points: Math.floor(num(points)) } : {}),
          ...(usingCard ? { stored_value_code: code.trim(), ...(pin.trim() ? { stored_value_pin: pin.trim() } : {}) } : {}),
        }
      : null;
  const everything = pending ? [...added, pending] : added;
  const t = tally(due, paidOf(everything), writeOff, precision);
  const before = stillDue(due, paidOf(added), precision);
  const covered = t.left === 0 && !t.problem;
  const rounding = round(due - grand, precision);

  const forgetCard = () => {
    setCode("");
    setPin("");
    setCard(null);
  };
  const choose = (id: string) => {
    setMethod(id);
    setAmount(String(before));
    setReference("");
    setPoints("");
    forgetCard();
    setError(null);
  };
  // The card's balance, expiry and state before it is taken; what it holds caps what is typed.
  const check = async () => {
    if (!current || !codeOk(code) || checking) return;
    setChecking(true);
    setError(null);
    try {
      const found = await cardBalance(current.id, code.trim(), pin.trim() || undefined);
      setCard(found);
      if (found.holds === "Money" && Number(found.balance) < before) setAmount(String(Number(found.balance)));
    } catch (e) {
      setCard(null);
      setError(errorMessage(e));
    }
    setChecking(false);
  };
  const add = () => {
    if (!pending) return;
    const list = [...added, pending];
    setAdded(list);
    const next = methods.find((m) => m.id !== method && usable(m) && m.kind !== "Loyalty Points") ?? current;
    setMethod(next?.id ?? method);
    setAmount(String(stillDue(due, paidOf(list), precision)));
    setReference("");
    setPoints("");
    forgetCard();
    setError(null);
  };
  // A stray tap outside the window must not forget payments already added.
  const close = async () => {
    if (busy) return;
    if (added.length && !(await confirmDialog({ title: tr("Cancel this payment?"), message: tr("The payments added so far are forgotten. Nothing has been sold."), confirmLabel: tr("Cancel the payment"), cancelLabel: tr("Keep going"), danger: true }))) return;
    onClose();
  };
  const complete = async () => {
    setBusy(true);
    setError(await onComplete(everything, { invoiceNow: named && invoiceNow }));
    setBusy(false);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (covered) void complete();
    else add();
  };

  const status = t.problem ? (
    <p className="pos-status pos-status-bad">{isolate(t.problem)}</p>
  ) : t.left > 0 ? (
    <p className="pos-status pos-status-due">{tr("Still due")} <strong>{isolate(money(t.left))}</strong></p>
  ) : t.change > 0 ? (
    <p className="pos-status pos-status-change">{tr("Change")} <strong>{isolate(money(t.change))}</strong></p>
  ) : t.writeOff > 0 ? (
    <p className="pos-status">{placed(tr("Short by {p1}, which this register writes off."), { p1: isolate(money(t.writeOff)) })}</p>
  ) : (
    <p className="pos-status pos-status-change">{tr("Paid exactly")}</p>
  );

  return (
    <Dialog
      open
      onClose={() => void close()}
      title={tr("Take payment")}
      footer={
        <>
          <Button className="pos-btn" onClick={() => void close()} disabled={busy}>
            {tr("Back")}
          </Button>
          {!covered && pending && (
            <Button className="pos-btn" onClick={add} disabled={busy}>
              {tr("Add payment")}
            </Button>
          )}
          <Button variant="primary" className="pos-btn" onClick={() => void complete()} loading={busy} disabled={!covered}>
            {tr("Complete sale")}
          </Button>
        </>
      }
    >
      <form className="pos-paying" onSubmit={submit}>
        <p className="pos-due">
          <span className="muted">{tr("Total due")}</span>
          <strong>{isolate(money(due))}</strong>
        </p>
        {rounding !== 0 && (
          <p className="faint pos-rounding">
            {tr("Rounded from")} {isolate(money(grand))} ({rounding > 0 ? "+" : "−"}
            {isolate(money(Math.abs(rounding)))})
          </p>
        )}

        <div className="pos-methods" role="group" aria-label={tr("Way of paying")}>
          {methods.map((m) => (
            <button key={m.id} type="button" className="pos-method" aria-pressed={m.id === method} disabled={!usable(m) || busy} onClick={() => choose(m.id)}>
              {isolate(m.name)}
            </button>
          ))}
        </div>
        {methods.filter((m) => whyNot(m)).map((m) => (
          <p key={m.id} className="faint pos-hint">
            {isolate(m.name)}: {isolate(whyNot(m) ?? "")}
          </p>
        ))}

        {usingCard && (
          <div className="pos-card">
            <CardInputs
              id="pay-card"
              code={code}
              pin={pin}
              onCode={(v) => (setCode(v), setCard(null))}
              onPin={(v) => (setPin(v), setCard(null))}
              onEnter={() => void check()}
            />
            <Button className="pos-btn" loading={checking} disabled={!codeOk(code)} onClick={() => void check()}>
              {tr("Check balance")}
            </Button>
            {card && (
              <p className="pos-hint" role="status">
                {card.holds === "Money" ? tr("Balance {balance}", { balance: money(card.balance) }) : tr("{balance} units left", { balance: card.balance })}
                {card.expires_on ? tr(" · valid until {date}", { date: card.expires_on }) : tr(" · does not expire")}
              </p>
            )}
            {cardWhy && <Alert tone="warning">{isolate(cardWhy)}</Alert>}
          </div>
        )}

        {current && !usingPoints && (
          <>
            <Field label={tr("{name} amount", { name: current.name })} htmlFor="pay-amount">
              <input
                id="pay-amount"
                className="input pos-amount"
                inputMode="decimal"
                autoComplete="off"
                data-autofocus
                value={amount}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            {current.kind === "Cash" && (
              <div className="pos-quick" role="group" aria-label={tr("Cash handed over")}>
                {quickCash(before, steps).map((v, i) => (
                  <Button key={v} className="pos-btn" onClick={() => setAmount(String(v))}>
                    {i === 0 ? tr("Exact ") : ""}
                    {isolate(money(v))}
                  </Button>
                ))}
              </div>
            )}
            {(current.kind === "Bank" || current.kind === "General") && (
              <Field label={tr("Reference")} htmlFor="pay-ref" hint={tr("A card approval code or a UPI id, if you want it on the sale.")}>
                <input id="pay-ref" className="input" autoComplete="off" value={reference} onChange={(e) => setReference(e.target.value)} />
              </Field>
            )}
            {current.kind === "Credit" && <p className="faint pos-hint">{tr("On account: the customer pays later, and this stays open as theirs to pay.")}</p>}
          </>
        )}

        {current && usingPoints && (
          <Field
            label={tr("Points to use")}
            htmlFor="pay-points"
            hint={balance.isLoading ? tr("Looking up the balance…") : balance.error ? tr("The balance could not be read.") : tr("{available} points available, {value} to spend.", { available, value: money(pointsValue(available, factor, precision)) })}
          >
            <div className="pos-points">
              <input
                id="pay-points"
                className="input pos-amount"
                inputMode="numeric"
                autoComplete="off"
                data-autofocus
                value={points}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setPoints(e.target.value.replace(/\D/g, ""))}
              />
              <Button onClick={() => setPoints(String(pointsFor(before, available, factor, precision)))}>{tr("As many as the bill allows")}</Button>
            </div>
          </Field>
        )}

        {added.length > 0 && (
          <ul className="pos-added" aria-label={tr("Payments added")}>
            {added.map((p, i) => (
              <li key={`${p.mode_of_payment}-${i}`}>
                <span>
                  {isolate(methods.find((m) => m.id === p.mode_of_payment)?.name ?? "")}
                  {p.loyalty_points ? tr(" · {loyalty_points} points", { loyalty_points: p.loyalty_points }) : ""}
                  {p.reference_no ? ` · ${p.reference_no}` : ""}
                  {p.stored_value_code ? tr(" · card ending {last}", { last: lastFour(p.stored_value_code) }) : ""}
                </span>
                <strong>{isolate(money(p.amount))}</strong>
                <button type="button" className="icon-btn" aria-label={tr("Remove the {name} payment", { name: String(methods.find((m) => m.id === p.mode_of_payment)?.name) })} disabled={busy} onClick={() => setAdded(added.filter((_, j) => j !== i))}>
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {named && (
          <label className="pos-check">
            <input type="checkbox" checked={invoiceNow} disabled={busy} onChange={(e) => setInvoiceNow(e.target.checked)} />
            <span>
              {tr("Issue the tax invoice now")}
              <span className="faint pos-hint"> {tr("The customer's own sales invoice is made when the sale is saved, not at closing.")}</span>
            </span>
          </label>
        )}

        <div aria-live="polite">{status}</div>
        {error && <Alert tone="error">{isolate(error)}</Alert>}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}

/** What is shown once a sale is done: the change to hand back, the receipt to print, the next sale.
 *  A sale not yet closed into the books can be voided here, with a reason, by someone who may or
 *  with another person's approval (online only: the sale is the server's). */
export function ReceiptDialog({ profile, sale, limits, reasons = [], offline = false, onClose }: { profile: Doc; sale: Doc; limits?: Limits; reasons?: Doc[]; offline?: boolean; onClose: () => void }) {
  const money = useMoney();
  const change = num(sale.change_amount);
  const kept = sale.pending === true;
  const voidReasons = reasons.filter((r) => r.applies_to === "Void" && r.disabled !== true);
  const [asking, setAsking] = useState(false);
  const voidable = !kept && !sale.is_return && !sale.exchange && !!sale.id && !!limits && voidReasons.length > 0;
  const voidIt = async (approval: string | undefined, reason: string | undefined) => {
    setAsking(false);
    try {
      await voidSale(str(sale.id), reason, approval);
      toast(tr("Sale {number} voided", { number: str(sale.number) }));
      onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={kept ? tr("Sale kept on this device") : sale.is_return ? tr("Return done") : tr("Sale complete")}
        footer={
          <>
            <Button icon="printer" onClick={() => printHtml(receiptHtml(profile, sale))}>
              {tr("Print receipt")}
            </Button>
            {voidable && (
              <Button variant="danger" disabled={offline} title={offline ? tr("Voiding a sale needs a connection.") : undefined} onClick={() => setAsking(true)}>
                {tr("Void this sale")}
              </Button>
            )}
            <Button variant="primary" className="pos-btn" data-autofocus onClick={onClose}>
              {sale.is_return ? tr("Done") : tr("Next sale")}
            </Button>
          </>
        }
      >
        <div className="pos-done">
          {change > 0 && (
            <p className="pos-status pos-status-change">
              {tr("Change")} <strong>{isolate(money(change))}</strong>
            </p>
          )}
          <p>
            {kept ? <Badge tone="amber">{tr("Not sent yet")}</Badge> : <strong>{isolate(str(sale.number))}</strong>} · {isolate(money(sale.rounded_total ?? sale.grand_total))}
          </p>
          {kept && <p className="muted">{tr("It is sent, and numbered, as soon as the connection is back. The till keeps selling meanwhile.")}</p>}
        </div>
      </Dialog>
      {asking && limits && (
        <AskDialog
          profile={str(profile.id)}
          sale={str(sale.id)}
          title={tr("Void sale {number}", { number: str(sale.number) })}
          steps={allows(limits, "Void Sale") ? [] : [{ act: "Void Sale", figure: 0, why: tr("you may not void sales") }]}
          reasons={voidReasons}
          offline={offline}
          onClose={() => setAsking(false)}
          onDone={(ap, reason) => void voidIt(ap[0]?.id, reason)}
        />
      )}
    </>
  );
}
