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
