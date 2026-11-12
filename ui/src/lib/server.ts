// The till's calls to what 0.6.0 added on the server, each with the shape a walk against a running
// server recorded (path, method, body, and what comes back). Every component goes through here, so
// that these shapes are written once and pinned by `server.test.ts` with the recorded answers.

import { docPath } from "@ferrum/client";
import type { Doc } from "@ferrum/records";
import { till } from "./offline";
import type { Act } from "./rights";
import type { CardBalance } from "./stored";

/** `POST /approve`: another person's PIN approves one act on one sale (`sale`: the id the till gives the sale
 *  and sends again as the sale's `id`). `amount` is a discount's percent or a refund in money; a void, and a
 *  discount counted in money on the whole sale, send none. */
export interface ApproveAsk {
  profile: string;
  approver: string;
  pin: string;
  action: Act;
  amount?: string;
  reason: string;
  sale: string;
}
export const approve = (body: ApproveAsk) => till<{ action: string; approval: string; approver: string }>("/api/app/pos/approve", { method: "POST", body });

/** `POST /pin`: the signed-in person sets their own PIN (4 to 12 digits). */
export const setPin = (pin: string) => till<{ ok: boolean }>("/api/app/pos/pin", { method: "POST", body: { pin } });

/** `POST /balance`: what a card of a Stored Value payment method (`mode`) holds. */
export const cardBalance = (mode: string, code: string, pin?: string) =>
  till<CardBalance>("/api/app/pos/balance", { method: "POST", body: { mode, code, ...(pin ? { pin } : {}) } });

/** The kind's `prove` for an issue with no code: the server makes one and answers it once,
 *  `{proof, code, expires_in_minutes}` (the proof is not used: the card is sold, or loaded, by its code on the sale). */
export const madeCode = (kind: string) =>
  till<{ proof: string; code: string | null; expires_in_minutes: number }>(docPath("StoredValueKind", kind, "actions", "prove"), { method: "POST", body: { operation: "issue" } });

/** The `void` action on a sale not yet closed: a reason (a `PosReason` that applies to Void) and, for someone
 *  whose limits do not allow it, an approval of `Void Sale`. */
export const voidSale = (sale: string, reason: string | undefined, approval?: string) =>
  till<{ status: string }>(docPath("PosInvoice", sale, "actions", "void"), { method: "POST", body: { reason, ...(approval ? { approval } : {}) } });

/** `POST /exchange`: a return (`back`, negative quantities) and a sale (`out`) in one transaction. Answers
 *  both as submitted invoices, linked by `exchange`, and the split as text: what the return carries to the
 *  sale, what the customer still pays, what goes back. */
export interface ExchangeAnswer {
  carried: string;
  due: string;
  refund: string;
  return: Doc;
  sale: Doc;
}
export const exchange = (back: Doc, out: Doc, key: string) => till<ExchangeAnswer>("/api/app/pos/exchange", { method: "POST", body: { back, out }, idempotencyKey: key });

// ── what 0.7.0 added: the receipt's papers, the refund plan, the snapshot, the shift's papers, price differences ──

const PAPER = "text/html";

/** `GET /receipt/{sale}?profile=`: the sale's first receipt as the server's template (`pos.receipt`) renders it, a page to print.
 *  Given once: the server marks it printed under the sale's lock, and a second ask is refused ("ask for a copy"). */
export const firstReceipt = (profile: string, sale: string) => till<string>(`/api/app/pos/receipt/${encodeURIComponent(sale)}`, { query: { profile }, accept: PAPER });

/** `POST /reprint`: a copy (marked COPY n, counted, kept with who, when, why and by whose approval) or a gift receipt (no prices),
 *  as a page to print. `reason` is one of the business's reprint reasons (its id or its words) when it has some; `approval` another
 *  person's, for someone whose limits do not allow reprints (it covers one copy). */
export interface ReprintAsk {
  profile: string;
  sale: string;
  kind: "copy" | "gift";
  reason?: string;
  approval?: string;
}
export const reprint = (ask: ReprintAsk) => till<string>("/api/app/pos/reprint", { method: "POST", body: ask, accept: PAPER });

/** `POST /send`: the receipt by message to an address or number, with the buyer's consent: for this receipt only, or kept for more.
 *  Answers the event and what the channels sent (the receipt attached when the workspace keeps files). */
export interface SendAsk {
  profile: string;
  sale: string;
  to: string;
  consent: "once" | "opt_in";
}
export const sendReceipt = (ask: SendAsk) => till<{ event: string; sent: { channel?: string }[]; receipt: string | null }>("/api/app/pos/send", { method: "POST", body: ask });

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
