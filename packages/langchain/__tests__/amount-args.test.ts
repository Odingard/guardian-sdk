import { describe, expect, it, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { GuardianClient } from "@odingard/guardian-sdk";

import { GuardianDenied, guardianTool, guardianTools } from "../src/index.js";

const cents = {
  argument: "amount",
  unit: "minor" as const,
  currency: "usd" as const,
};

function client(
  answer: unknown = {
    ok: true as const,
    decision: "ALLOW" as const,
    requestId: "req_1",
    capabilityToken: "cap_1",
  },
) {
  const request = vi.fn(async () => answer);
  const execute = vi.fn(async () => ({
    ok: true,
    receipt: { id: "r", status: "sent-verified" },
  }));
  return {
    request,
    execute,
    client: {
      request,
      claim: vi.fn(),
      execute,
      receipts: vi.fn(),
    } as unknown as GuardianClient,
  };
}

function lcTool(name: string, run: (input: unknown) => unknown) {
  return tool(async (input: { amount: unknown }) => run(input), {
    name,
    description: name,
    schema: z.object({ amount: z.union([z.number(), z.string()]) }),
  });
}

describe("LangChain amountArgs (passed to the SDK unchanged)", () => {
  it("remote mode (default): each call of a declared tool carries the declaration and the amount", async () => {
    const run = vi.fn();
    const c = client();
    const wrapped = guardianTool(lcTool("purchase", run), {
      client: c.client,
      connectionId: "con_1",
      amountArgs: { purchase: cents },
    });
    await wrapped.invoke({ amount: 2000 });
    expect(c.request).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tool.invoke",
        toolName: "purchase",
        arguments: { amount: 2000 },
        amountArgument: cents,
        valueCents: 2000,
      }),
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("inProcess: the declaration and amount are sent, then the tool runs once", async () => {
    const run = vi.fn(() => "bought");
    const c = client();
    const [purchase, browse] = guardianTools(
      [lcTool("purchase", run), lcTool("browse", run)],
      {
        client: c.client,
        connectionId: "con_1",
        mode: "inProcess",
        amountArgs: { purchase: cents },
      },
    );
    await expect(purchase!.invoke({ amount: "2000" })).resolves.toBe("bought");
    expect(c.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ amountArgument: cents, valueCents: 2000 }),
    );
    await browse!.invoke({ amount: 2000 });
    const second = (c.request.mock.calls[1] as unknown[])[0];
    expect(second).not.toHaveProperty("amountArgument");
    expect(second).not.toHaveProperty("valueCents");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("an unreadable amount sends no valueCents and the tool does not run", async () => {
    const run = vi.fn();
    const c = client({ ok: false, reasonCode: "ACTION_PARAMETERS_INVALID" });
    const wrapped = guardianTool(lcTool("purchase", run), {
      client: c.client,
      connectionId: "con_1",
      mode: "inProcess",
      amountArgs: { purchase: cents },
    });
    const err = await wrapped.invoke({ amount: 20.5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianDenied);
    expect((err as GuardianDenied).hint).toContain("could not be read");
    const sent = (c.request.mock.calls[0] as unknown[])[0];
    expect(sent).toMatchObject({ amountArgument: cents });
    expect(sent).not.toHaveProperty("valueCents");
    expect(run).not.toHaveBeenCalled();
  });

  it("an invalid declaration throws when the tool is wrapped", () => {
    expect(() =>
      guardianTool(lcTool("purchase", vi.fn()), {
        client: client().client,
        connectionId: "con_1",
        amountArgs: {
          purchase: { ...cents, argument: "order.amount" } as never,
        },
      }),
    ).toThrow(TypeError);
  });
});
