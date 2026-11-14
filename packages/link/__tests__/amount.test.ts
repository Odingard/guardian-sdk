// Console dollar limits (amount declarations) on link.spend.
import * as contracts from "@odingard/guardian-sdk/contracts";
import { describe, expect, it } from "vitest";

import { checkAmountDeclaration, GUARD_ARGUMENT_NAMES } from "../src/amount.js";
import { decideAndRedeem } from "../src/decision.js";
import { LINK_AMOUNT_DECLARATION, sdkCarriesAmountArgument } from "../src/index.js";
import { CONNECTION, fakeGuardian, makeGuard, terms } from "./helpers.js";

/** A stand-in for an SDK whose tool.invoke parameters carry `amountArgument`. */
const NEWER_SDK = { ToolInvokeParametersV1Schema: { shape: { amountArgument: {} } } };
const OLDER_SDK = { ToolInvokeParametersV1Schema: { shape: { arguments: {} } } };

describe("amount declarations", () => {
  it("the guard's arguments are read by the declaration as cents, with the currency checked", () => {
    const args = { ...JSON.parse(JSON.stringify(terms())), merchantHost: "press.stripe.com" };
    expect(args[LINK_AMOUNT_DECLARATION.argument]).toBe(3500);
    expect(args[LINK_AMOUNT_DECLARATION.currencyArgument]).toBe("usd");
    expect(LINK_AMOUNT_DECLARATION).toEqual({ argument: "amount", unit: "minor", currency: "usd", currencyArgument: "currency" });
  });

  it("is refused with an SDK that cannot send it (Guardian would refuse every call)", () => {
    expect(() => checkAmountDeclaration(LINK_AMOUNT_DECLARATION, OLDER_SDK)).toThrow(/needs an @odingard\/guardian-sdk release/);
    expect(sdkCarriesAmountArgument(OLDER_SDK)).toBe(false);
    expect(sdkCarriesAmountArgument(NEWER_SDK)).toBe(true);
  });

  it("only the declaration that reads this guard's amount is accepted", () => {
    expect(checkAmountDeclaration(LINK_AMOUNT_DECLARATION, NEWER_SDK)).toEqual(LINK_AMOUNT_DECLARATION);
    for (const bad of [
      { ...LINK_AMOUNT_DECLARATION, unit: "major" },
      { ...LINK_AMOUNT_DECLARATION, argument: "total" },
      { argument: "amount", unit: "minor", currency: "usd" },
      { ...LINK_AMOUNT_DECLARATION, extra: 1 },
      { ...LINK_AMOUNT_DECLARATION, allowedArguments: ["amount", "currency"] },
    ]) {
      expect(() => checkAmountDeclaration(bad, NEWER_SDK)).toThrow();
    }
    expect(
      checkAmountDeclaration({ ...LINK_AMOUNT_DECLARATION, allowedArguments: [...GUARD_ARGUMENT_NAMES] }, NEWER_SDK),
    ).toMatchObject({ allowedArguments: [...GUARD_ARGUMENT_NAMES] });
  });

  it("the installed SDK decides whether the guard can be built with a declaration", () => {
    const build = () => makeGuard({ amountArgument: LINK_AMOUNT_DECLARATION });
    if (sdkCarriesAmountArgument(contracts)) {
      expect(build).not.toThrow();
      expect(() => makeGuard({ amountArgument: LINK_AMOUNT_DECLARATION, currencies: ["usd", "cad"] })).toThrow(
        /US dollars only/,
      );
    } else {
      expect(build).toThrow(/needs an @odingard\/guardian-sdk release/);
    }
  });

  it("the declaration is echoed on the request and must match on the receipt", async () => {
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const cfg = {
      guardian,
      connectionId: CONNECTION,
      requestTtlMs: 5_000,
      pollMs: 2,
      callTimeoutMs: 1_000,
      amountArgument: LINK_AMOUNT_DECLARATION,
      now: Date.now,
    };
    await decideAndRedeem(cfg, "link.spend", { amount: 3500, currency: "usd" }, "p", false);
    expect(guardian.requests[0].amountArgument).toEqual(LINK_AMOUNT_DECLARATION);

    // A receipt approved under another declaration is refused.
    const other = fakeGuardian({
      decide: () => "ASK",
      receiptAmountArgument: { ...LINK_AMOUNT_DECLARATION, unit: "major" },
    });
    await expect(
      decideAndRedeem({ ...cfg, guardian: other }, "link.spend", { amount: 3500, currency: "usd" }, "p", false),
    ).rejects.toMatchObject({ code: "RECEIPT_CHECK_FAILED" });
  });
});
