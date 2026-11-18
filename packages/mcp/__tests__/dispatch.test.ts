import { describe, expect, it, vi } from "vitest";
import type { GuardianClient } from "@odingard/guardian-sdk";
import {
  LEGACY_RECORD_TOOL,
  RECORD_TOOL,
  TOOLS,
  handleToolCall,
} from "../src/dispatch.js";

function stubClient(overrides: Partial<GuardianClient>): GuardianClient {
  return {
    request: vi.fn(),
    claim: vi.fn(),
    execute: vi.fn(),
    receipts: vi.fn(),
    ...overrides,
  } as unknown as GuardianClient;
}

function payload(result: { content: { text: string }[] }): any {
  return JSON.parse(result.content[0]!.text);
}

describe("guardian-mcp dispatch", () => {
  it("lists exactly the three governance tools", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "guardian_invoke_tool",
      "guardian_claim",
      "guardian_record",
    ]);
  });

  it("listed tool names and descriptions say record", () => {
    for (const tool of TOOLS) {
      expect(`${tool.name} ${tool.description}`).not.toMatch(/receipt/i);
    }
  });

  it("describes every parameter and sets truthful annotations", () => {
    for (const tool of TOOLS) {
      for (const [name, schema] of Object.entries(
        tool.inputSchema.properties,
      )) {
        expect(
          (schema as { description?: string } | undefined)?.description,
          `${tool.name}.${name}`,
        ).toMatch(/\S/);
      }
      expect(tool.annotations.title).toBe(tool.title);
    }
    expect(
      Object.fromEntries(
        TOOLS.map(({ name, annotations: { title: _title, ...hints } }) => [
          name,
          hints,
        ]),
      ),
    ).toEqual({
      guardian_invoke_tool: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      guardian_claim: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      guardian_record: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
  });

  it.each([RECORD_TOOL, LEGACY_RECORD_TOOL])(
    "%s fetches the records for a request id",
    async (name) => {
      const receipts = vi
        .fn()
        .mockResolvedValue({ ok: true, receipts: [{ id: "rcpt_1" }] });
      const client = stubClient({ receipts });
      const result = await handleToolCall({ client }, name, {
        requestId: "req_1",
      });
      expect(receipts).toHaveBeenCalledWith("req_1");
      expect(payload(result)).toEqual({
        requestId: "req_1",
        receipts: [{ id: "rcpt_1" }],
      });
    },
  );

  it.each([RECORD_TOOL, LEGACY_RECORD_TOOL])(
    "%s requires a requestId",
    async (name) => {
      const receipts = vi.fn();
      const client = stubClient({ receipts });
      const result = await handleToolCall({ client }, name, {});
      expect(result.isError).toBe(true);
      expect(receipts).not.toHaveBeenCalled();
    },
  );

  it("ALLOW executes the held capability and returns the receipt", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      decision: "ALLOW",
      requestId: "req_1",
      capabilityToken: "cap_1",
    });
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      receipt: { id: "rcpt_1", status: "sent-verified" },
    });
    const client = stubClient({ request, execute });
    const result = await handleToolCall(
      { client, defaultConnectionId: "conn_1" },
      "guardian_invoke_tool",
      { toolName: "send_email", arguments: { to: "a@b.c" } },
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tool.invoke",
        connectionId: "conn_1",
        toolName: "send_email",
      }),
    );
    expect(execute).toHaveBeenCalledWith({
      requestId: "req_1",
      capabilityToken: "cap_1",
    });
    expect(payload(result)).toMatchObject({
      decision: "ALLOW",
      requestId: "req_1",
      receipt: { id: "rcpt_1" },
    });
  });

  it("ASK holds the action and instructs the agent to claim later", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ ok: true, decision: "ASK", requestId: "req_9" });
    const execute = vi.fn();
    const client = stubClient({ request, execute });
    const result = await handleToolCall(
      { client, defaultConnectionId: "conn_1" },
      "guardian_invoke_tool",
      { toolName: "wire_money" },
    );
    const body = payload(result);
    expect(body).toMatchObject({ decision: "ASK", requestId: "req_9" });
    expect(body.message).toContain("guardian_claim");
    expect(execute).not.toHaveBeenCalled();
  });

  it("DENY returns the reason code and never executes", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ ok: false, reasonCode: "POLICY_DENY" });
    const execute = vi.fn();
    const client = stubClient({ request, execute });
    const result = await handleToolCall(
      { client, defaultConnectionId: "conn_1" },
      "guardian_invoke_tool",
      { toolName: "rm_rf" },
    );
    expect(payload(result)).toMatchObject({
      decision: "DENY",
      reasonCode: "POLICY_DENY",
    });
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("guardian_claim executes after human approval", async () => {
    const claim = vi.fn().mockResolvedValue({
      ok: true,
      decision: "ALLOW",
      requestId: "req_9",
      capabilityToken: "cap_9",
    });
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      receipt: { id: "rcpt_9", status: "sent-verified" },
    });
    const client = stubClient({ claim, execute });
    const result = await handleToolCall({ client }, "guardian_claim", {
      requestId: "req_9",
    });
    expect(payload(result)).toMatchObject({
      decision: "ALLOW",
      receipt: { id: "rcpt_9" },
    });
  });

  it("rejects invokes without a connection id", async () => {
    const request = vi.fn();
    const client = stubClient({ request });
    const result = await handleToolCall({ client }, "guardian_invoke_tool", {
      toolName: "anything",
    });
    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("a held ASK (APPROVAL_REQUIRED + requestId) stays resumable, not DENY", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: false,
      reasonCode: "APPROVAL_REQUIRED",
      requestId: "req_held",
    });
    const execute = vi.fn();
    const client = stubClient({ request, execute });
    const result = await handleToolCall(
      { client, defaultConnectionId: "conn_1" },
      "guardian_invoke_tool",
      { toolName: "refund", arguments: {} },
    );
    expect(payload(result as any)).toMatchObject({
      decision: "ASK",
      requestId: "req_held",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("a claim before the person approves (APPROVAL_PENDING) stays held as ASK", async () => {
    const claim = vi.fn().mockResolvedValue({
      ok: false,
      reasonCode: "APPROVAL_PENDING",
      requestId: "req_held",
    });
    const execute = vi.fn();
    const client = stubClient({ claim, execute });
    const result = await handleToolCall({ client }, "guardian_claim", {
      requestId: "req_held",
    });
    expect(result.isError).toBeUndefined();
    expect(payload(result as any)).toMatchObject({
      decision: "ASK",
      requestId: "req_held",
      reasonCode: "APPROVAL_PENDING",
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
