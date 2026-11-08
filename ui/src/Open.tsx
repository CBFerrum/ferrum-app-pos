// Opening a shift: count the float in the drawer for each way of paying, and the register opens.
// The cash can be counted note by note. Needs the server, so it is its own chunk, loaded when a
// register has no open session.

import { useQueryClient } from "@tanstack/react-query";
import { useContext, useRef, useState, type FormEvent } from "react";
import { docPath, errorMessage, newKey, t, isolate } from "@ferrum/client";
import { Alert, Button, Field, toast } from "@ferrum/kit";
import type { Doc } from "@ferrum/records";
import { CashCounter, countTotal, type Counted } from "./Count";
import { Currency, str, titleOf, useMoney } from "./fmt";
import { till, unreachable } from "./lib/offline";
import { typedAmount } from "./lib/shift";

export default function Open({ profile, modes, onOpened }: { profile: Doc; modes: Doc[]; onOpened: () => void }) {
  const qc = useQueryClient();
  const money = useMoney();
  const { precision } = useContext(Currency);
  // The float is kept for ways of paying that are counted (cash, cards), as the server's rule says.
  const rows = ((profile.payments as Doc[] | undefined) ?? []).filter((r) => ["Cash", "Bank", "General"].includes(str(modes.find((m) => m.id === r.mode_of_payment)?.mode_type)));
  const drawer = rows.find((r) => str(modes.find((m) => m.id === r.mode_of_payment)?.mode_type) === "Cash");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [count, setCount] = useState<Counted>({ counts: {}, other: "" });
  const [counting, setCounting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());

  const amountOf = (mode: string) => (counting && mode === str(drawer?.mode_of_payment) ? countTotal(count, precision) : (typedAmount(amounts[mode]) ?? 0));
  const bad = rows.some((r) => amounts[str(r.mode_of_payment)]?.trim() && typedAmount(amounts[str(r.mode_of_payment)]) === null);
  const total = rows.reduce((s, r) => s + amountOf(str(r.mode_of_payment)), 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const balance_details = rows.map((r) => ({ mode_of_payment: r.mode_of_payment, opening_amount: String(amountOf(str(r.mode_of_payment))) }));
      await till(docPath("PosOpeningEntry"), { method: "POST", body: { pos_profile: profile.id, balance_details }, query: { submit: true }, idempotencyKey: key.current });
      toast(t("Register open"));
      void qc.invalidateQueries({ queryKey: ["pos", "session"] });
      onOpened();
    } catch (err) {
      setError(unreachable(err) ? t("No connection: open the register when it is back.") : errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="pos-open">
      <div>
        <h2>{t("Open the register")}</h2>
        <p className="muted">{t("Count the float in the drawer for each way of paying. You can open it with nothing in it.")}</p>
      </div>
      {rows.map((r) => {
        const mode = str(r.mode_of_payment);
        const isDrawer = mode === str(drawer?.mode_of_payment);
        return (
          <Field key={mode} label={titleOf(r, "mode_of_payment")} htmlFor={`open-${mode}`}>
            {counting && isDrawer ? (
              <p className="pos-amount-fixed">{isolate(money(amountOf(mode)))}</p>
            ) : (
              <input
                id={`open-${mode}`}
                className="input pos-amount"
                inputMode="decimal"
                placeholder="0.00"
                autoComplete="off"
                aria-invalid={!!amounts[mode]?.trim() && typedAmount(amounts[mode]) === null}
                value={amounts[mode] ?? ""}
                onChange={(e) => setAmounts((a) => ({ ...a, [mode]: e.target.value }))}
              />
            )}
            {isDrawer && (
              <Button onClick={() => setCounting((c) => !c)}>{counting ? t("Type the total instead") : t("Count notes and coins")}</Button>
            )}
          </Field>
        );
      })}
      {counting && <CashCounter value={count} onChange={setCount} />}
      <p className="pos-counter-total">
        <span className="muted">{t("Float")}</span>
        <strong>{isolate(money(total))}</strong>
      </p>
      {error && <Alert tone="error">{isolate(error)}</Alert>}
      <Button type="submit" variant="primary" className="pos-btn" loading={busy} disabled={bad}>
        {t("Open register")}
      </Button>
    </form>
  );
}
