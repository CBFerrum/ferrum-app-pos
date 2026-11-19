import { beforeEach, describe, expect, it } from "vitest";
import { isLocked, keepLocked, peopleOf, servingProblem } from "./serving";

beforeEach(() => {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
    configurable: true,
  });
});

describe("someone else serving at the till", () => {
  it("offers the session's cashier first, then the register's allowed users once each", () => {
    const profile = { users: [{ user: "ravi@shop.test" }, { user: "Asha@Shop.test" }, { user: "RAVI@shop.test" }, { user: " " }, { user: "meera@shop.test" }] };
    expect(peopleOf(profile, "asha@shop.test")).toEqual(["asha@shop.test", "ravi@shop.test", "meera@shop.test"]);
    expect(peopleOf({}, "asha@shop.test")).toEqual(["asha@shop.test"]);
  });

  it("says why the till was not handed over", () => {
    expect(servingProblem({ status: 0 }, "ravi@shop.test")).toBe("Switching people needs a connection.");
    expect(servingProblem({ status: 503 }, "ravi@shop.test")).toBe("Switching people needs a connection.");
    expect(servingProblem({ status: 429, message: "too many wrong PINs" }, "ravi@shop.test")).toContain("locked for 15 minutes");
    expect(servingProblem({ status: 403, message: "ravi@shop.test is not allowed at register Counter" }, "ravi@shop.test")).toBe("ravi@shop.test does not work at this till.");
    expect(servingProblem({ status: 422, message: "that person's PIN does not match" }, "ravi@shop.test")).toBe("That PIN does not match. Check it and try again.");
    expect(servingProblem({ status: 422, message: "operator: you answer for this session already" }, "x")).toContain("you answer for this session already");
  });

  it("keeps a locked till locked across a reload, per session", () => {
    expect(isLocked("s1")).toBe(false);
    keepLocked("s1", true);
    expect([isLocked("s1"), isLocked("s2")]).toEqual([true, false]);
    keepLocked("s1", false);
    expect(isLocked("s1")).toBe(false);
  });
});
