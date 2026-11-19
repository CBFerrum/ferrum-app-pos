// The till's lock screen (POS-12): who serves at the cashier's till. Someone picked with their PIN serves from now
// (`take_over`); the session's cashier takes the till back with their own PIN (`hand_back`). The PIN is sent in its one
// request and dropped. Offline nothing switches, so the till can only carry on as whoever serves now.

import { useState, type FormEvent } from "react";
import { isolate, t as tr } from "@ferrum/client";
import { Alert, Button, Field } from "@ferrum/kit";
import { fine } from "./fmt";
import { pinShape } from "./lib/approval";
import { handBack, takeOver } from "./lib/server";
import { servingProblem } from "./lib/serving";

export interface LockProps {
  /** The open session's id. */
  session: string;
  /** The session's cashier, who answers for the drawer. */
  cashier: string;
  /** Who serves now when it is not the cashier. */
  serving: string | null;
  /** Whom to offer, the cashier first (`peopleOf`). */
  people: string[];
  /** The register names nobody, so anyone who works a till may type their address. */
  anyone: boolean;
  offline: boolean;
  /** The till is unlocked; `serving` is who serves from now (null: the cashier). */
  onUnlock: (serving: string | null) => void;
}

export function LockScreen({ session, cashier, serving, people, anyone, offline, onUnlock }: LockProps) {
  const now = serving ?? cashier;
  const [who, setWho] = useState(people.some((p) => p.toLowerCase() === now.toLowerCase()) ? now : cashier);
  const [typed, setTyped] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const person = (who || typed).trim();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!person || !pinShape(pin) || busy || offline) return;
    const secret = pin;
    setPin("");
    setBusy(true);
    setError(null);
    try {
      if (person.toLowerCase() === cashier.toLowerCase()) {
        await handBack(session, secret);
        onUnlock(null);
      } else {
        onUnlock((await takeOver(session, person, secret)).operator);
      }
    } catch (err) {
      setError(servingProblem(err as { status?: number; message?: string }, person));
      setBusy(false);
    }
  };
  return (
    <form className="pos-open" aria-labelledby="pos-lock-title" onSubmit={(e) => void submit(e)}>
      <h2 id="pos-lock-title">{tr("Who is serving?")}</h2>
      <p className="muted">{tr("The till is locked. {cashier} answers for its drawer.", { cashier })}</p>
      {offline ? (
        <>
          <Alert tone="warning">{tr("Switching people needs a connection. The till carries on as {who}.", { who: now })}</Alert>
          <Button variant="primary" className="pos-btn" onClick={() => onUnlock(serving)}>
            {tr("Carry on as {who}", { who: now })}
          </Button>
        </>
      ) : (
        <>
          <fieldset className="pos-paying">
            <legend className="sr-only">{tr("Who is serving?")}</legend>
            {people.map((p, i) => (
              <label key={p} className="check-field">
                <input type="radio" name="pos-serving" checked={who === p} onChange={() => setWho(p)} />
                <span>
                  {isolate(p)}
                  {i === 0 && <span className="faint"> {tr("(this session's cashier)")}</span>}
                </span>
              </label>
            ))}
            {anyone && (
              <label className="check-field">
                <input type="radio" name="pos-serving" checked={who === ""} onChange={() => setWho("")} />
                <span>{tr("Someone else")}</span>
              </label>
            )}
          </fieldset>
          {anyone && who === "" && (
            <Field label={tr("Their email")} htmlFor="pos-lock-who" required>
              <input id="pos-lock-who" className="input" type="email" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </Field>
          )}
          <Field label={tr("PIN")} htmlFor="pos-lock-pin" required hint={tr("The PIN of the person serving.")}>
            <input
              id="pos-lock-pin"
              className="input pos-amount"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={12}
              autoFocus={fine()}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          {error && <Alert tone="error">{isolate(error)}</Alert>}
          <Button variant="primary" className="pos-btn" type="submit" loading={busy} disabled={!person || !pinShape(pin)}>
            {tr("Unlock")}
          </Button>
        </>
      )}
    </form>
  );
}
