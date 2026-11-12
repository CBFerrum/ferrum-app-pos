// Stored value at the till (gift cards, store credit): what the server's `/balance` says of a card
// and what the till checks before it takes one. A card's code and PIN are typed, scanned or made
// for the one request and live in memory only (see `carriesCard`): they are never in the till's
// storage, the held sales or the queue of sales waiting for the connection.

import { t } from "@ferrum/client";

/** A code as typed or scanned: without spaces or dashes, in capitals (`stored_value::normalized`). */
export const normalizedCode = (code: string): string => code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/** A code has at least eight letters or digits (`stored_value::secret`). */
export const codeOk = (code: string): boolean => normalizedCode(code).length >= 8;

/** How a card is shown once it is set: its last four characters. */
export const lastFour = (code: string): string => normalizedCode(code).slice(-4);

/** What `POST /balance` answers. */
export interface CardBalance {
  account: string;
  balance: string;
  holds: "Money" | "Units";
  state: string | null;
  expires_on: string | null;
}

/** Why a card cannot pay `amount` today, or null: it is not active, it expired, or it holds less
 *  (the rule `stored::offline` applies to a card that arrives with a sale). */
export function cardProblem(card: CardBalance, amount: number, today: string): string | null {
  if (card.state && card.state !== "Active") return t("This card is {state}.", { state: card.state.toLowerCase() });
  if (card.expires_on && card.expires_on < today) return t("This card expired on {date}.", { date: card.expires_on });
  if (card.holds === "Money" && amount > Number(card.balance) + 1e-9) return t("The card holds {balance}.", { balance: card.balance });
  return null;
}
