import { describe, expect, it, vi } from "vitest";
import { jsonSchema, tool } from "ai";
import type { GuardianClient } from "@odingard/guardian-sdk";

import { GuardianDenied, withGuardian } from "../src/index.js";

const cents = {
  argument: "amount",
  unit: "minor" as const,
  currency: "usd" as const,
};

const callOptions = { toolCallId: "tc_1", messages: [], context: {} };

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

function tools(run: (input: unknown) => unknown) {
  const schema = jsonSchema<{ amount: unknown }>({
    type: "object",
    properties: { amount: {} },
  });
  return {
    purchase: tool({
      description: "Buy",
      inputSchema: schema,
      execute: async (input) => run(input),
    }),
    browse: tool({
      description: "Browse",
      inputSchema: schema,
      execute: async (input) => run(input),
    }),
  };
}

const call = (
  wrapped: unknown,
  name: string,
  input: unknown,
): Promise<unknown> =>
  (
    wrapped as Record<
      string,
      { execute: (i: unknown, o: unknown) => Promise<unknown> }
    >
  )[name]!.execute(input, callOptions);

describe("Vercel AI amountArgs (passed to the SDK unchanged)", () => {
  it("remote mode (default): each call of a declared tool carries the declaration and the amount", async () => {
    const run = vi.fn();
    const c = client();
    const wrapped = withGuardian(tools(run), {
      client: c.client,
      connectionId: "con_1",
      amountArgs: { purchase: cents },
    });
    await call(wrapped, "purchase", { amount: 2000 });
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
    const wrapped = withGuardian(tools(run), {
      client: c.client,
      connectionId: "con_1",
      mode: "inProcess",
      amountArgs: { purchase: cents },
    });
    await expect(call(wrapped, "purchase", { amount: "2000" })).resolves.toBe(
      "bought",
    );
    expect(c.request).toHaveBeenCalledWith(
      expect.objectContaining({ amountArgument: cents, valueCents: 2000 }),
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("an unreadable amount sends no valueCents and the tool does not run", async () => {
    const run = vi.fn();
    const c = client({ ok: false, reasonCode: "ACTION_PARAMETERS_INVALID" });
    const wrapped = withGuardian(tools(run), {
      client: c.client,
      connectionId: "con_1",
      mode: "inProcess",
      amountArgs: { purchase: cents },
    });
    const err = await call(wrapped, "purchase", { amount: 20.5 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GuardianDenied);
    expect((err as GuardianDenied).hint).toContain("could not be read");
    const sent = (c.request.mock.calls[0] as unknown[])[0];
    expect(sent).toMatchObject({ amountArgument: cents });
    expect(sent).not.toHaveProperty("valueCents");
    expect(run).not.toHaveBeenCalled();
  });

  it("a tool without a declaration sends no amount", async () => {
    const c = client();
    const wrapped = withGuardian(tools(vi.fn()), {
      client: c.client,
      connectionId: "con_1",
      amountArgs: { purchase: cents },
    });
    await call(wrapped, "browse", { amount: 2000 });
    const sent = (c.request.mock.calls[0] as unknown[])[0];
    expect(sent).not.toHaveProperty("amountArgument");
    expect(sent).not.toHaveProperty("valueCents");
  });

  it("an invalid declaration throws when the tools are wrapped", () => {
    expect(() =>
      withGuardian(tools(vi.fn()), {
        client: client().client,
        connectionId: "con_1",
        amountArgs: { purchase: { ...cents, currency: "eur" } as never },
      }),
    ).toThrow(TypeError);
  });
});
