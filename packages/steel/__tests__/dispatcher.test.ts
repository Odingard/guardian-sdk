import { describe, expect, it, vi } from "vitest";
import type { GuardianClient } from "@odingard/guardian-sdk";

import {
  HOSTED_RECORD_ONLY_RESULT_DIGEST,
  STEEL_CHECKOUT_TOOL,
  SteelCheckoutArgumentsSchema,
  createGuardianSteelDispatcher,
} from "../src/index.js";

const order = SteelCheckoutArgumentsSchema.parse({
  merchantId: "fixture-shop.guardian.test",
  sku: "WIDGET-1",
  quantity: 1,
  expectedTotalCents: 4200,
  currency: "USD",
  shipTo: { name: "A", line1: "1 Main", city: "X", postalCode: "1", country: "US" },
});

const receipt = { status: "sent-verified" } as never;

function client(overrides: Partial<GuardianClient>): GuardianClient {
  return {
    request: vi.fn(),
    claim: vi.fn(),
    execute: vi.fn().mockResolvedValue({ ok: true, receipt }),
    receipts: vi.fn(),
    // A protected Steel executor's recorded result (not the hosted digest).
    portableReceipt: vi.fn().mockResolvedValue({
      ok: true,
      receipt: { execution: { sentRef: { resultDigest: "a".repeat(64) } } },
    }),
    ...overrides,
  } as unknown as GuardianClient;
}

const connectionId = "pcn_0123456789abcdef0123456789abcdef";

describe("Guardian for Steel dispatcher", () => {
  it("proposes steel.checkout.submit and executes only on ALLOW", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      decision: "ALLOW",
      requestId: "req_1",
      capabilityToken: "cap",
    });
    const guardian = client({ request });
    const out = await createGuardianSteelDispatcher({ guardian, connectionId }).submitOrder(order);
    expect(request.mock.calls[0]![0]).toMatchObject({ toolName: STEEL_CHECKOUT_TOOL });
    expect(out.status).toBe("executed");
  });

  it("holds an ASK and never executes until resume", async () => {
    const guardian = client({
      request: vi.fn().mockResolvedValue({
        ok: false,
        reasonCode: "APPROVAL_REQUIRED",
        requestId: "req_2",
      }),
      claim: vi.fn().mockResolvedValue({
        ok: true,
        decision: "ALLOW",
        requestId: "req_2",
        capabilityToken: "cap",
      }),
    });
    const d = createGuardianSteelDispatcher({ guardian, connectionId });
    expect(await d.submitOrder(order)).toEqual({
      status: "pending-approval",
      requestId: "req_2",
    });
    expect(guardian.execute).not.toHaveBeenCalled();
    expect((await d.resume("req_2")).status).toBe("executed");
  });

  it("DENY and an unreachable Guardian both refuse without executing", async () => {
    const denied = client({
      request: vi.fn().mockResolvedValue({ ok: true, decision: "DENY", requestId: "r", reasonCode: "OVER_LIMIT" }),
    });
    expect((await createGuardianSteelDispatcher({ guardian: denied, connectionId }).submitOrder(order)).status).toBe("denied");
    const down = client({ request: vi.fn().mockRejectedValue(new Error("down")) });
    expect(await createGuardianSteelDispatcher({ guardian: down, connectionId }).submitOrder(order)).toEqual({
      status: "denied",
      reasonCode: "GUARDIAN_UNAVAILABLE",
    });
    expect(denied.execute).not.toHaveBeenCalled();
    expect(down.execute).not.toHaveBeenCalled();
  });

  it("an unreachable Guardian, as the SDK client reports it, refuses with SERVICE_UNAVAILABLE", async () => {
    // The real client never throws on a network failure: it answers
    // ok:false SERVICE_UNAVAILABLE (fail closed).
    const down = client({
      request: vi.fn().mockResolvedValue({ ok: false, reasonCode: "SERVICE_UNAVAILABLE" }),
    });
    expect(await createGuardianSteelDispatcher({ guardian: down, connectionId }).submitOrder(order)).toEqual({
      status: "denied",
      reasonCode: "SERVICE_UNAVAILABLE",
    });
    expect(down.execute).not.toHaveBeenCalled();
  });

  it("a Guardian without a protected Steel executor is never reported as an order placed", async () => {
    const allowOnce = vi.fn().mockResolvedValue({
      ok: true,
      decision: "ALLOW",
      requestId: "req_h",
      capabilityToken: "cap",
    });
    const recordOnly = (digest: string) =>
      vi.fn().mockResolvedValue({
        ok: true,
        receipt: { execution: { sentRef: { resultDigest: digest } } },
      });
    const hosted = client({ request: allowOnce, portableReceipt: recordOnly(HOSTED_RECORD_ONLY_RESULT_DIGEST) });
    expect(await createGuardianSteelDispatcher({ guardian: hosted, connectionId }).submitOrder(order)).toMatchObject({
      status: "not-executed",
      requestId: "req_h",
      reasonCode: "NO_PROTECTED_EXECUTOR",
    });
    const protectedSide = client({ request: allowOnce, portableReceipt: recordOnly("sha256:" + "a".repeat(64)) });
    expect((await createGuardianSteelDispatcher({ guardian: protectedSide, connectionId }).submitOrder(order)).status).toBe(
      "executed",
    );
  });

  it("an unconfirmed outcome is outcome-unknown (do not retry), and only not-sent is not-executed", async () => {
    const allowOnce = () =>
      vi.fn().mockResolvedValue({ ok: true, decision: "ALLOW", requestId: "req_u", capabilityToken: "cap" });
    for (const status of ["outcome-pending", "outcome-unconfirmed"]) {
      const guardian = client({
        request: allowOnce(),
        execute: vi.fn().mockResolvedValue({ ok: true, receipt: { status } }),
      });
      expect(await createGuardianSteelDispatcher({ guardian, connectionId }).submitOrder(order)).toMatchObject({
        status: "outcome-unknown",
        requestId: "req_u",
        receiptStatus: status,
      });
    }
    const notSent = client({
      request: allowOnce(),
      execute: vi.fn().mockResolvedValue({ ok: true, receipt: { status: "not-sent" } }),
    });
    expect(await createGuardianSteelDispatcher({ guardian: notSent, connectionId }).submitOrder(order)).toMatchObject({
      status: "not-executed",
      receiptStatus: "not-sent",
    });
  });

  it("a signed receipt that cannot be read is outcome-unknown, never executed", async () => {
    for (const portableReceipt of [
      vi.fn().mockResolvedValue({ ok: false, reasonCode: "SERVICE_UNAVAILABLE" }),
      vi.fn().mockRejectedValue(new Error("network")),
    ]) {
      const guardian = client({
        request: vi.fn().mockResolvedValue({ ok: true, decision: "ALLOW", requestId: "req_r", capabilityToken: "cap" }),
        portableReceipt,
      });
      expect(await createGuardianSteelDispatcher({ guardian, connectionId }).submitOrder(order)).toMatchObject({
        status: "outcome-unknown",
        reasonCode: "RECEIPT_UNVERIFIED",
      });
    }
  });

  it("rejects malformed orders before any proposal", () => {
    expect(SteelCheckoutArgumentsSchema.safeParse({ ...order, quantity: 99 }).success).toBe(false);
  });
});
