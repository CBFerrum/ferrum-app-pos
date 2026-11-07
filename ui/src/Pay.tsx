// Taking payment, and the receipt after it. The cashier picks a way of paying, types what was
// handed over (cash may be more than the bill: the rest is change), and adds another way for a split
// payment; what is still due after each one is already in the next. Enter adds the payment, or
// completes the sale once the bill is covered. The server settles it the same way (`settle_sale`):
// only cash can come to more than the bill, a shortfall inside the register's write-off limit is
// forgiven, a sale on account and points need a named customer.

import { useQuery } from "@tanstack/react-query";
import { useContext, useMemo, useState, type FormEvent } from "react";
import { docPath, t as tr } from "@ferrum/client";
import { Alert, Badge, Button, confirmDialog, Dialog, Field, Icon } from "@ferrum/kit";
import type { Doc } from "@ferrum/records";
import { Currency, localDate, num, titleOf, useMoney, str } from "./fmt";
import { pointsAvailable, pointsFor, pointsValue, round, stillDue, tally, type Paid } from "./lib/pay";
import { quickCash, receiptHtml, type Tender } from "./lib/pos";
import { till, tillAll } from "./lib/offline";
import { printHtml } from "./print";

interface Method {
  id: string;
  name: string;
  kind: string;
  isDefault: boolean;
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
  onComplete: (tenders: Tender[]) => Promise<string | null>;
}

export function PayDialog({ profile, modes, due, grand, walkIn, customer, program, offline, steps, onClose, onComplete }: PayProps) {
  const money = useMoney();
  const { precision } = useContext(Currency);
  const methods: Method[] = useMemo(
    () =>
      ((profile.payments as Doc[] | undefined) ?? []).map((r) => {
        const id = str(r.mode_of_payment);
        return { id, name: titleOf(r, "mode_of_payment"), kind: str(modes.find((m) => m.id === id)?.mode_type) || "General", isDefault: r.is_default === true };
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
    if (m.kind === "Credit" && !named) return "Paying later needs a named customer: pick one on the sale first.";
    if (m.kind === "Loyalty Points") {
      if (!named) return "Points need a named customer: pick one on the sale first.";
      if (offline) return "Points need a connection to read the customer's balance.";
      if (!program) return "This customer is not in a loyalty program.";
      if (balance.data && available <= 0) return "This customer has no points to use.";
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const kindOf = (id: string) => methods.find((m) => m.id === id)?.kind ?? "General";
  const paidOf = (list: Tender[]): Paid[] => list.map((t) => ({ kind: kindOf(t.mode_of_payment), amount: num(t.amount) }));
  const current = methods.find((m) => m.id === method);
  const usingPoints = current?.kind === "Loyalty Points";
  const typed = usingPoints ? pointsValue(Math.floor(num(points)), factor, precision) : num(amount);
  const pending: Tender | null =
    current && typed > 0
      ? { mode_of_payment: current.id, amount: String(typed), ...(reference.trim() ? { reference_no: reference } : {}), ...(usingPoints ? { loyalty_points: Math.floor(num(points)) } : {}) }
      : null;
  const everything = pending ? [...added, pending] : added;
  const t = tally(due, paidOf(everything), writeOff, precision);
  const before = stillDue(due, paidOf(added), precision);
  const covered = t.left === 0 && !t.problem;
  const rounding = round(due - grand, precision);

  const choose = (id: string) => {
    setMethod(id);
    setAmount(String(before));
    setReference("");
    setPoints("");
    setError(null);
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
    setError(null);
  };
  // A stray tap outside the window must not forget payments already added.
  const close = async () => {
    if (busy) return;
    if (added.length && !(await confirmDialog({ title: "Cancel this payment?", message: "The payments added so far are forgotten. Nothing has been sold.", confirmLabel: "Cancel the payment", cancelLabel: "Keep going", danger: true }))) return;
    onClose();
  };
  const complete = async () => {
    setBusy(true);
    setError(await onComplete(everything));
    setBusy(false);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (covered) void complete();
    else add();
  };

  const status = t.problem ? (
    <p className="pos-status pos-status-bad">{t.problem}</p>
  ) : t.left > 0 ? (
    <p className="pos-status pos-status-due">{tr("Still due")} <strong>{money(t.left)}</strong></p>
  ) : t.change > 0 ? (
    <p className="pos-status pos-status-change">{tr("Change")} <strong>{money(t.change)}</strong></p>
  ) : t.writeOff > 0 ? (
    <p className="pos-status">{tr("Short by")} {money(t.writeOff)}{tr(", which this register writes off.")}</p>
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
          <Button onClick={() => void close()} disabled={busy}>
            {tr("Back")}
          </Button>
          {!covered && pending && (
            <Button onClick={add} disabled={busy}>
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
          <strong>{money(due)}</strong>
        </p>
        {rounding !== 0 && (
          <p className="faint pos-rounding">
            {tr("Rounded from")} {money(grand)} ({rounding > 0 ? "+" : "−"}
            {money(Math.abs(rounding))})
          </p>
        )}

        <div className="pos-methods" role="group" aria-label={tr("Way of paying")}>
          {methods.map((m) => (
            <button key={m.id} type="button" className="pos-method" aria-pressed={m.id === method} disabled={!usable(m) || busy} onClick={() => choose(m.id)}>
              {m.name}
            </button>
          ))}
        </div>
        {methods.filter((m) => whyNot(m)).map((m) => (
          <p key={m.id} className="faint pos-hint">
            {m.name}: {whyNot(m)}
          </p>
        ))}

        {current && !usingPoints && (
          <>
            <Field label={`${current.name} amount`} htmlFor="pay-amount">
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
                    {i === 0 ? "Exact " : ""}
                    {money(v)}
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
            hint={balance.isLoading ? "Looking up the balance…" : balance.error ? "The balance could not be read." : `${available} points available, ${money(pointsValue(available, factor, precision))} to spend.`}
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
                  {methods.find((m) => m.id === p.mode_of_payment)?.name}
                  {p.loyalty_points ? ` · ${p.loyalty_points} points` : ""}
                  {p.reference_no ? ` · ${p.reference_no}` : ""}
                </span>
                <strong>{money(p.amount)}</strong>
                <button type="button" className="icon-btn" aria-label={`Remove the ${methods.find((m) => m.id === p.mode_of_payment)?.name} payment`} disabled={busy} onClick={() => setAdded(added.filter((_, j) => j !== i))}>
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div aria-live="polite">{status}</div>
        {error && <Alert tone="error">{error}</Alert>}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}

/** What is shown once a sale is done: the change to hand back, the receipt to print, the next sale. */
export function ReceiptDialog({ profile, sale, onClose }: { profile: Doc; sale: Doc; onClose: () => void }) {
  const money = useMoney();
  const change = num(sale.change_amount);
  const kept = sale.pending === true;
  return (
    <Dialog
      open
      onClose={onClose}
      title={kept ? "Sale kept on this device" : sale.is_return ? "Return done" : "Sale complete"}
      footer={
        <>
          <Button icon="printer" onClick={() => printHtml(receiptHtml(profile, sale))}>
            {tr("Print receipt")}
          </Button>
          <Button variant="primary" className="pos-btn" data-autofocus onClick={onClose}>
            {sale.is_return ? "Done" : "Next sale"}
          </Button>
        </>
      }
    >
      <div className="pos-done">
        {change > 0 && (
          <p className="pos-status pos-status-change">
            {tr("Change")} <strong>{money(change)}</strong>
          </p>
        )}
        <p>
          {kept ? <Badge tone="amber">{tr("Not sent yet")}</Badge> : <strong>{str(sale.number)}</strong>} · {money(sale.rounded_total ?? sale.grand_total)}
        </p>
        {kept && <p className="muted">{tr("It is sent, and numbered, as soon as the connection is back. The till keeps selling meanwhile.")}</p>}
      </div>
    </Dialog>
  );
}
