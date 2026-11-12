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
import { lazy, Suspense, useContext, useEffect, useMemo, useState, type FormEvent } from "react";
import { docPath, errorMessage, t as tr, isolate } from "@ferrum/client";
import { Alert, Badge, Button, confirmDialog, Dialog, Field, Icon, ListSkeleton, placed, toast } from "@ferrum/kit";
import { LinkInput, type Doc } from "@ferrum/records";
import { AskDialog } from "./Approval";
import { CardInputs } from "./Card";
import { Currency, localDate, num, titleOf, useMoney, str } from "./fmt";
import { leftOnCard, perTender, pointsAvailable, pointsFor, pointsValue, round, stillDue, tally, type Paid } from "./lib/pay";
import { fallbackReceiptHtml, quickCash, type Buyer, type Tender } from "./lib/pos";
import { serverDown, till, tillAll, unreachable } from "./lib/offline";
import { cardBalance, firstReceipt, voidSale } from "./lib/server";
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
  /** The register has no customer of its own and none is chosen: the sale cannot be paid yet. */
  noBuyer?: boolean;
  customerTitle?: string;
  onCustomer?: (id: string | null, title?: string) => void;
  customer: string | null;
  /** The loyalty program the server put the customer in. */
  program: string | null;
  /** Priced on this device: the server has not said whether the customer is in a program. */
  offline: boolean;
  /** Steps cash is likely to be handed over in. */
  steps: number[];
  /** The buyer who gave a tax registration, and how to change it: the server finds or makes the customer when it prices the sale. */
  buyer: Buyer | null;
  onBuyer: (b: Buyer | null) => void;
  /** Promotion codes the buyer gave, and how to change them (the server checks each). */
  codes: string[];
  onCodes: (c: string[]) => void;
  /** The sale as priced (the server's, or this till's offline): the buyer it found, the promotions it took, whether it needs a named buyer. */
  doc: Doc | null;
  /** The server's refusal of the sale as it stands (a registration, a code), shown as it is. */
  problem?: string | null;
  pricing?: boolean;
  /** The buyer rule the till holds offline (from the snapshot): above this a walk-in sale needs a named buyer. */
  namedAbove?: string | null;
  onClose: () => void;
  /** Sells; the answer is what went wrong, or null once it is done. */
  onComplete: (tenders: Tender[], o: { invoiceNow: boolean }) => Promise<string | null>;
}

type Added = Tender & { left?: number };

export function PayDialog({ profile, modes, due, grand, walkIn, noBuyer = false, customerTitle, onCustomer, customer, program, offline, steps, buyer, onBuyer, codes, onCodes, doc, problem, pricing, namedAbove, onClose, onComplete }: PayProps) {
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
  const [added, setAdded] = useState<Added[]>([]);
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
  // The buyer's registration and the promotion code are typed here and put on the sale when asked for.
  const [taxId, setTaxId] = useState(buyer?.taxId ?? "");
  const [buyerName, setBuyerName] = useState(buyer?.name ?? "");
  const [asking, setAsking] = useState(!!buyer);
  const [promo, setPromo] = useState("");
  // The sale's price changes when a code is taken or a buyer found: what is still due starts again from it, until a payment is added.
  useEffect(() => {
    if (!added.length) setAmount(String(due));
  }, [due]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const everything: Added[] = pending ? [...added, pending] : added;
  const t = tally(due, paidOf(everything), writeOff, precision);
  const before = stillDue(due, paidOf(added), precision);
  const rows = perTender(due, paidOf(everything), precision);
  const rounding = round(due - grand, precision);

  // The buyer the server found or made for the registration: made only in its preview, so a customer it cannot read is one it would make.
  const buyerId = buyer && !offline ? str(doc?.customer) : "";
  const found = useQuery({
    queryKey: ["pos", "buyer-found", buyerId],
    enabled: !!buyerId,
    staleTime: 60_000,
    queryFn: () =>
      till<Doc>(docPath("Customer", buyerId)).then(
        () => true,
        (e: unknown) => {
          if ((e as { status?: number })?.status === 404) return false;
          throw e;
        },
      ),
  });
  const taxed = doc?.tax_invoice === true;
  const applied = (doc?.applied_promotions as Doc[] | undefined) ?? [];
  // What the register asks of a sale of this size: the server says so when it prices it; offline, the snapshot's rule is held to.
  const needsBuyer = !buyer && walkIn && (doc?.needs_buyer === true || (offline && !!namedAbove && due > Number(namedAbove)));
  const heldBack = needsBuyer && offline ? tr("This register asks for a named buyer on a sale this size, and it cannot be checked until the connection is back: pick the customer on the sale, or sell it when the register is online.") : null;
  const covered = !noBuyer && t.left === 0 && !t.problem && !heldBack && !problem && !pricing;
  const applyBuyer = () => {
    if (!taxId.trim()) return;
    onBuyer({ taxId: taxId.trim(), ...(buyerName.trim() ? { name: buyerName.trim() } : {}) });
  };
  const dropBuyer = () => {
    setTaxId("");
    setBuyerName("");
    onBuyer(null);
  };
  const addCode = () => {
    const c = promo.trim();
    if (!c || codes.some((x) => x.toLowerCase() === c.toLowerCase())) return setPromo("");
    onCodes([...codes, c]);
    setPromo("");
  };

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
    const left = usingCard && card?.holds === "Money" ? leftOnCard(Number(card.balance), typed, precision) : undefined;
    const list: Added[] = [...added, { ...pending, ...(left !== undefined ? { left } : {}) }];
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
    setError(await onComplete(everything.map(({ left: _left, ...t }) => t), { invoiceNow: named && invoiceNow }));
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

        {problem && <Alert tone="error">{isolate(problem)}</Alert>}
        {applied.length > 0 && (
          <ul className="pos-added" aria-label={tr("Promotions taken")}>
            {applied.map((a, i) => (
              <li key={`${str(a.promotion)}-${i}`}>
                <span>
                  {isolate(str(a.title))}
                  {a.code ? ` · ${str(a.code)}` : ""}
                </span>
                <strong>−{isolate(money(a.amount))}</strong>
              </li>
            ))}
          </ul>
        )}

        <div className="pos-card">
          <Field label={tr("Promotion code")} htmlFor="pay-promo" hint={offline ? tr("A code is checked by the server: enter it when the connection is back.") : undefined}>
            <div className="pos-points">
              <input
                id="pay-promo"
                className="input"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                disabled={offline || busy}
                value={promo}
                onChange={(e) => setPromo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCode();
                  }
                }}
              />
              <Button disabled={offline || busy || !promo.trim()} onClick={addCode}>
                {tr("Apply code")}
              </Button>
            </div>
          </Field>
          {codes.length > 0 && (
            <ul className="pos-added" aria-label={tr("Codes on this sale")}>
              {codes.map((c) => (
                <li key={c}>
                  <span>{isolate(c)}</span>
                  <button type="button" className="icon-btn" aria-label={tr("Take the code {code} off", { code: c })} disabled={busy} onClick={() => onCodes(codes.filter((x) => x !== c))}>
                    <Icon name="x" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {!str(profile.customer) && !buyer && onCustomer && (
          <div className="pos-card">
            <LinkInput to="Customer" value={customer} title={customerTitle} onChange={onCustomer} label={tr("Customer")} required disabled={busy} placeholder={tr("Choose a customer")} />
            <p className="pos-hint">
              {tr("This register has no walk-in customer, so the sale needs one.")}{" "}
              {str(profile.buyer_customer) === "Find Only" ? tr("Choose an existing customer: this register does not make new ones.") : tr("Choose a customer, or give the buyer's tax registration below and one is found or made.")}
              {offline && ` ${tr("Offline, customers cannot be searched: the one already on this sale is kept, and another can be chosen once the connection is back.")}`}
            </p>
          </div>
        )}
        {asking || buyer || needsBuyer ? (
          <div className="pos-card">
            <Field label={tr("Buyer's tax registration")} htmlFor="pay-taxid" required={needsBuyer} hint={tr("The customer holding it is found, or made from it, and gets a tax invoice where the register's countries say so.")}>
              <input
                id="pay-taxid"
                className="input"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                disabled={busy}
                value={taxId}
                onChange={(e) => setTaxId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyBuyer();
                  }
                }}
              />
            </Field>
            <Field label={tr("Buyer's name")} htmlFor="pay-buyer-name" hint={tr("Used when a customer has to be made for this registration.")}>
              <input id="pay-buyer-name" className="input" autoComplete="off" disabled={busy} value={buyerName} onChange={(e) => setBuyerName(e.target.value)} />
            </Field>
            <div className="pos-points">
              <Button disabled={busy || !taxId.trim()} loading={!!buyer && !!pricing} onClick={applyBuyer}>
                {buyer ? tr("Check again") : tr("Use this registration")}
              </Button>
              {buyer && (
                <Button variant="ghost" disabled={busy} onClick={dropBuyer}>
                  {tr("Remove the registration")}
                </Button>
              )}
            </div>
            <div aria-live="polite">
              {buyer && !pricing && !problem && !!doc?.customer && (
                <p className="pos-hint">
                  {offline
                    ? tr("Offline: the registration is checked when the sale is sent, and the register may refuse it then.")
                    : found.data === false
                      ? tr("No customer holds this registration: one is made for {name} when the sale is saved.", { name: str(doc?.customer_name) })
                      : found.data === true
                        ? tr("Found {name}.", { name: str(doc?.customer_name) })
                        : ""}
                  {!offline && ` ${taxed ? tr("The sale gets a tax invoice of its own.") : tr("A simplified receipt: the invoice is made when the shift closes.")}`}
                </p>
              )}
            </div>
          </div>
        ) : (
          <Button disabled={busy} onClick={() => setAsking(true)}>
            {tr("Buyer has a tax registration")}
          </Button>
        )}
        {needsBuyer && <p className="pos-hint">{tr("This sale is above what the register takes without a named buyer: give the buyer's registration, or pick the customer on the sale.")}</p>}
        {heldBack && <Alert tone="warning">{heldBack}</Alert>}

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
                {card.holds === "Money" && typed > 0 && !cardWhy ? tr(" · {left} left after this payment", { left: money(leftOnCard(Number(card.balance), typed, precision)) }) : ""}
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

        {everything.length > 0 && (
          <ul className="pos-added" aria-label={tr("Payments")}>
            {everything.map((p, i) => {
              const name = methods.find((m) => m.id === p.mode_of_payment)?.name ?? "";
              const row = rows[i];
              const isAdded = i < added.length;
              return (
                <li key={`${p.mode_of_payment}-${i}`}>
                  <span>
                    {isolate(name)}
                    {p.loyalty_points ? tr(" · {loyalty_points} points", { loyalty_points: p.loyalty_points }) : ""}
                    {p.reference_no ? ` · ${p.reference_no}` : ""}
                    {p.stored_value_code ? tr(" · card ending {last}", { last: lastFour(p.stored_value_code) }) : ""}
                    {row.change > 0 && <span className="faint pos-hint">{tr("{tendered} handed over, {change} change", { tendered: money(row.tendered), change: money(row.change) })}</span>}
                    {(p as Added).left !== undefined && <span className="faint pos-hint">{tr("{left} left on the card", { left: money((p as Added).left) })}</span>}
                  </span>
                  <strong>{isolate(money(row.taken))}</strong>
                  {isAdded && (
                    <button type="button" className="icon-btn" aria-label={tr("Remove the {name} payment", { name })} disabled={busy} onClick={() => setAdded(added.filter((_, j) => j !== i))}>
                      <Icon name="x" size={14} />
                    </button>
                  )}
                </li>
              );
            })}
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

const ReceiptMore = lazy(() => import("./ReceiptMore"));

/** What is shown once a sale is done: the change to hand back, the receipt to print (the server's, once; copies, a gift
 *  receipt and sending it by message are ReceiptMore's), the next sale. A sale not yet closed into the books can be voided
 *  here, with a reason, by someone who may or with another person's approval (online only: the sale is the server's). */
export function ReceiptDialog({ profile, sale, limits, reasons = [], offline = false, onClose }: { profile: Doc; sale: Doc; limits?: Limits; reasons?: Doc[]; offline?: boolean; onClose: () => void }) {
  const money = useMoney();
  const change = num(sale.change_amount);
  const kept = sale.pending === true;
  const saleId = str(sale.id);
  const voidReasons = reasons.filter((r) => r.applies_to === "Void" && r.disabled !== true);
  const [asking, setAsking] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [note, setNote] = useState<{ tone: "warning" | "error" | "success"; text: string } | null>(null);
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
  // The server's receipt is given once, so a second press never asks again while the first is on its way.
  const print = async () => {
    if (printing) return;
    setPrinting(true);
    setNote(null);
    const own = (text: string) => {
      printHtml(fallbackReceiptHtml(profile, sale));
      setNote({ tone: "warning", text });
    };
    try {
      if (kept || !saleId) return own(kept ? tr("This sale is not on the register yet, so this is the till's own receipt, marked as such. The register's numbered receipt is for a copy once the sale is sent.") : tr("This sale has no number from the register yet, so this is the till's own receipt, marked as such."));
      if (offline || serverDown()) return own(tr("The register cannot be reached, so this is the till's own receipt, marked as such. A copy from the register can be printed once it is back."));
      printHtml(await firstReceipt(str(profile.id), saleId));
      setNote({ tone: "success", text: tr("Printed. Another is a copy, marked as one.") });
    } catch (e) {
      if (unreachable(e)) own(tr("The register could not be reached, so this is the till's own receipt, marked as such. A copy from the register can be printed once it is back."));
      else setNote({ tone: "error", text: errorMessage(e) });
    } finally {
      setPrinting(false);
    }
  };
  const paidWith = ((sale.payments as Doc[] | undefined) ?? []).filter((p) => num(p.amount) !== 0);
  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={kept ? tr("Sale kept on this device") : sale.is_return ? tr("Return done") : tr("Sale complete")}
        footer={
          <>
            <Button icon="printer" loading={printing} onClick={() => void print()}>
              {kept ? tr("Print a provisional receipt") : tr("Print receipt")}
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
          {!kept && (str(sale.buyer_tax_id) || sale.tax_invoice === true) && (
            <p className="muted">
              {tr("Buyer {name}", { name: str(sale.customer_name) })}
              {str(sale.buyer_tax_id) ? ` · ${str(sale.buyer_tax_id)}` : ""} · {sale.tax_invoice === true ? tr("tax invoice issued") : tr("simplified receipt")}
            </p>
          )}
          {paidWith.length > 0 && (
            <ul className="pos-added" aria-label={tr("Paid with")}>
              {paidWith.map((p, i) => (
                <li key={`${str(p.mode_of_payment)}-${i}`}>
                  <span>
                    {isolate(titleOf(p, "mode_of_payment"))}
                    {p.stored_value_balance != null && p.stored_value_balance !== "" && <span className="faint pos-hint">{tr("{left} left on the card", { left: money(p.stored_value_balance) })}</span>}
                  </span>
                  <strong>{isolate(money(p.amount))}</strong>
                </li>
              ))}
            </ul>
          )}
          {kept && <p className="muted">{tr("It is sent, and numbered, as soon as the connection is back. The till keeps selling meanwhile.")}</p>}
          {note && <Alert tone={note.tone}>{isolate(note.text)}</Alert>}
          {!kept && !!saleId && !!limits && (
            <Suspense fallback={<ListSkeleton rows={1} />}>
              <ReceiptMore profile={profile} sale={sale} limits={limits} reasons={reasons} offline={offline} />
            </Suspense>
          )}
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
