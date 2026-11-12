// Asking another person to approve what is beyond the cashier's limits, on the cashier's own till:
// who approves (the server offers no list of people who may, so their email), their PIN (masked,
// sent in the one request and dropped from state before it goes), and why. One approval is for one
// act on this sale and is attached to it; wrong PIN, a lockout and a person who may not approve
// this are said plainly. The same dialog asks for the reason a line or a sale is voided. Approvals
// need the connection: a PIN cannot be checked on the device. Also "Set my PIN".

import { useCallback, useState, type FormEvent, type ReactNode } from "react";
import { t as tr, isolate } from "@ferrum/client";
import { Alert, Button, Dialog, Field, toast } from "@ferrum/kit";
import type { Doc } from "@ferrum/records";
import { str } from "./fmt";
import { approvalProblem, newPinProblem } from "./lib/approval";
import { till } from "./lib/offline";
import type { Act, Approval, Ask } from "./lib/rights";

const ACT_WORDS: Record<Act, () => string> = {
  Discount: () => tr("A discount beyond your limit"),
  "Price Change": () => tr("A price change"),
  "Void Line": () => tr("Taking a line off the sale"),
  "Void Sale": () => tr("Voiding a sale"),
  Refund: () => tr("A refund beyond your limit"),
  "Return Without Receipt": () => tr("A return without a receipt"),
  "No Sale": () => tr("Opening the drawer without a sale"),
  Reprint: () => tr("A reprint"),
};

export interface AskProps {
  profile: string;
  /** The sale (its own id) the approvals are for. */
  sale: string;
  title: string;
  /** What is to be approved, one person's PIN for each; none when only a reason is wanted. */
  steps: Ask[];
  /** The business's reasons to choose from (`PosReason`); the chosen one's id comes back. */
  reasons?: Doc[];
  /** The till cannot reach the server: nothing can be approved. */
  offline: boolean;
  onDone: (approvals: Approval[], reason?: string) => void;
  onClose: () => void;
}

export function AskDialog({ profile, sale, title, steps, reasons, offline, onDone, onClose }: AskProps) {
  const [got, setGot] = useState<Approval[]>([]);
  const [reason, setReason] = useState(str(reasons?.[0]?.id));
  const [why, setWhy] = useState("");
  const [approver, setApprover] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const step = steps[got.length];
  const reasonName = reasons?.find((r) => str(r.id) === reason)?.reason;
  const text = (reasons ? str(reasonName) : why).trim();
  const stuck = !!step && offline;
  const ready = !stuck && (!reasons || !!reason) && (!step || (!!text && !!approver.trim() && pin.length > 0));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    if (!step) return onDone(got, reasons ? reason : undefined);
    // The PIN is read, then dropped from state, before the request goes: a wrong one is typed again.
    const secret = pin;
    setPin("");
    setBusy(true);
    setError(null);
    try {
      const body = { profile, approver: approver.trim(), pin: secret, action: step.act, reason: text, sale, ...(step.figure && !step.money ? { amount: String(step.figure) } : {}) };
      const res = await till<{ approval: string }>("/api/app/pos/approve", { method: "POST", body });
      const next = [...got, { id: res.approval, act: step.act, figure: step.figure, ...(step.money ? { money: true } : {}), by: approver.trim() }];
      if (next.length < steps.length) {
        setGot(next);
        setApprover("");
        setBusy(false);
      } else onDone(next, reasons ? reason : undefined);
    } catch (err) {
      setError(approvalProblem(err as { status?: number; message?: string }, approver.trim()));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title={title}
      description={step && steps.length > 1 ? tr("Approval {n} of {total}", { n: got.length + 1, total: steps.length }) : undefined}
      footer={
        <>
          <Button className="pos-btn" onClick={onClose} disabled={busy}>
            {tr("Cancel")}
          </Button>
          <Button variant="primary" className="pos-btn" form="pos-ask" type="submit" loading={busy} disabled={!ready}>
            {step ? tr("Approve") : tr("Confirm")}
          </Button>
        </>
      }
    >
      <form id="pos-ask" className="pos-paying" onSubmit={(e) => void submit(e)}>
        {step && (
          <p>
            <strong>{ACT_WORDS[step.act]()}.</strong> {isolate(step.why)}. {tr("Another person types their PIN to approve it.")}
          </p>
        )}
        {stuck && <Alert tone="warning">{tr("Approvals need a connection: a PIN cannot be checked on this device. Try again when the till is back online.")}</Alert>}
        {reasons && (
          <Field label={tr("Reason")} htmlFor="ask-reason" required>
            <select id="ask-reason" className="input" data-autofocus value={reason} onChange={(e) => setReason(e.target.value)}>
              {reasons.map((r) => (
                <option key={str(r.id)} value={str(r.id)}>
                  {str(r.reason)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {step && !reasons && (
          <Field label={tr("Why")} htmlFor="ask-why" required>
            <input id="ask-why" className="input" data-autofocus maxLength={140} autoComplete="off" value={why} onChange={(e) => setWhy(e.target.value)} />
          </Field>
        )}
        {step && (
          <>
            <Field label={tr("Who approves")} htmlFor="ask-who" required hint={tr("Their email: someone whose limits allow it.")}>
              <input id="ask-who" className="input" type="email" autoComplete="off" autoCapitalize="off" spellCheck={false} value={approver} onChange={(e) => setApprover(e.target.value)} />
            </Field>
            <Field label={tr("Their PIN")} htmlFor="ask-pin" required>
              <input id="ask-pin" className="input pos-amount" type="password" inputMode="numeric" autoComplete="off" maxLength={12} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
            </Field>
          </>
        )}
        {error && <Alert tone="error">{isolate(error)}</Alert>}
      </form>
    </Dialog>
  );
}

/** Opens the dialog for one question at a time; `node` is drawn once, wherever the screen likes. */
export function useAsk(profile: string, offline: () => boolean) {
  const [open, setOpen] = useState<Omit<AskProps, "profile" | "offline" | "onClose" | "onDone"> & { done: AskProps["onDone"] } | null>(null);
  const ask = useCallback((q: NonNullable<typeof open>) => setOpen(q), []);
  const node: ReactNode = open && (
    <AskDialog
      profile={profile}
      offline={offline()}
      sale={open.sale}
      title={open.title}
      steps={open.steps}
      reasons={open.reasons}
      onClose={() => setOpen(null)}
      onDone={(approvals, reason) => {
        setOpen(null);
        open.done(approvals, reason);
      }}
    />
  );
  return { ask, node, open: open !== null };
}

/** Setting one's own PIN, which another cashier's till then accepts as approval when the limits allow. */
export function SetPinDialog({ offline, onClose }: { offline: boolean; onClose: () => void }) {
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = newPinProblem(pin, again);
  const digits = (set: (v: string) => void) => (e: { target: { value: string } }) => set(e.target.value.replace(/\D/g, ""));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem || busy || offline) return;
    const secret = pin;
    setPin("");
    setAgain("");
    setBusy(true);
    setError(null);
    try {
      await till("/api/app/pos/pin", { method: "POST", body: { pin: secret } });
      toast(tr("Your PIN is set"));
      onClose();
    } catch (err) {
      setError(approvalProblem(err as { status?: number; message?: string }, ""));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title={tr("Set my PIN")}
      description={tr("Another cashier's till takes your PIN as approval, as far as your limits allow. Only you know it; it is kept scrambled.")}
      footer={
        <>
          <Button className="pos-btn" onClick={onClose} disabled={busy}>
            {tr("Cancel")}
          </Button>
          <Button variant="primary" className="pos-btn" form="pos-pin" type="submit" loading={busy} disabled={!!problem || offline}>
            {tr("Set PIN")}
          </Button>
        </>
      }
    >
      <form id="pos-pin" className="pos-paying" onSubmit={(e) => void submit(e)}>
        {offline && <Alert tone="warning">{tr("Setting a PIN needs a connection.")}</Alert>}
        <Field label={tr("New PIN")} htmlFor="pin-new" required hint={tr("Four to twelve digits.")}>
          <input id="pin-new" className="input pos-amount" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} data-autofocus value={pin} onChange={digits(setPin)} />
        </Field>
        <Field label={tr("Type it again")} htmlFor="pin-again" required error={pin && again && problem && pin !== again ? problem : undefined}>
          <input id="pin-again" className="input pos-amount" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={again} onChange={digits(setAgain)} />
        </Field>
        {error && <Alert tone="error">{isolate(error)}</Alert>}
      </form>
    </Dialog>
  );
}
