import { describe, expect, it } from "vitest";
import { cardProblem, codeOk, lastFour, normalizedCode, type CardBalance } from "./stored";

const card: CardBalance = { account: "a1", balance: "50.00", holds: "Money", state: "Active", expires_on: "2027-01-31" };

describe("a card's code", () => {
  it("is read without spaces or dashes, in capitals, and needs eight letters or digits", () => {
    expect(normalizedCode(" 7kq2-m9xd ")).toBe("7KQ2M9XD");
    expect([codeOk("7KQ2-M9XD"), codeOk("7KQ2-M9X"), codeOk("")]).toEqual([true, false, false]);
    expect(lastFour("7KQ2-M9XD-4TRB")).toBe("4TRB");
  });
});

describe("whether a card can pay", () => {
  it("takes what it holds, while it is active and has not expired", () => {
    expect(cardProblem(card, 50, "2026-11-12")).toBeNull();
    expect(cardProblem(card, 50.01, "2026-11-12")).toBe("The card holds 50.00.");
    expect(cardProblem({ ...card, state: "Frozen" }, 10, "2026-11-12")).toBe("This card is frozen.");
    expect(cardProblem({ ...card, expires_on: "2026-11-11" }, 10, "2026-11-12")).toBe("This card expired on 2026-11-11.");
    expect(cardProblem({ ...card, expires_on: "2026-11-12" }, 10, "2026-11-12")).toBeNull();
    expect(cardProblem({ ...card, state: null, expires_on: null }, 10, "2026-11-12")).toBeNull();
    expect(cardProblem({ ...card, holds: "Units", balance: "5" }, 10, "2026-11-12")).toBeNull();
  });
});
