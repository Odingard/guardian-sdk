/**
 * What the agent is told about a call's outcome: dispatch statuses,
 * cancelled requests, claims whose result was lost, and secrets in
 * diagnostics.
 */
import { describe, expect, it, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createGuardianClient,
  type GuardianClient,
} from "@odingard/guardian-sdk";

import { parseCli, redact, secretsOf } from "../src/config.js";
import { handleToolCall } from "../src/dispatch.js";
import {
  CLAIMED_REQUESTS_LIMIT,
  createGovernedProxy,
  type Upstream,
} from "../src/proxy.js";
import { clientUpstream, toolListFailure } from "../src/upstream.js";

const CONN = "pcn_0123456789abcdef0123456789abcdef";

type Body = Record<string, unknown>;
type Route = (body: Body) => unknown | Promise<unknown>;

/** A fetch-backed Guardian: real SDK client, scripted HTTP answers. */
function fakeGuardian(routes: Record<string, Route>) {
  const seen: string[] = [];
  const fetch = async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    seen.push(path);
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : {};
    const route = routes[path];
    const answer = route
      ? await route(body)
      : { status: 404, body: { ok: false, code: "NOT_FOUND" } };
    const { status = 200, body: payload } = answer as {
      status?: number;
      body: unknown;
    };
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    client: createGuardianClient({
      baseUrl: "https://g.test",
      credential: "gac1.test",
      fetch: fetch as never,
    }),
    seen,
  };
}

const allowBody = (body: Body) => ({
  body: {
    ok: true,
    requestId: body.requestId,
    decision: "ALLOW",
    capabilityToken: "gcap.k.r.d.mac",
  },
});
const receiptBody = (status: string) => (body: Body) => ({
  body: {
    ok: true,
    receipt: {
      schemaVersion: 1,
      requestId: body.requestId,
      receiptReference: "att_abcdefgh1234",
      status,
    },
  },
});

const text = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

describe("dispatch: only a sent-verified receipt is a success", () => {
  const call = (client: GuardianClient) =>
    handleToolCall(
      { client, defaultConnectionId: CONN },
      "guardian_invoke_tool",
      {
        toolName: "send_payment",
        arguments: { to: "acme", amountCents: 500000 },
      },
    );

  for (const status of ["outcome-unconfirmed", "outcome-pending"]) {
    it(`receipt status ${status} is an error with an unknown outcome`, async () => {
      const { client } = fakeGuardian({
        "/v1/agent/requests": allowBody,
        "/v1/agent/execute": receiptBody(status),
      });
      const r = await call(client);
      expect(r.isError).toBe(true);
      const body = text(r);
      expect(body.outcome).toBe("unknown");
      expect(body.message).toMatch(/may have been done/);
      expect(body.message).toMatch(/before retrying/);
    });
  }

  it("receipt status not-sent is an error that says it was not done", async () => {
    const { client } = fakeGuardian({
      "/v1/agent/requests": allowBody,
      "/v1/agent/execute": receiptBody("not-sent"),
    });
    const r = await call(client);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatchObject({ outcome: "not-done" });
    expect(text(r).message).toMatch(/was not done/);
  });

  it("a refused or lost execute is an error with an unknown outcome", async () => {
    const { client } = fakeGuardian({
      "/v1/agent/requests": allowBody,
      "/v1/agent/execute": () => ({
        body: { ok: false, reasonCode: "CAPABILITY_REVOKED" },
      }),
    });
    const r = await call(client);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatchObject({
      outcome: "unknown",
      executionFailed: "CAPABILITY_REVOKED",
    });
  });

  it("sent-verified is a plain success with the receipt", async () => {
    const { client } = fakeGuardian({
      "/v1/agent/requests": allowBody,
      "/v1/agent/execute": receiptBody("sent-verified"),
    });
    const r = await call(client);
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatchObject({
      decision: "ALLOW",
      receipt: { status: "sent-verified" },
    });
  });

  it("DENY and an outage are errors and say nothing was done", async () => {
    const denied = fakeGuardian({
      "/v1/agent/requests": () => ({
        status: 403,
        body: { ok: false, reasonCode: "POLICY_DENY" },
      }),
    });
    const d = await call(denied.client);
    expect(d.isError).toBe(true);
    expect(text(d)).toMatchObject({
      decision: "DENY",
      reasonCode: "POLICY_DENY",
    });
    expect(text(d).message).toMatch(/Do not retry/);
    expect(denied.seen).not.toContain("/v1/agent/execute");

    const down = fakeGuardian({
      "/v1/agent/requests": () => {
        throw new TypeError("fetch failed");
      },
    });
    const u = await call(down.client);
    expect(u.isError).toBe(true);
    expect(text(u).message).toMatch(/could not be reached/);
  });
});

/** The proxy behind a real MCP server, wired the way the CLI wires it. */
async function wired(proxy: ReturnType<typeof createGovernedProxy>) {
  const server = new Server(
    { name: "guardian-mcp", version: "t" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await proxy.listTools(),
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) =>
      (await proxy.callTool(
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
        { signal: extra.signal },
      )) as never,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const agent = new Client({ name: "agent", version: "t" });
  await agent.connect(b);
  return agent;
}

function recordingUpstream(delayMs = 0) {
  const forwarded: { name: string; args: unknown }[] = [];
  const upstream: Upstream = {
    async listTools() {
      return [{ name: "send_message", inputSchema: { type: "object" } }];
    },
    async callTool(name, args) {
      forwarded.push({ name, args });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { content: [{ type: "text", text: "sent" }] };
    },
  };
  return { upstream, forwarded };
}

describe("proxy: a cancelled request is not forwarded", () => {
  it("cancel while Guardian decides: the late ALLOW forwards nothing and redeems nothing", async () => {
    const { upstream, forwarded } = recordingUpstream();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { client, seen } = fakeGuardian({
      "/v1/agent/requests": async (body) => {
        await gate;
        return allowBody(body);
      },
      "/v1/agent/execute": receiptBody("sent-verified"),
    });
    const proxy = createGovernedProxy({ client, connectionId: CONN, upstream });
    const agent = await wired(proxy);
    const ac = new AbortController();
    const pending = agent.callTool(
      { name: "send_message", arguments: { to: "+1555", text: "hi" } },
      undefined,
      { signal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 20));
    ac.abort("user pressed Esc");
    const saw = await pending.then(
      () => "result",
      () => "rejected",
    );
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(saw).toBe("rejected");
    expect(forwarded).toHaveLength(0);
    expect(seen).not.toContain("/v1/agent/execute");
  });

  it("an already aborted signal does not even ask Guardian", async () => {
    const { upstream, forwarded } = recordingUpstream();
    const request = vi.fn();
    const client = {
      request,
      claim: vi.fn(),
      execute: vi.fn(),
      receipts: vi.fn(),
    } as unknown as GuardianClient;
    const proxy = createGovernedProxy({ client, connectionId: CONN, upstream });
    const ac = new AbortController();
    ac.abort();
    const r = await proxy.callTool(
      "send_message",
      { to: "x" },
      { signal: ac.signal },
    );
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(text(r)).toMatchObject({ cancelled: true });
    expect(request).not.toHaveBeenCalled();
    expect(forwarded).toHaveLength(0);
  });

  it("a claim cancelled before forwarding keeps the call held and reuses the approval", async () => {
    const { upstream, forwarded } = recordingUpstream();
    const claims: string[] = [];
    const { client } = fakeGuardian({
      "/v1/agent/requests": () => ({
        status: 403,
        body: { ok: false, code: "APPROVAL_REQUIRED" },
      }),
      "/v1/agent/claims": (body) => {
        claims.push(String(body.requestId));
        // A second claim of the same approval is refused.
        return claims.length > 1
          ? { status: 409, body: { ok: false, reasonCode: "ALREADY_CLAIMED" } }
          : allowBody(body);
      },
      "/v1/agent/execute": receiptBody("sent-verified"),
    });
    const ac = new AbortController();
    let fired = false;
    // The signal fires while Guardian answers the claim.
    const claimingClient = {
      ...client,
      claim: async (id: string) => {
        const result = await client.claim(id);
        if (!fired) {
          fired = true;
          ac.abort();
        }
        return result;
      },
    } as GuardianClient;
    const proxy = createGovernedProxy({
      client: claimingClient,
      connectionId: CONN,
      upstream,
    });
    const ask = await proxy.callTool("send_message", { to: "+1" });
    const requestId = text(ask).requestId as string;
    const cancelled = await proxy.callTool(
      "guardian_claim",
      { requestId },
      { signal: ac.signal },
    );
    expect((cancelled as { isError?: boolean }).isError).toBe(true);
    expect(text(cancelled)).toMatchObject({ cancelled: true, requestId });
    expect(forwarded).toHaveLength(0);

    const done = await proxy.callTool("guardian_claim", { requestId });
    expect((done as { isError?: boolean }).isError).toBeUndefined();
    expect(forwarded).toHaveLength(1);
    expect(claims).toHaveLength(1); // the approval was claimed once
  });

  it("clientUpstream refuses to send once the signal fired", async () => {
    const callTool = vi.fn();
    const up = clientUpstream({ callTool } as never);
    const ac = new AbortController();
    ac.abort();
    await expect(
      up.callTool("send_message", {}, { signal: ac.signal }),
    ).rejects.toMatchObject({ name: "UpstreamCallCancelled" });
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe("proxy: a second claim of the same requestId", () => {
  function heldProxy(delayMs: number) {
    const { upstream, forwarded } = recordingUpstream(delayMs);
    const { client } = fakeGuardian({
      "/v1/agent/requests": () => ({
        status: 403,
        body: { ok: false, code: "APPROVAL_REQUIRED" },
      }),
      "/v1/agent/claims": allowBody,
      "/v1/agent/execute": receiptBody("sent-verified"),
    });
    return {
      proxy: createGovernedProxy({ client, connectionId: CONN, upstream }),
      forwarded,
    };
  }

  it("while the first is still forwarding: told it is already forwarded, not to re-propose", async () => {
    const { proxy, forwarded } = heldProxy(30);
    const requestId = text(await proxy.callTool("send_message", { to: "acme" }))
      .requestId as string;
    const first = proxy.callTool("guardian_claim", { requestId });
    await new Promise((r) => setTimeout(r, 5));
    const retry = await proxy.callTool("guardian_claim", { requestId });
    await first;
    const retryText = (retry as { content: { text: string }[] }).content[0]!
      .text;
    expect(forwarded).toHaveLength(1);
    expect(retryText).not.toMatch(/Nothing was forwarded/);
    expect(retryText).toMatch(/already being forwarded/);
    expect(retryText).toMatch(/Do not propose send_message again/);
    expect((retry as { isError?: boolean }).isError).toBe(true);
  });

  it("after the first finished: gets the earlier result back with a notice", async () => {
    const { proxy, forwarded } = heldProxy(0);
    const requestId = text(await proxy.callTool("send_message", { to: "acme" }))
      .requestId as string;
    await proxy.callTool("guardian_claim", { requestId });
    const retry = (await proxy.callTool("guardian_claim", { requestId })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(forwarded).toHaveLength(1);
    expect(retry.isError).toBe(true);
    expect(retry.content[0]!.text).toMatch(
      /already forwarded. Do not propose it again/,
    );
    expect(retry.content[1]).toEqual({ type: "text", text: "sent" });
  });

  it("an unknown requestId does not claim that nothing was ever forwarded", async () => {
    const { proxy } = heldProxy(0);
    const r = await proxy.callTool("guardian_claim", {
      requestId: "req_unknown",
    });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(text(r).error).toMatch(/this claim forwarded nothing/);
    expect(text(r).error).toMatch(/guardian_receipt/);
  });

  it("remembers a bounded number of claims", () => {
    expect(CLAIMED_REQUESTS_LIMIT).toBeGreaterThan(0);
    expect(CLAIMED_REQUESTS_LIMIT).toBeLessThanOrEqual(10_000);
  });
});

describe("proxy: an unexpected error after forwarding", () => {
  it("does not say the call was not forwarded", async () => {
    const { upstream, forwarded } = recordingUpstream();
    const client = {
      request: vi.fn(async () => ({
        ok: true,
        decision: "ALLOW",
        requestId: "req_1",
        capabilityToken: "cap",
      })),
      claim: vi.fn(),
      execute: vi.fn(async () => {
        throw new Error("boom");
      }),
      receipts: vi.fn(),
    } as unknown as GuardianClient;
    const proxy = createGovernedProxy({ client, connectionId: CONN, upstream });
    const r = await proxy.callTool("send_message", { to: "x" });
    expect(forwarded).toHaveLength(1);
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(text(r).error).toMatch(/after the call was forwarded/);
    expect(text(r).error).not.toMatch(/not forwarded/);
  });

  it("a lost record reply after forwarding is an unknown outcome, not a retry", async () => {
    const { upstream, forwarded } = recordingUpstream();
    const { client } = fakeGuardian({
      "/v1/agent/requests": allowBody,
      "/v1/agent/execute": () => ({
        status: 502,
        body: { error: "bad gateway" },
      }),
    });
    const proxy = createGovernedProxy({ client, connectionId: CONN, upstream });
    const r = await proxy.callTool("send_message", { to: "x" });
    expect(forwarded).toHaveLength(1);
    expect((r as { isError?: boolean }).isError).toBe(true);
    const out = text(r);
    expect(out.executionFailed).toBe("EXECUTION_OUTCOME_UNKNOWN");
    expect(out.outcomeUnknown).toBe(true);
    expect(out.localEffectRan).toBe(true);
    expect(out.message).toMatch(/Do not call it again/);
    expect(out.message).not.toMatch(/try again|not completed/i);
  });
});

describe("secrets in diagnostics", () => {
  it("a query key is scrubbed as typed, percent-decoded and with + as a space", () => {
    // Built at runtime: no key-shaped literal in the source.
    const key = "AbC" + "+dEf" + "/gh12==";
    const parsed = parseCli(
      ["tools", "--url", "https://mcp.example.com/mcp?api_key=${K}&org=acme"],
      { K: key },
    );
    if (!parsed.ok) throw new Error(parsed.message);
    const target = parsed.config.mode as never;
    const msg = toolListFailure(
      target,
      new Error(
        `Error POSTing to endpoint (HTTP 401): {"error":"invalid api_key ${key}"}`,
      ),
    );
    expect(msg).not.toContain(key);
    const secrets = secretsOf(target);
    expect(redact("AbC dEf/gh12==", secrets)).toBe("[redacted]");
  });

  it("a percent-encoded query key is scrubbed in its decoded form", () => {
    const parsed = parseCli(
      ["tools", "--url", "https://mcp.example.com/mcp?token=Zx%2BYw%2F9876"],
      {},
    );
    if (!parsed.ok) throw new Error(parsed.message);
    const secrets = secretsOf(parsed.config.mode as never);
    expect(redact("bad token Zx+Yw/9876", secrets)).toBe(
      "bad token [redacted]",
    );
    expect(redact("bad token Zx%2BYw%2F9876", secrets)).toBe(
      "bad token [redacted]",
    );
  });
});
