// What a receipt can be besides the first printing, all of it the server's (its document templates, its
// counting of copies, its message channels), so all of it needs the connection: a copy (the template marks
// it COPY n; the register counts it and keeps who asked, when, why and by whose approval), a gift receipt
// (no prices), and the receipt sent to an address or number with the buyer's consent. A person whose limits
// do not allow reprints asks another's approval, which covers one copy; when the business has reasons for
// a copy, one is chosen. Loaded when asked for: the till itself works without it.

import { useRef, useState, type FormEvent } from "react";
import { errorMessage, t as tr, isolate } from "@ferrum/client";
import { Alert, Button, Dialog, Field } from "@ferrum/kit";
import type { Doc } from "@ferrum/records";
import { useAsk } from "./Approval";
import { str } from "./fmt";
import { serverDown } from "./lib/offline";
import { allows, type Ask, type Limits } from "./lib/rights";
import { reprint, sendReceipt } from "./lib/server";
import { printHtml } from "./print";

export interface Note {
  tone: "success" | "error";
  text: string;
}

/** Copies and gift receipts of a sale: asks the approval and the reason the register's rules want, then prints what the server renders. */
export function useReprint(profile: Doc, limits: Limits, reasons: Doc[], offline: boolean) {
  const profileId = str(profile.id);
  const asker = useAsk(profileId, () => offline || serverDown());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const sending = useRef(false);
  const why = reasons.filter((r) => r.applies_to === "Reprint" && r.disabled !== true);

  const run = (sale: string, number: string, kind: "copy" | "gift") => {
    if (sending.current) return;
    const send = async (approval?: string, reason?: string) => {
      sending.current = true;
      setBusy(true);
      setNote(null);
      try {
        printHtml(await reprint({ profile: profileId, sale, kind, ...(reason ? { reason } : {}), ...(approval ? { approval } : {}) }));
        setNote({ tone: "success", text: kind === "gift" ? tr("Gift receipt printed.") : tr("Copy printed, marked as a copy.") });
      } catch (e) {
        setNote({ tone: "error", text: errorMessage(e) });
      } finally {
        sending.current = false;
        setBusy(false);
      }
    };
    const steps: Ask[] = allows(limits, "Reprint") ? [] : [{ act: "Reprint", figure: 0, why: tr("you may not reprint receipts") }];
    if (!steps.length && !why.length) return void send();
    asker.ask({
      title: kind === "gift" ? tr("Gift receipt for {number}", { number }) : tr("Copy of receipt {number}", { number }),
      sale,
      steps,
      reasons: why.length ? why : undefined,
      done: (got, reason) => void send(got[0]?.id, reason),
    });
  };
  return { busy, note, asker, copy: (sale: string, number: string) => run(sale, number, "copy"), gift: (sale: string, number: string) => run(sale, number, "gift") };
}

/** The receipt to an address or a number, with the consent the buyer gave: for this receipt only, or kept for the ones after. */
function SendDialog({ profile, sale, number, onClose }: { profile: string; sale: string; number: string; onClose: () => void }) {
  const [to, setTo] = useState("");
  const [consent, setConsent] = useState<"once" | "opt_in">("once");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !to.trim() || sent) return;
    setBusy(true);
    setError(null);
    try {
      const done = await sendReceipt({ profile, sale, to: to.trim(), consent });
      setSent(done.sent.map((s) => s.channel ?? "").filter(Boolean));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title={tr("Send receipt {number}", { number })}
      footer={
        sent ? (
          <Button variant="primary" className="pos-btn" data-autofocus onClick={onClose}>
            {tr("Done")}
          </Button>
        ) : (
          <>
            <Button className="pos-btn" onClick={onClose} disabled={busy}>
              {tr("Cancel")}
            </Button>
            <Button variant="primary" className="pos-btn" form="pos-send" type="submit" loading={busy} disabled={!to.trim()}>
              {tr("Send")}
            </Button>
          </>
        )
      }
    >
      <form id="pos-send" className="pos-paying" onSubmit={(e) => void submit(e)}>
        <Field label={tr("Send it to")} htmlFor="send-to" required hint={tr("An email address or a phone number. It is kept in the message log, not on the sale.")}>
          <input id="send-to" className="input" data-autofocus autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={busy || !!sent} value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <fieldset className="pos-paying" disabled={busy || !!sent}>
          <legend className="field-label">{tr("The buyer agrees to")}</legend>
          {(["once", "opt_in"] as const).map((c) => (
            <label key={c} className="pos-check">
              <input type="radio" name="consent" checked={consent === c} onChange={() => setConsent(c)} />
              <span>
                {c === "once" ? tr("This receipt only") : tr("This and later receipts")}
                <span className="faint pos-hint"> {c === "once" ? tr("Nothing is kept for later.") : tr("The register may keep it on their customer record for receipts to come.")}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {sent && <Alert tone="success">{sent.length ? tr("Sent by {channels}.", { channels: sent.join(", ") }) : tr("The register sent it.")}</Alert>}
        {error && <Alert tone="error">{isolate(error)}</Alert>}
      </form>
    </Dialog>
  );
}

/** Copy, gift receipt and send, under a finished sale. */
export default function ReceiptMore({ profile, sale, limits, reasons, offline }: { profile: Doc; sale: Doc; limits: Limits; reasons: Doc[]; offline: boolean }) {
  const r = useReprint(profile, limits, reasons, offline);
  const [sending, setSending] = useState(false);
  const id = str(sale.id);
  const number = str(sale.number);
  return (
    <>
      <div className="pos-quick" role="group" aria-label={tr("More receipts")}>
        <Button icon="printer" disabled={offline || r.busy} onClick={() => r.copy(id, number)} title={offline ? tr("Copies need a connection: the register counts them.") : undefined}>
          {tr("Print a copy")}
        </Button>
        <Button disabled={offline || r.busy || sale.is_return === true} onClick={() => r.gift(id, number)}>
          {tr("Gift receipt")}
        </Button>
        <Button disabled={offline} onClick={() => setSending(true)}>
          {tr("Send by message")}
        </Button>
      </div>
      {offline && <p className="faint pos-hint">{tr("Copies, gift receipts and sending need a connection: the register counts and keeps them.")}</p>}
      {r.note && <Alert tone={r.note.tone}>{isolate(r.note.text)}</Alert>}
      {r.asker.node}
      {sending && <SendDialog profile={str(profile.id)} sale={id} number={number} onClose={() => setSending(false)} />}
    </>
  );
}
