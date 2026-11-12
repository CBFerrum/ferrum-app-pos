import { describe, expect, it } from "vitest";
import { approvalProblem, newPinProblem, pinShape } from "./approval";

describe("a PIN", () => {
  it("is four to twelve digits, the same twice", () => {
    expect(["1234", "123456789012", "123", "1234567890123", "12a4", ""].map(pinShape)).toEqual([true, true, false, false, false, false]);
    expect(newPinProblem("1234", "1234")).toBeNull();
    expect(newPinProblem("1234", "4321")).toMatch(/not the same/);
    expect(newPinProblem("12", "12")).toMatch(/four to twelve/);
  });
});

describe("when the server does not approve", () => {
  it("says a wrong PIN, a lockout and 'not allowed to approve this' plainly", () => {
    expect(approvalProblem({ status: 422, message: "that person's PIN does not match" }, "boss@shop.test")).toBe("That PIN does not match. Check it and try again.");
    expect(approvalProblem({ status: 429, message: "too many wrong PINs" }, "boss@shop.test")).toMatch(/locked for 15 minutes/);
    expect(approvalProblem({ status: 403, message: "boss@shop.test may not approve this either" }, "boss@shop.test")).toMatch(/boss@shop.test may not approve this either/);
    expect(approvalProblem({ status: 400, message: "say why" }, "x")).toBe("say why");
  });

  it("says approvals need a connection when the server cannot be reached", () => {
    for (const status of [undefined, 0, 503]) expect(approvalProblem({ status }, "x")).toMatch(/need a connection/);
  });
});
