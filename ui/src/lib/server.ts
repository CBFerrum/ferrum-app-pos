// The till's calls to what 0.6.0 added on the server, each with the shape a walk against a running
// server recorded (path, method, body, and what comes back). Every component goes through here, so
// that these shapes are written once and pinned by `server.test.ts` with the recorded answers.

import { docPath, errorMessage, newKey, t } from "@ferrum/client";
import type { Doc } from "@ferrum/records";
import { till, unreachable } from "./offline";
import type { Act } from "./rights";
import type { CardBalance } from "./stored";

/** The `approve` action of the cashier's open session (`session`): another person's PIN approves one act on one sale
 *  (`sale`: the id the till gives the sale and sends again as the sale's `id`). `amount` is a discount's percent or a
 *  refund in money; a void, and a discount counted in money on the whole sale, send none. A new key for each press: a
 *  resend of the same request is answered once, and an approval whose answer was lost lapses unused. */
export interface ApproveAsk {
  session: string;
  approver: string;
  pin: string;
  action: Act;
  amount?: string;
  reason: string;
  sale: string;
}
export const approve = ({ session, action, ...rest }: ApproveAsk) =>
  till<{ action: string; approval: string; approver: string }>(docPath("PosOpeningEntry", session, "actions", "approve"), { method: "POST", body: { ...rest, act: action }, idempotencyKey: newKey() });

/** The `set_pin` action of a register (`profile`): the signed-in person sets their own PIN (4 to 12 digits). */
export const setPin = (profile: string, pin: string) =>
  till<{ ok: boolean }>(docPath("PosProfile", profile, "actions", "set_pin"), { method: "POST", body: { pin }, idempotencyKey: newKey() });

/** `POST /balance`: what a card of a Stored Value payment method (`mode`) holds. */
export const cardBalance = (mode: string, code: string, pin?: string) =>
  till<CardBalance>("/api/app/pos/balance", { method: "POST", body: { mode, code, ...(pin ? { pin } : {}) } });

/** A held sale's record at the register (`pos.pos_held_sale.create`), under `held:{key}`: sent again it is answered; made
 *  meanwhile under another key, it is refused as there already (409). */
export const holdSale = (body: Doc) => till<Doc>(docPath("PosHeldSale"), { method: "POST", body, idempotencyKey: `held:${String(body.id)}` });

/** The most held sales a register's list is read with: an answer with fewer is the whole list. */
export const HELD_PAGE = 200;

/** The register's held sales the person may see (their own; a manager, everyone's), newest first. */
export const heldSales = (profile: string, signal?: AbortSignal) =>
  till<{ rows: Doc[] }>(docPath("PosHeldSale"), {
    query: { filters: JSON.stringify({ pos_profile: profile }), fields: "id,cashier,customer,customer_title,held_at,total,cart", limit: HELD_PAGE, sort: "held_at desc" },
    signal,
  });

/** A held sale resumed or discarded (`pos.pos_held_sale.delete`); a second delete is "not found". */
export const dropHeld = (key: string) => till<unknown>(docPath("PosHeldSale", key), { method: "DELETE" });

/** The kind's `prove` for an issue with no code: the server makes one and answers it once,
 *  `{proof, code, expires_in_minutes}` (the proof is not used: the card is sold, or loaded, by its code on the sale). */
export const madeCode = (kind: string) =>
  till<{ proof: string; code: string | null; expires_in_minutes: number }>(docPath("StoredValueKind", kind, "actions", "prove"), { method: "POST", body: { operation: "issue" } });

/** The `void` action on a sale not yet closed: a reason (a `PosReason` that applies to Void) and, for someone
 *  whose limits do not allow it, an approval of `Void Sale`. */
export const voidSale = (sale: string, reason: string | undefined, approval?: string) =>
  till<{ status: string }>(docPath("PosInvoice", sale, "actions", "void"), { method: "POST", body: { reason, ...(approval ? { approval } : {}) } });

/** An exchange: a return (`back`, negative quantities, with its refunds as `payments`) and a sale (`out`, with its tender) at once,
 *  each half under the id the till gave it. Four steps, each safe to repeat with the same ids: the return's draft and the sale's draft
 *  are made (`pos.pos_invoice.create`, keyed by their ids), the return's `exchange` action submits both and links them, and the sale is
 *  read back for the receipt. Lost on the way: the error is thrown as it is, the caller keeps the ids and presses again. Refused: both
 *  drafts are deleted (as far as they can be), the refusal is said, and the caller makes new ids for the next try. */
export interface ExchangeAnswer {
  carried: string;
  due: string;
  refund: string;
  /** The return's id. */
  return: string;
  sale: Doc;
}
export async function exchange(back: Doc, out: Doc): Promise<ExchangeAnswer> {
  const [b, o] = [String(back.id), String(out.id)];
  let done: { return: string; sale: string; carried: string; due: string; refund: string };
  try {
    await till<Doc>(docPath("PosInvoice"), { method: "POST", body: { ...back, is_return: true }, idempotencyKey: b });
    await till<Doc>(docPath("PosInvoice"), { method: "POST", body: out, idempotencyKey: o });
    done = await till(docPath("PosInvoice", b, "actions", "exchange"), { method: "POST", body: { out: o }, idempotencyKey: `exchange:${b}` });
  } catch (e) {
    if (unreachable(e)) throw e;
    for (const id of [o, b]) await till(docPath("PosInvoice", id), { method: "DELETE" }).catch(() => undefined);
    throw new Error(`${t("That did not go through, and nothing was exchanged.")} ${errorMessage(e)}`);
  }
  const sale = await till<Doc>(docPath("PosInvoice", done.sale));
  return { carried: done.carried, due: done.due, refund: done.refund, return: done.return, sale };
}

// ── what 0.7.0 added: the receipt's papers, the refund plan, the snapshot, the shift's papers, price differences ──

const PAPER = "text/html";

/** What a receipt action answers: the event that keeps who asked, when and why, and whose page `paper` gives. */
export interface ReceiptEvent {
  event: string;
  kind: string;
  copy_no?: number | null;
}

/** The `print_receipt` action of the cashier's open session: the sale's first receipt, once (an event of kind `Original`). The key is the
 *  sale's own, so a press whose answer was lost is answered with the same event; a second ask is refused ("ask for a copy"). */
export const printReceipt = (session: string, sale: string) =>
  till<ReceiptEvent>(docPath("PosOpeningEntry", session, "actions", "print_receipt"), { method: "POST", body: { sale }, idempotencyKey: `print:${sale}` });

/** `GET /paper/{event}`: the page of a receipt event (the first receipt, a copy marked COPY n, a gift receipt) as the server's templates
 *  render it, for the person who asked for it or someone who may read the event. */
export const paper = (event: string) => till<string>(`/api/app/pos/paper/${encodeURIComponent(event)}`, { accept: PAPER });

/** The `reprint` action of the cashier's open session: a copy (counted, kept with who, when, why and by whose approval) or a gift receipt
 *  (no prices). `reason` is one of the business's reprint reasons (its id or its words) when it has some; `approval` another person's, for
 *  someone whose limits do not allow reprints (it covers one copy). A new key for each press. */
export interface ReprintAsk {
  sale: string;
  kind: "copy" | "gift";
  reason?: string;
  approval?: string;
}
export const reprint = (session: string, ask: ReprintAsk) =>
  till<ReceiptEvent>(docPath("PosOpeningEntry", session, "actions", "reprint"), { method: "POST", body: ask, idempotencyKey: newKey() });

/** The `send_receipt` action of the cashier's open session: the receipt by message to an address or number, with the buyer's consent: for
 *  this receipt only, or kept for more. `key` is the same for the same sale, address and consent until it goes through, so a press whose
 *  answer was lost does not send twice. Answers the event, the channels it went by and whether the receipt went with it as a file. */
export interface SendAsk {
  sale: string;
  to: string;
  consent: "once" | "opt_in";
}
export const sendReceipt = (session: string, ask: SendAsk, key: string) =>
  till<{ event: string; channels: string[]; attached: boolean }>(docPath("PosOpeningEntry", session, "actions", "send_receipt"), { method: "POST", body: ask, idempotencyKey: key });

/** `POST /returns/{sale}/plan`: what a return of those lines (the sale's line ids, a positive quantity, a condition) is worth and how the
 *  register proposes to refund it: a proposal, the return is still checked whatever is sent. With `out` (the goods going out, as sale lines) it
 *  is an exchange: the register prices them as a sale to the same customer and says the rest (`exchange`). The till shows that, and works out nothing. */
export interface RefundProposal {
  total: string;
  /** With `out` (an exchange): what the goods going out come to, what the return carries over to them, what the customer still pays and what is refunded
   *  (the only amount `refunds` plans). Null for a return alone. */
  exchange: { out_total: string; carried: string; due: string; refund: string } | null;
  refunds: { mode: string; name: string | null; kind: string | null; amount: string }[];
  /** What no method of this register can take back. */
  unplaced: string;
}
export const returnPlan = (profile: string, sale: string, lines: { line: string; qty: string; condition?: string }[], out?: Doc[], signal?: AbortSignal) =>
  till<RefundProposal>(`/api/app/pos/returns/${encodeURIComponent(sale)}/plan`, { method: "POST", body: { profile, lines, ...(out?.length ? { out } : {}) }, signal });

/** A record on paper by one of the app's document templates (`pos.shift_report` on a closing, `pos.cash_slip` on a cash movement). */
export const paperOf = (entity: string, id: string, template: string) => till<string>(docPath(entity, id, "print"), { query: { template, format: "html" }, accept: PAPER });

/** The `review` action on a Price Difference: what was found and done. */
export const reviewDifference = (id: string, resolution: string) =>
  till<unknown>(docPath("PosPriceDifference", id, "actions", "review"), { method: "POST", body: { resolution } });
