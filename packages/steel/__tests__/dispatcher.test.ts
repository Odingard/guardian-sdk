import { describe, expect, it, vi } from "vitest";
import type { GuardianClient } from "@odingard/guardian-sdk";

import {
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
    portableReceipt: vi.fn(),
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

  it("rejects malformed orders before any proposal", () => {
    expect(SteelCheckoutArgumentsSchema.safeParse({ ...order, quantity: 99 }).success).toBe(false);
  });
});
