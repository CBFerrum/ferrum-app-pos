// Stored value at the till: a card's code and PIN go in boxes, are sent in the one request that
// needs them (the sale, `/balance`, the return) and are dropped; a code the server makes is shown
// once, to print or hand over. Nothing here writes a code or PIN to storage, the held sales or the
// queue of sales waiting for the connection.

import { useState } from "react";
import { errorMessage, t as tr, isolate } from "@ferrum/client";
import { Alert, Button, Dialog, Field } from "@ferrum/kit";
import type { Doc } from "@ferrum/records";
import { madeCode } from "./lib/server";
import { esc, printPage } from "./lib/pos";
import { codeOk } from "./lib/stored";
import { printHtml } from "./print";

/** Has the server make a new card's code (the kind's `prove`, which answers a made code once and keeps only its hashes). */
export async function makeCode(kind: string): Promise<string> {
  const { code } = await madeCode(kind);
  if (typeof code !== "string" || !code) throw new Error(tr("The server made no code."));
  return code;
}

/** A made code, shown once: to print on the card or read out. It is not shown again. */
export function CodeOnce({ profile, code, onClose }: { profile: Doc; code: string; onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={tr("New card code")}
      description={tr("Shown once. Print it or hand it over before you close this: the till keeps only its last four characters.")}
      footer={
        <>
          <Button icon="printer" onClick={() => printHtml(printPage(profile, tr("Card code"), `<h1>${esc(tr("Card code"))}</h1><p><b style="font-size:16px">${esc(code)}</b></p>`))}>
            {tr("Print the code")}
          </Button>
          <Button variant="primary" className="pos-btn" data-autofocus onClick={onClose}>
            {tr("Done")}
          </Button>
        </>
      }
    >
      <p className="pos-code">
        {isolate(code)}
      </p>
    </Dialog>
  );
}

/** The two boxes of a card: its code (a scanner types into it and presses Enter) and its PIN. */
export function CardInputs({
  id,
  code,
  pin,
  onCode,
  onPin,
  onEnter,
}: {
  id: string;
  code: string;
  pin: string;
  onCode: (v: string) => void;
  onPin: (v: string) => void;
  onEnter?: () => void;
}) {
  const enter = (e: { key: string; preventDefault: () => void }) => {
    if (e.key === "Enter" && onEnter) {
      e.preventDefault();
      onEnter();
    }
  };
  return (
    <>
      <Field label={tr("Card code")} htmlFor={`${id}-code`} hint={tr("Scan the card or type its code.")}>
        <input id={`${id}-code`} className="input" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => onCode(e.target.value)} onKeyDown={enter} />
      </Field>
      <Field label={tr("PIN, if the card has one")} htmlFor={`${id}-pin`}>
        <input id={`${id}-pin`} className="input" type="password" inputMode="numeric" autoComplete="off" maxLength={12} value={pin} onChange={(e) => onPin(e.target.value.replace(/\D/g, ""))} onKeyDown={enter} />
      </Field>
    </>
  );
}

/** A line that sells or tops up a card: its code, scanned or typed, or one the server makes. */
export function CardLine({
  profile,
  line,
  kind,
  set,
  away,
  onUse,
}: {
  profile: Doc;
  line: string;
  kind: string;
  /** The last four characters of the code already set on this line. */
  set: string | null;
  away: boolean;
  onUse: (code: string, pin?: string) => void;
}) {
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [made, setMade] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const use = () => {
    if (!codeOk(code)) return;
    onUse(code.trim(), pin.trim() || undefined);
    setCode("");
    setPin("");
  };
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const fresh = await makeCode(kind);
      onUse(fresh, pin.trim() || undefined);
      setPin("");
      setMade(fresh);
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  };
  return (
    <div className="pos-card">
      <p className="pos-edit-info">{set ? tr("Card ending {last} is set. Scan another code to change it.", { last: set }) : tr("Scan or type the card's code before paying.")}</p>
      <CardInputs id={`card-${line}`} code={code} pin={pin} onCode={setCode} onPin={setPin} onEnter={use} />
      <div className="pos-edit-actions">
        <Button className="pos-btn" disabled={!codeOk(code)} onClick={use}>
          {tr("Use this card")}
        </Button>
        <Button className="pos-btn" loading={busy} disabled={away} title={away ? tr("A new code is made by the server: it needs a connection.") : undefined} onClick={() => void make()}>
          {tr("Make a new code")}
        </Button>
      </div>
      {error && <Alert tone="error">{isolate(error)}</Alert>}
      {made && <CodeOnce profile={profile} code={made} onClose={() => setMade(null)} />}
    </div>
  );
}
