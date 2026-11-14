import { describe, expect, it, vi } from "vitest";
import type {
  GuardianClient,
  GuardianRequestResult,
} from "@odingard/guardian-sdk";

import { parseCli } from "../src/config.js";
import { createGovernedProxy, type Upstream } from "../src/proxy.js";

const CONNECTION = "pcn_0123456789abcdef0123456789abcdef";
const ENV = {
  GUARDIAN_BASE_URL: "https://guardian.example.test",
  GUARDIAN_AGENT_CREDENTIAL: ["gac1", "fake"].join("."),
  GUARDIAN_CONNECTION_ID: CONNECTION,
};

const cents = {
  argument: "amount",
  unit: "minor" as const,
  currency: "usd" as const,
};

function upstream() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const up: Upstream = {
    async listTools() {
      return [
        { name: "purchase", inputSchema: { type: "object" } },
        { name: "browse", inputSchema: { type: "object" } },
      ];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: `${name} ran` }] };
    },
  };
  return { up, calls };
}

function guardian(
  invoke: () => GuardianRequestResult,
  claim?: () => GuardianRequestResult,
) {
  const execute = vi
    .fn()
    .mockResolvedValue({ ok: true, receipt: { id: "rcpt" } });
  const request = vi.fn(async (inv: { action: string }) =>
    inv.action === "tool.invoke"
      ? invoke()
      : { ok: false, reasonCode: "TOOL_ALREADY_ENABLED" },
  );
  const client = {
    request,
    claim: vi.fn(
      async () => claim?.() ?? { ok: false, reasonCode: "APPROVAL_PENDING" },
    ),
    execute,
    receipts: vi.fn(),
    portableReceipt: vi.fn(),
  } as unknown as GuardianClient;
  return { client, execute, request };
}

const text = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

const allow: GuardianRequestResult = {
  ok: true,
  requestId: "req_a",
  decision: "ALLOW",
  capabilityToken: "cap",
};

const invocation = (request: ReturnType<typeof vi.fn>, n = 0) =>
  request.mock.calls.filter(
    (c) => (c[0] as { action: string }).action === "tool.invoke",
  )[n]![0] as Record<string, unknown>;

describe("governed MCP proxy: amountArgs", () => {
  it("sends the declaration and the amount with each call of a declared tool", async () => {
    const { up, calls } = upstream();
    const { client, request, execute } = guardian(() => allow);
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
      amountArgs: { purchase: cents },
    });
    const result = await proxy.callTool("purchase", { amount: 2000, sku: "a" });
    expect(result).toMatchObject({ content: [{ text: "purchase ran" }] });
    expect(invocation(request)).toMatchObject({
      action: "tool.invoke",
      toolName: "purchase",
      arguments: { amount: 2000, sku: "a" },
      amountArgument: cents,
      valueCents: 2000,
    });
    // The upstream gets the arguments Guardian decided on.
    expect(calls).toEqual([
      { name: "purchase", args: { amount: 2000, sku: "a" } },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("a tool without a declaration sends no amount", async () => {
    const { up } = upstream();
    const { client, request } = guardian(() => allow);
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
      amountArgs: { purchase: cents },
    });
    await proxy.callTool("browse", { amount: 2000 });
    expect(invocation(request)).not.toHaveProperty("amountArgument");
    expect(invocation(request)).not.toHaveProperty("valueCents");
  });

  it("an unreadable amount: no valueCents is sent, nothing is forwarded, the refusal says why", async () => {
    const { up, calls } = upstream();
    const { client, request, execute } = guardian(() => ({
      ok: false,
      reasonCode: "ACTION_PARAMETERS_INVALID",
    }));
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
      amountArgs: { purchase: cents },
    });
    const result = await proxy.callTool("purchase", { amount: "20.00" });
    expect(invocation(request)).toMatchObject({ amountArgument: cents });
    expect(invocation(request)).not.toHaveProperty("valueCents");
    expect((result as { isError?: boolean }).isError).toBe(true);
    const body = text(result);
    expect(body).toMatchObject({
      decision: "DENY",
      reasonCode: "ACTION_PARAMETERS_INVALID",
    });
    expect(body.message).toContain(
      'the amount in its "amount" argument could not be read (AMOUNT_INVALID)',
    );
    expect(calls).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("a declaration that is not the owner's is refused with a plain message, nothing is forwarded", async () => {
    const { up, calls } = upstream();
    const { client } = guardian(() => ({
      ok: false,
      reasonCode: "INVALID_REQUEST",
    }));
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
      amountArgs: { purchase: cents },
    });
    const body = text(await proxy.callTool("purchase", { amount: 2000 }));
    expect(body.decision).toBe("DENY");
    expect(body.message).toContain(
      '{"argument":"amount","currency":"usd","unit":"minor"}',
    );
    expect(calls).toEqual([]);
  });

  it("an ASK is held, and once approved guardian_claim forwards the approved call once", async () => {
    const { up, calls } = upstream();
    const { client, request, execute } = guardian(
      () => ({ ok: true, requestId: "req_h", decision: "ASK" }),
      () => ({
        ok: true,
        requestId: "req_h",
        decision: "ALLOW",
        capabilityToken: "cap",
      }),
    );
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
      amountArgs: { purchase: cents },
    });
    const held = text(await proxy.callTool("purchase", { amount: 40_000 }));
    expect(held).toMatchObject({ decision: "ASK", requestId: "req_h" });
    expect(invocation(request)).toMatchObject({
      amountArgument: cents,
      valueCents: 40_000,
    });
    expect(calls).toEqual([]);
    const claimed = await proxy.callTool("guardian_claim", {
      requestId: "req_h",
    });
    expect(claimed).toMatchObject({ content: [{ text: "purchase ran" }] });
    expect(calls).toEqual([{ name: "purchase", args: { amount: 40_000 } }]);
    const again = await proxy.callTool("guardian_claim", {
      requestId: "req_h",
    });
    expect((again as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("an invalid declaration is a configuration error at start", () => {
    const { up } = upstream();
    const { client } = guardian(() => allow);
    for (const declaration of [
      { ...cents, currency: "eur" },
      { ...cents, argument: "order.amount" },
      { ...cents, extra: true },
    ]) {
      expect(() =>
        createGovernedProxy({
          client,
          connectionId: CONNECTION,
          upstream: up,
          amountArgs: { purchase: declaration as never },
        }),
      ).toThrow(TypeError);
    }
  });
});

describe("guardian-mcp proxy --amount-arg", () => {
  it("parses the short form and the JSON form before the stdio command", () => {
    const parsed = parseCli(
      [
        "proxy",
        "--amount-arg",
        "purchase=amount:minor",
        "--amount-arg=tip=value:major",
        "--amount-arg",
        'refund={"argument":"total","unit":"major","currency":"usd","currencyArgument":"currency","allowedArguments":["total","currency","order"]}',
        "--",
        "node",
        "server.js",
        "--amount-arg",
        "not=ours:minor",
      ],
      ENV,
    );
    expect(parsed).toMatchObject({
      ok: true,
      config: {
        mode: {
          kind: "proxy",
          command: "node",
          args: ["server.js", "--amount-arg", "not=ours:minor"],
          amountArgs: {
            purchase: { argument: "amount", unit: "minor", currency: "usd" },
            tip: { argument: "value", unit: "major", currency: "usd" },
            refund: {
              argument: "total",
              unit: "major",
              currency: "usd",
              currencyArgument: "currency",
              allowedArguments: ["total", "currency", "order"],
            },
          },
        },
      },
    });
  });

  it("works with --pin-file and with a remote upstream", () => {
    const stdio = parseCli(
      [
        "proxy",
        "--pin-file",
        "upload:path",
        "--amount-arg",
        "purchase=amount:minor",
        "--",
        "node",
        "s.js",
      ],
      ENV,
    );
    expect(stdio).toMatchObject({
      ok: true,
      config: {
        mode: {
          pinFiles: { upload: ["path"] },
          amountArgs: { purchase: cents },
        },
      },
    });
    const remote = parseCli(
      [
        "proxy",
        "--url",
        "https://mcp.example.test/mcp",
        "--amount-arg",
        "purchase=amount:minor",
      ],
      ENV,
    );
    expect(remote).toMatchObject({
      ok: true,
      config: { mode: { amountArgs: { purchase: cents } } },
    });
  });

  it("no --amount-arg leaves the mode without amountArgs", () => {
    const parsed = parseCli(["proxy", "--", "node", "s.js"], ENV);
    expect(parsed.ok).toBe(true);
    expect(
      (parsed as { config: { mode: object } }).config.mode,
    ).not.toHaveProperty("amountArgs");
  });

  it("refuses a malformed or invalid --amount-arg", () => {
    for (const value of [
      "nodeclaration",
      "=amount:minor",
      "purchase=",
      "purchase=amount",
      "purchase=amount:cents",
      "purchase=order.amount:minor",
      "purchase={not json",
      'purchase={"argument":"amount","unit":"minor","currency":"eur"}',
      'purchase={"argument":"amount","unit":"minor","currency":"usd","allowedArguments":["sku"]}',
    ]) {
      const parsed = parseCli(["proxy", "--amount-arg", value, "--", "x"], ENV);
      expect(parsed.ok, value).toBe(false);
      expect((parsed as { message: string }).message).toMatch(/--amount-arg/);
    }
    const missing = parseCli(["proxy", "--amount-arg"], ENV);
    expect(missing.ok).toBe(false);
  });

  it("refuses two declarations for one tool", () => {
    const parsed = parseCli(
      [
        "proxy",
        "--amount-arg",
        "purchase=amount:minor",
        "--amount-arg",
        "purchase=amount:major",
        "--",
        "x",
      ],
      ENV,
    );
    expect(parsed.ok).toBe(false);
    expect((parsed as { message: string }).message).toMatch(/twice/);
  });
});
