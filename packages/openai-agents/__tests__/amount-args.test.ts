import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RunContext, type FunctionTool } from "@openai/agents";
import type { GuardianClient } from "@odingard/guardian-sdk";

import { guardianTool } from "../src/index.js";

const cents = {
  argument: "amount",
  unit: "minor" as const,
  currency: "usd" as const,
};

const allow = {
  ok: true as const,
  decision: "ALLOW" as const,
  requestId: "req_1",
  capabilityToken: "cap_1",
};

function stubClient(overrides: Partial<GuardianClient>): GuardianClient {
  return {
    request: vi.fn(),
    claim: vi.fn(),
    execute: vi.fn().mockResolvedValue({ ok: true, receipt: { id: "r" } }),
    receipts: vi.fn(),
    ...overrides,
  } as unknown as GuardianClient;
}

const invoke = (t: FunctionTool<any, any, any>, args: unknown) =>
  t.invoke(new RunContext(), JSON.stringify(args));

const sent = (request: ReturnType<typeof vi.fn>, n = 0) =>
  (request.mock.calls[n] as unknown as [Record<string, unknown>])[0];

function purchase(
  name: string,
  run: (input: { amount: number | string }) => unknown,
  options: Parameters<typeof guardianTool>[1],
) {
  return guardianTool(
    {
      name,
      description: "Buy",
      parameters: z.object({ amount: z.union([z.number(), z.string()]) }),
      execute: async (input) => run(input) as string,
    },
    options,
  );
}

describe("OpenAI Agents amountArgs (passed to the SDK)", () => {
  it("each call of a declared tool carries the declaration and the amount, then the tool runs once", async () => {
    const run = vi.fn(() => "bought");
    const request = vi.fn().mockResolvedValue(allow);
    const t = purchase("purchase", run, {
      client: stubClient({ request }),
      connectionId: "con_1",
      amountArgs: { purchase: cents },
    });
    await expect(invoke(t, { amount: 2000 })).resolves.toBe("bought");
    expect(sent(request)).toMatchObject({
      action: "tool.invoke",
      toolName: "purchase",
      arguments: { amount: 2000 },
      amountArgument: cents,
      valueCents: 2000,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a tool the Agents SDK renames still sends the declaration given under the written name", async () => {
    const request = vi.fn().mockResolvedValue(allow);
    const t = purchase("buy-item", () => "bought", {
      client: stubClient({ request }),
      connectionId: "con_1",
      amountArgs: { "buy-item": cents },
    });
    expect(t.name).toBe("buy_item");
    await invoke(t, { amount: "2000" });
    expect(sent(request)).toMatchObject({
      toolName: "buy_item",
      amountArgument: cents,
      valueCents: 2000,
    });
  });

  it("amountArgs entries that disagree for one renamed tool are refused; equal entries agree", () => {
    expect(() =>
      purchase("buy-item", () => "x", {
        client: stubClient({}),
        connectionId: "con_1",
        amountArgs: {
          "buy-item": cents,
          buy_item: { ...cents, unit: "major" },
        },
      }),
    ).toThrow(/amountArgs disagree/);
    expect(() =>
      purchase("buy-item", () => "x", {
        client: stubClient({}),
        connectionId: "con_1",
        amountArgs: {
          "buy-item": cents,
          buy_item: { currency: "usd", unit: "minor", argument: "amount" },
        },
      }),
    ).not.toThrow();
  });

  it("an unreadable amount sends no valueCents, the tool does not run, and the model is told it was denied", async () => {
    const run = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValue({
        ok: false,
        reasonCode: "ACTION_PARAMETERS_INVALID",
      });
    const t = purchase("purchase", run, {
      client: stubClient({ request }),
      connectionId: "con_1",
      amountArgs: { purchase: cents },
    });
    const out = await invoke(t, { amount: 20.5 });
    expect(sent(request)).toMatchObject({ amountArgument: cents });
    expect(sent(request)).not.toHaveProperty("valueCents");
    expect(out).toBe(
      "Guardian denied purchase (ACTION_PARAMETERS_INVALID). It did not run. Do not retry the same call.",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("an invalid declaration throws when the tool is built", () => {
    expect(() =>
      purchase("purchase", () => "x", {
        client: stubClient({}),
        connectionId: "con_1",
        amountArgs: { purchase: { ...cents, currency: "eur" } as never },
      }),
    ).toThrow(TypeError);
  });
});
