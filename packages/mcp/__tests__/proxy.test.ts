import { describe, expect, it, vi } from "vitest";
import type {
  GuardianClient,
  GuardianRequestResult,
} from "@odingard/guardian-sdk";

import { parseCli, upstreamEnv } from "../src/config.js";
import { createGovernedProxy, type Upstream } from "../src/proxy.js";

const CONNECTION = "pcn_0123456789abcdef0123456789abcdef";

function upstream() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const up: Upstream = {
    async listTools() {
      return [
        {
          name: "send_message",
          description: "Send a WhatsApp message",
          inputSchema: { type: "object" },
        },
        { name: "guardian_claim", inputSchema: { type: "object" } },
      ];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: `sent:${String(args.to)}` }] };
    },
  };
  return { up, calls };
}

function guardian(
  invoke: GuardianRequestResult,
  claim?: GuardianRequestResult,
  install: GuardianRequestResult = {
    ok: false,
    reasonCode: "TOOL_ALREADY_INSTALLED",
  },
) {
  const execute = vi
    .fn()
    .mockResolvedValue({ ok: true, receipt: { id: "rcpt" } });
  const client = {
    request: vi.fn(async (inv: { action: string }) =>
      inv.action === "mcp.install"
        ? install
        : inv.action === "mcp.enable"
          ? { ok: false, reasonCode: "TOOL_ALREADY_ENABLED" }
          : invoke,
    ),
    claim: vi.fn(
      async () => claim ?? { ok: false, reasonCode: "APPROVAL_PENDING" },
    ),
    execute,
    receipts: vi.fn(async () => ({ ok: true, requestId: "r", receipts: [] })),
    portableReceipt: vi.fn(),
  } as unknown as GuardianClient;
  return { client, execute };
}

const text = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

describe("governed MCP proxy", () => {
  it("lists upstream tools as governed, hides name collisions, adds guardian_claim/receipt", async () => {
    const { up } = upstream();
    const { client } = guardian({ ok: true, requestId: "r", decision: "DENY" });
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
      log: () => {},
    });
    const tools = await proxy.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "send_message",
      "guardian_claim",
      "guardian_receipt",
    ]);
    expect(tools[0]!.description).toMatch(/Guardian-governed/);
  });

  it("ALLOW forwards the call, then redeems the capability", async () => {
    const { up, calls } = upstream();
    const { client, execute } = guardian({
      ok: true,
      requestId: "req_a",
      decision: "ALLOW",
      capabilityToken: "cap",
    });
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
    });
    const result = await proxy.callTool("send_message", { to: "+15550100" });
    expect(result).toEqual({
      content: [{ type: "text", text: "sent:+15550100" }],
      _meta: { "com.odingard/guardian": { requestId: "req_a" } },
    });
    expect(calls).toHaveLength(1);
    expect(execute).toHaveBeenCalledWith({
      requestId: "req_a",
      capabilityToken: "cap",
    });
  });

  it("DENY never forwards", async () => {
    const { up, calls } = upstream();
    const { client } = guardian({
      ok: true,
      requestId: "req_d",
      decision: "DENY",
      reasonCode: "POLICY_DENY",
    });
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
    });
    const result = await proxy.callTool("send_message", { to: "x" });
    expect(text(result)).toMatchObject({
      decision: "DENY",
      reasonCode: "POLICY_DENY",
    });
    expect(calls).toHaveLength(0);
  });

  it("a refusal keeps Guardian's requestId so the denial can be traced", async () => {
    const { up, calls } = upstream();
    const { client } = guardian({
      ok: false,
      reasonCode: "NOT_AUTHORIZED",
      requestId: "req_denied",
    } as GuardianRequestResult);
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
    });
    const result = await proxy.callTool("send_message", { to: "x" });
    expect(text(result)).toMatchObject({
      decision: "DENY",
      reasonCode: "NOT_AUTHORIZED",
      requestId: "req_denied",
    });
    expect(calls).toHaveLength(0);
  });

  it("Guardian unreachable never forwards", async () => {
    const { up, calls } = upstream();
    const { client } = guardian({
      ok: false,
      reasonCode: "SERVICE_UNAVAILABLE",
    });
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
    });
    const result = await proxy.callTool("send_message", { to: "x" });
    expect(text(result)).toMatchObject({
      decision: "DENY",
      reasonCode: "SERVICE_UNAVAILABLE",
    });
    expect(calls).toHaveLength(0);
  });

  it("an outage is reported as Guardian not reached, never as a denial, and flagged isError", async () => {
    const { up, calls } = upstream();
    const { client } = guardian({
      ok: false,
      reasonCode: "SERVICE_UNAVAILABLE",
    });
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
    });
    const result = await proxy.callTool("send_message", { to: "x" });
    expect((result as { isError?: boolean }).isError).toBe(true);
    const body = text(result);
    expect(body.message).toMatch(/Guardian could not be reached/);
    expect(body.message).toMatch(/Try again later/);
    expect(body.message).not.toMatch(/denied|Do not retry/i);
    expect(calls).toHaveLength(0);
  });

  it("a policy refusal is flagged isError for the MCP client", async () => {
    const { up } = upstream();
    const { client } = guardian({
      ok: true,
      requestId: "req_d",
      decision: "DENY",
      reasonCode: "POLICY_DENY",
    });
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
    });
    const result = await proxy.callTool("send_message", { to: "x" });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toMatchObject({
      decision: "DENY",
      requestId: "req_d",
      message: expect.stringMatching(/Guardian denied send_message/),
    });
  });

  it("an outage while claiming keeps the call held, so the claim can be retried", async () => {
    const { up, calls } = upstream();
    const { client } = guardian({
      ok: false,
      reasonCode: "APPROVAL_REQUIRED",
      requestId: "req_ask",
    });
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
    });
    await proxy.callTool("send_message", { to: "+15550199" });
    const claim = client.claim as ReturnType<typeof vi.fn>;
    claim.mockResolvedValueOnce({
      ok: false,
      reasonCode: "SERVICE_UNAVAILABLE",
    });
    const down = await proxy.callTool("guardian_claim", {
      requestId: "req_ask",
    });
    expect((down as { isError?: boolean }).isError).toBe(true);
    expect(text(down).message).toMatch(/Guardian could not be reached/);
    expect(calls).toHaveLength(0);
    claim.mockResolvedValueOnce({
      ok: true,
      requestId: "req_ask",
      decision: "ALLOW",
      capabilityToken: "cap2",
    });
    const done = await proxy.callTool("guardian_claim", {
      requestId: "req_ask",
    });
    expect(done).toMatchObject({
      content: [{ type: "text", text: "sent:+15550199" }],
    });
    expect(calls).toHaveLength(1);
  });

  it("an upstream _meta is kept and cannot forge Guardian's requestId", async () => {
    const calls: unknown[] = [];
    const up: Upstream = {
      async listTools() {
        return [{ name: "send_message", inputSchema: { type: "object" } }];
      },
      async callTool(name, args) {
        calls.push({ name, args });
        return {
          content: [{ type: "text", text: "ok" }],
          _meta: {
            "example.com/trace": "t1",
            "com.odingard/guardian": { requestId: "req_forged" },
          },
        };
      },
    };
    const { client } = guardian({
      ok: true,
      requestId: "req_real",
      decision: "ALLOW",
      capabilityToken: "cap",
    });
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
    });
    const result = await proxy.callTool("send_message", {});
    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }],
      _meta: {
        "example.com/trace": "t1",
        "com.odingard/guardian": { requestId: "req_real" },
      },
    });
  });

  it("ASK holds the call; claim before approval forwards nothing; claim after approval forwards exactly the held call", async () => {
    const { up, calls } = upstream();
    const { client } = guardian({
      ok: false,
      reasonCode: "APPROVAL_REQUIRED",
      requestId: "req_ask",
    });
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
    });
    const held = await proxy.callTool("send_message", {
      to: "+15550199",
      body: "invoice due",
    });
    expect(text(held)).toMatchObject({ decision: "ASK", requestId: "req_ask" });
    expect(calls).toHaveLength(0);

    // Human has not approved yet.
    const early = await proxy.callTool("guardian_claim", {
      requestId: "req_ask",
    });
    expect(text(early)).toMatchObject({ decision: "ASK" });
    expect(calls).toHaveLength(0);

    // Human approved.
    (client.claim as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      requestId: "req_ask",
      decision: "ALLOW",
      capabilityToken: "cap2",
    });
    const done = await proxy.callTool("guardian_claim", {
      requestId: "req_ask",
    });
    expect(done).toEqual({
      content: [{ type: "text", text: "sent:+15550199" }],
      _meta: { "com.odingard/guardian": { requestId: "req_ask" } },
    });
    expect(calls).toEqual([
      { name: "send_message", args: { to: "+15550199", body: "invoice due" } },
    ]);

    // Single use: the same requestId cannot replay the call.
    const replay = await proxy.callTool("guardian_claim", {
      requestId: "req_ask",
    });
    expect((replay as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("a denied claim never forwards", async () => {
    const { up, calls } = upstream();
    const { client } = guardian(
      { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId: "req_ask" },
      { ok: false, reasonCode: "NOT_AUTHORIZED" },
    );
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
    });
    await proxy.callTool("send_message", { to: "x" });
    const result = await proxy.callTool("guardian_claim", {
      requestId: "req_ask",
    });
    expect(text(result)).toMatchObject({ decision: "DENY" });
    expect(calls).toHaveLength(0);
  });

  it("autoRegister=false never proposes mcp.install", async () => {
    const { up } = upstream();
    const { client } = guardian({
      ok: true,
      requestId: "req_a",
      decision: "ALLOW",
      capabilityToken: "cap",
    });
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
      autoRegister: false,
    });
    await proxy.callTool("send_message", { to: "x" });
    const actions = (client.request as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(actions).toEqual(["tool.invoke"]);
  });

  it("an unknown requestId forwards nothing", async () => {
    const { up, calls } = upstream();
    const { client } = guardian({ ok: true, requestId: "r", decision: "DENY" });
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
    });
    const result = await proxy.callTool("guardian_claim", {
      requestId: "req_forged",
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("a held first-use registration is claimed separately and never runs the tool", async () => {
    const { up, calls } = upstream();
    const { client, execute } = guardian(
      { ok: true, requestId: "req_unused", decision: "DENY" },
      {
        ok: true,
        requestId: "req_install",
        decision: "ALLOW",
        capabilityToken: "capi",
      },
      { ok: true, requestId: "req_install", decision: "ASK" },
    );
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
      autoRegister: true,
    });
    const held = await proxy.callTool("send_message", { to: "x" });
    expect(text(held)).toMatchObject({
      decision: "ASK",
      requestId: "req_install",
    });
    const registered = await proxy.callTool("guardian_claim", {
      requestId: "req_install",
    });
    expect(text(registered)).toMatchObject({ decision: "ALLOW" });
    expect(execute).toHaveBeenCalledWith({
      requestId: "req_install",
      capabilityToken: "capi",
    });
    expect(calls).toHaveLength(0);
  });

  it("after a claimed first-use registration, the retry still switches the tool on before calling it", async () => {
    const { up, calls } = upstream();
    const actions: string[] = [];
    let claimAnswer: GuardianRequestResult = {
      ok: true,
      requestId: "req_install",
      decision: "ALLOW",
      capabilityToken: "capi",
    };
    const execute = vi.fn(async ({ requestId }: { requestId: string }) => {
      actions.push(`execute:${requestId}`);
      return { ok: true, receipt: { id: `rcpt_${requestId}` } };
    });
    let installs = 0;
    const client = {
      request: vi.fn(async (inv: { action: string }) => {
        actions.push(`request:${inv.action}`);
        if (inv.action === "mcp.install") {
          installs += 1;
          return installs === 1
            ? { ok: true, requestId: "req_install", decision: "ASK" }
            : { ok: false, reasonCode: "INVALID_REQUEST" };
        }
        if (inv.action === "mcp.enable") {
          return {
            ok: false,
            reasonCode: "APPROVAL_REQUIRED",
            requestId: "req_enable",
          };
        }
        return {
          ok: true,
          requestId: "req_call",
          decision: "ALLOW",
          capabilityToken: "capc",
        };
      }),
      claim: vi.fn(async (id: string) => {
        actions.push(`claim:${id}`);
        return claimAnswer;
      }),
      execute,
      receipts: vi.fn(),
      portableReceipt: vi.fn(),
    } as unknown as GuardianClient;
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
      autoRegister: true,
    });
    expect(
      text(await proxy.callTool("send_message", { to: "x" })),
    ).toMatchObject({ decision: "ASK", requestId: "req_install" });
    const registered = await proxy.callTool("guardian_claim", {
      requestId: "req_install",
    });
    expect(text(registered)).toMatchObject({ decision: "ALLOW" });
    // The retry proposes mcp.enable; it is held for approval.
    const enable = await proxy.callTool("send_message", { to: "x" });
    expect(text(enable)).toMatchObject({
      decision: "ASK",
      requestId: "req_enable",
    });
    expect(text(enable).message).toContain("Switching on send_message");
    expect(calls).toHaveLength(0);
    claimAnswer = {
      ok: true,
      requestId: "req_enable",
      decision: "ALLOW",
      capabilityToken: "cape",
    };
    const enabled = await proxy.callTool("guardian_claim", {
      requestId: "req_enable",
    });
    expect(text(enabled)).toMatchObject({ decision: "ALLOW" });
    const done = await proxy.callTool("send_message", { to: "x" });
    expect(calls).toHaveLength(1);
    expect((done as { isError?: boolean }).isError).not.toBe(true);
    expect(actions).toEqual([
      "request:mcp.install",
      "claim:req_install",
      "execute:req_install",
      // The entry the proxy just installed is record-only: straight to
      // mcp.enable, no second mcp.install.
      "request:mcp.enable",
      "claim:req_enable",
      "execute:req_enable",
      "request:tool.invoke",
      "execute:req_call",
    ]);
  });
});

describe("guardian-mcp CLI config", () => {
  const env = {
    GUARDIAN_BASE_URL: "https://guardian-api.odingard.com",
    GUARDIAN_AGENT_CREDENTIAL: "gac1.x",
    GUARDIAN_CONNECTION_ID: CONNECTION,
  };

  it("names every missing setting instead of throwing", () => {
    const r = parseCli([], {});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(
      /GUARDIAN_BASE_URL, GUARDIAN_AGENT_CREDENTIAL/,
    );
  });

  it("parses proxy mode", () => {
    const r = parseCli(["proxy", "--", "npx", "-y", "server"], env);
    expect(r.ok && r.config.mode).toEqual({
      kind: "proxy",
      command: "npx",
      args: ["-y", "server"],
    });
  });

  it("proxy mode requires a connection id", () => {
    const r = parseCli(["proxy", "--", "x"], {
      ...env,
      GUARDIAN_CONNECTION_ID: undefined,
    });
    expect(!r.ok && r.message).toMatch(/GUARDIAN_CONNECTION_ID/);
  });

  it("first-use registration is off unless GUARDIAN_AUTO_REGISTER=true", () => {
    const off = parseCli(["proxy", "--", "x"], env);
    expect(off.ok && off.config.autoRegister).toBe(false);
    const on = parseCli(["proxy", "--", "x"], {
      ...env,
      GUARDIAN_AUTO_REGISTER: "true",
    });
    expect(on.ok && on.config.autoRegister).toBe(true);
  });

  it("never passes Guardian settings (the agent credential) to the upstream server", () => {
    const out = upstreamEnv({ ...env, PATH: "/bin", WHATSAPP_TOKEN: "t" });
    expect(out).toEqual({ PATH: "/bin", WHATSAPP_TOKEN: "t" });
  });
});
