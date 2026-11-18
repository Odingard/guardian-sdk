import { describe, expect, it, vi } from "vitest";
import type {
  GuardianClient,
  GuardianRequestResult,
} from "@odingard/guardian-sdk";

import { TOOLS, handleToolCall } from "../src/dispatch.js";
import {
  PROXY_GOVERNANCE_TOOLS,
  createGovernedProxy,
  type Upstream,
} from "../src/proxy.js";

const CONNECTION = "pcn_0123456789abcdef0123456789abcdef";

const HELD = {
  requestId: "req_ask",
  action: "tool.invoke",
  toolName: "send_message",
  purpose: "Tell the customer the invoice is due",
  createdAtEpochMs: 1_700_000_000_000,
  expiresAtEpochMs: 1_700_000_120_000,
};
const OTHER = { ...HELD, requestId: "req_elsewhere", toolName: null };
const WITHDRAWN = {
  ok: true as const,
  requestId: "req_ask",
  state: "withdrawn" as const,
  withdrawnAtEpochMs: 1_700_000_001_000,
};

const payload = (result: unknown) =>
  JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
const isError = (result: unknown) =>
  (result as { isError?: boolean }).isError === true;

function client(overrides: Partial<GuardianClient> = {}): GuardianClient {
  return {
    request: vi.fn(),
    claim: vi.fn(),
    execute: vi.fn(),
    receipts: vi.fn(),
    portableReceipt: vi.fn(),
    pending: vi.fn(async () => ({
      ok: true as const,
      requests: [HELD, OTHER],
      next: null,
    })),
    withdraw: vi.fn(async () => WITHDRAWN),
    ...overrides,
  } as unknown as GuardianClient;
}

const NEW_TOOLS = ["guardian_pending", "guardian_cancel"];

describe("held-request tool definitions", () => {
  it.each([
    ["guardian-mcp", TOOLS],
    ["guardian-mcp proxy", PROXY_GOVERNANCE_TOOLS],
  ] as const)(
    "%s describes both tools, every parameter, and avoids the wording it must not use",
    (_mode, tools) => {
      const listed = tools.filter((tool) => NEW_TOOLS.includes(tool.name));
      expect(listed.map((tool) => tool.name)).toEqual(NEW_TOOLS);
      for (const tool of listed) {
        expect(tool.title).toBe(
          (tool.annotations as { title?: string } | undefined)?.title,
        );
        expect(tool.description!.length).toBeGreaterThan(200);
        const properties = (
          tool.inputSchema as {
            properties: Record<string, { description?: string }>;
          }
        ).properties;
        for (const [name, schema] of Object.entries(properties)) {
          expect(schema.description, `${tool.name}.${name}`).toMatch(/\S/);
        }
        const words = `${tool.title} ${tool.description} ${JSON.stringify(tool.inputSchema)}`;
        expect(words).not.toMatch(
          /receipt|\bonly\b|\bfirst\b|nobody|tamper-proof|phone/i,
        );
      }
    },
  );
});

describe("guardian-mcp: guardian_pending and guardian_cancel", () => {
  it("guardian_pending lists the agent's held requests and passes the page", async () => {
    const pending = vi.fn(async () => ({
      ok: true as const,
      requests: [HELD],
      next: "1700000000000:req_ask",
    }));
    const result = await handleToolCall(
      { client: client({ pending }) },
      "guardian_pending",
      { limit: 1, before: "1700000005000:req_newer" },
    );
    expect(isError(result)).toBe(false);
    expect(payload(result)).toEqual({
      requests: [HELD],
      next: "1700000000000:req_ask",
    });
    expect(pending).toHaveBeenCalledWith({
      limit: 1,
      before: "1700000005000:req_newer",
    });
  });

  it("guardian_pending refuses a bad page without asking Guardian", async () => {
    for (const args of [
      { limit: 0 },
      { limit: 101 },
      { limit: 2.5 },
      { limit: "5" },
      { before: "" },
      { before: 3 },
    ]) {
      const pending = vi.fn();
      const result = await handleToolCall(
        { client: client({ pending }) },
        "guardian_pending",
        args,
      );
      expect(isError(result), JSON.stringify(args)).toBe(true);
      expect(pending).not.toHaveBeenCalled();
    }
  });

  it("guardian_pending reports an outage as an error", async () => {
    const result = await handleToolCall(
      {
        client: client({
          pending: vi.fn(async () => ({
            ok: false as const,
            reasonCode: "SERVICE_UNAVAILABLE",
          })),
        }),
      },
      "guardian_pending",
      {},
    );
    expect(isError(result)).toBe(true);
    expect(payload(result)).toMatchObject({
      ok: false,
      reasonCode: "SERVICE_UNAVAILABLE",
    });
  });

  it("guardian_cancel withdraws one request and says nothing ran", async () => {
    const withdraw = vi.fn(async () => WITHDRAWN);
    const result = await handleToolCall(
      { client: client({ withdraw }) },
      "guardian_cancel",
      { requestId: "req_ask" },
    );
    expect(withdraw).toHaveBeenCalledWith("req_ask");
    expect(isError(result)).toBe(false);
    expect(payload(result)).toEqual({
      requestId: "req_ask",
      state: "withdrawn",
      withdrawnAtEpochMs: 1_700_000_001_000,
      message:
        "Withdrawn. The person no longer sees this request and it can never be claimed. Nothing was run.",
    });
  });

  it("guardian_cancel reports each refusal as an error, with its reasonCode", async () => {
    for (const [answer, message] of [
      [
        {
          ok: false as const,
          reasonCode: "ALREADY_DECIDED",
          requestId: "req_ask",
          state: "approved",
        },
        /already approved .* guardian_claim/,
      ],
      [
        {
          ok: false as const,
          reasonCode: "ALREADY_DECIDED",
          requestId: "req_ask",
          state: "expired",
        },
        /already expired/,
      ],
      [{ ok: false as const, reasonCode: "NOT_FOUND" }, /no held request/],
      [
        { ok: false as const, reasonCode: "SERVICE_UNAVAILABLE" },
        /could not be reached, so nothing changed/,
      ],
    ] as const) {
      const result = await handleToolCall(
        { client: client({ withdraw: vi.fn(async () => answer) }) },
        "guardian_cancel",
        { requestId: "req_ask" },
      );
      expect(isError(result)).toBe(true);
      expect(payload(result)).toMatchObject({
        ok: false,
        reasonCode: answer.reasonCode,
        requestId: "req_ask",
      });
      expect(payload(result).message).toMatch(message);
    }
  });

  it("guardian_cancel needs a requestId and refuses an answer about another request", async () => {
    const withdraw = vi.fn(async () => ({ ...WITHDRAWN, requestId: "req_x" }));
    const missing = await handleToolCall(
      { client: client({ withdraw }) },
      "guardian_cancel",
      {},
    );
    expect(isError(missing)).toBe(true);
    expect(withdraw).not.toHaveBeenCalled();
    const mismatched = await handleToolCall(
      { client: client({ withdraw }) },
      "guardian_cancel",
      { requestId: "req_ask" },
    );
    expect(isError(mismatched)).toBe(true);
    expect(payload(mismatched)).toMatchObject({
      reasonCode: "MALFORMED_RESPONSE",
    });
  });

  it("an SDK without the methods answers NOT_SUPPORTED and changes nothing", async () => {
    const bare = client({ pending: undefined, withdraw: undefined });
    for (const [name, args] of [
      ["guardian_pending", {}],
      ["guardian_cancel", { requestId: "req_ask" }],
    ] as const) {
      const result = await handleToolCall({ client: bare }, name, args);
      expect(isError(result)).toBe(true);
      expect(payload(result)).toMatchObject({ reasonCode: "NOT_SUPPORTED" });
    }
  });
});

describe("guardian-mcp proxy: guardian_pending and guardian_cancel", () => {
  function setup(overrides: Partial<GuardianClient> = {}) {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const up: Upstream = {
      async listTools() {
        return [{ name: "send_message", inputSchema: { type: "object" } }];
      },
      async callTool(name, args) {
        calls.push({ name, args });
        return { content: [{ type: "text", text: `sent:${String(args.to)}` }] };
      },
    };
    const guardian = client({
      request: vi.fn(
        async (): Promise<GuardianRequestResult> => ({
          ok: false,
          reasonCode: "APPROVAL_REQUIRED",
          requestId: "req_ask",
        }),
      ),
      claim: vi.fn(
        async (): Promise<GuardianRequestResult> => ({
          ok: true,
          requestId: "req_ask",
          decision: "ALLOW",
          capabilityToken: "cap",
        }),
      ),
      execute: vi.fn(async () => ({
        ok: true,
        receipt: { id: "r" },
      })) as unknown as GuardianClient["execute"],
      ...overrides,
    });
    const proxy = createGovernedProxy({
      client: guardian,
      connectionId: CONNECTION,
      upstream: up,
      log: () => {},
    });
    const hold = async () => {
      const held = await proxy.callTool("send_message", {
        to: "+15550100",
        body: "invoice due",
      });
      expect(payload(held)).toMatchObject({
        decision: "ASK",
        requestId: "req_ask",
      });
    };
    return { proxy, guardian, calls, hold };
  }

  it("guardian_pending marks the requests this proxy holds the call for", async () => {
    const { proxy, hold, calls } = setup();
    await hold();
    const listed = await proxy.callTool("guardian_pending", {});
    expect(payload(listed)).toEqual({
      requests: [
        { ...HELD, heldByThisProxy: true },
        { ...OTHER, heldByThisProxy: false },
      ],
      next: null,
    });
    expect(calls).toEqual([]);
  });

  it("guardian_cancel withdraws and drops the held call: a later claim forwards nothing", async () => {
    const { proxy, guardian, hold, calls } = setup();
    await hold();
    const cancelled = await proxy.callTool("guardian_cancel", {
      requestId: "req_ask",
    });
    expect(isError(cancelled)).toBe(false);
    expect(payload(cancelled)).toMatchObject({ state: "withdrawn" });
    expect(guardian.withdraw).toHaveBeenCalledWith("req_ask");
    const claimed = await proxy.callTool("guardian_claim", {
      requestId: "req_ask",
    });
    expect(isError(claimed)).toBe(true);
    expect(payload(claimed).error).toMatch(/holds no call/);
    expect(guardian.claim).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    // Cancelling again gives the same answer.
    const again = await proxy.callTool("guardian_cancel", {
      requestId: "req_ask",
    });
    expect(payload(again)).toEqual(payload(cancelled));
  });

  it("a refused withdrawal keeps the call held, so an approved call still forwards", async () => {
    for (const answer of [
      {
        ok: false as const,
        reasonCode: "ALREADY_DECIDED",
        requestId: "req_ask",
        state: "approved",
      },
      { ok: false as const, reasonCode: "SERVICE_UNAVAILABLE" },
    ]) {
      const { proxy, hold, calls } = setup({
        withdraw: vi.fn(async () => answer),
      });
      await hold();
      const refused = await proxy.callTool("guardian_cancel", {
        requestId: "req_ask",
      });
      expect(isError(refused)).toBe(true);
      expect(calls).toEqual([]);
      const listed = await proxy.callTool("guardian_pending", {});
      expect(payload(listed).requests[0]).toMatchObject({
        heldByThisProxy: true,
      });
      const claimed = await proxy.callTool("guardian_claim", {
        requestId: "req_ask",
      });
      expect(claimed).toMatchObject({
        content: [{ type: "text", text: "sent:+15550100" }],
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("a withdrawal during a claim that is still waiting keeps the call dropped", async () => {
    let answerClaim!: (value: GuardianRequestResult) => void;
    const { proxy, hold, calls, guardian } = setup({
      claim: vi.fn(
        () =>
          new Promise<GuardianRequestResult>((resolve) => {
            answerClaim = resolve;
          }),
      ),
    });
    await hold();
    const waiting = proxy.callTool("guardian_claim", { requestId: "req_ask" });
    await vi.waitFor(() => expect(guardian.claim).toHaveBeenCalled());
    expect(
      payload(
        await proxy.callTool("guardian_cancel", { requestId: "req_ask" }),
      ),
    ).toMatchObject({ state: "withdrawn" });
    answerClaim({ ok: false, reasonCode: "APPROVAL_PENDING" });
    expect(payload(await waiting)).toMatchObject({ decision: "ASK" });
    const listed = await proxy.callTool("guardian_pending", {});
    expect(payload(listed).requests[0]).toMatchObject({
      heldByThisProxy: false,
    });
    const later = await proxy.callTool("guardian_claim", {
      requestId: "req_ask",
    });
    expect(payload(later).error).toMatch(/holds no call/);
    expect(calls).toEqual([]);
  });
});
