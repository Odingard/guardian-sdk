import type { PaymentPayload } from "@x402/core/types";
import { describe, expect, it } from "vitest";

import { guardedMcpClient } from "../src/mcp.js";
import { accept, fakeGuardian, makeGuard, orderLog, paymentRequired, SEPOLIA, signatureValid } from "./helpers.js";

/** An in-memory MCP client standing in for a paid MCP server. No network. */
function fakeMcp(
  opts: {
    corrective?: boolean;
    resourceUrl?: string;
    /** The resource the corrective 402 names (default: the same as the first). */
    correctiveResourceUrl?: string;
    version?: 1 | 2;
  } = {},
) {
  const paid: PaymentPayload[] = [];
  let paidCalls = 0;
  const terms = (name: string, amount = "10000", resource = opts.resourceUrl) =>
    opts.version === 1
      ? { x402Version: 1, accepts: [{ ...accept({ amount }), network: "base-sepolia", maxAmountRequired: amount, resource: `mcp://tool/${name}`, description: "", mimeType: "", amount: undefined }] }
      : paymentRequired(resource ?? `mcp://tool/${name}`, [accept({ amount })]);
  const client = {
    async callTool(params: { name: string; _meta?: Record<string, unknown> }) {
      const payment = params._meta?.["x402/payment"] as PaymentPayload | undefined;
      if (!payment) {
        const pr = terms(params.name);
        return { content: [{ type: "text", text: JSON.stringify(pr) }], isError: true, structuredContent: pr };
      }
      paid.push(payment);
      paidCalls += 1;
      if (opts.corrective && paidCalls === 1) {
        const pr = terms(params.name, "12000", opts.correctiveResourceUrl ?? opts.resourceUrl);
        return { content: [{ type: "text", text: JSON.stringify(pr) }], isError: true, structuredContent: pr };
      }
      return {
        content: [{ type: "text", text: "weather: sunny" }],
        _meta: {
          "x402/payment-response": { success: true, transaction: `0x${"ef".repeat(32)}`, network: SEPOLIA },
        },
      };
    },
  };
  return { client: client as never, paid };
}

const toolsAsked = (g: ReturnType<typeof fakeGuardian>) =>
  g.requests.map((r) => (r as { toolName: string }).toolName);

describe("MCP", () => {
  it("one Guardian request per MCP payment; request, execute, sign in that order", async () => {
    const order = orderLog();
    const guardian = fakeGuardian();
    const { guard } = makeGuard({ guardian });
    const mcp = fakeMcp();
    const client = guardedMcpClient(guard, mcp.client);
    const result = await client.callTool("get_weather", { city: "Oslo" });
    expect(result.paymentMade).toBe(true);
    expect(guardian.requests).toHaveLength(1);
    expect(order).toEqual(["request", "execute", "sign"]);
    expect(await signatureValid(mcp.paid[0]!)).toBe(true);
    const args = (guardian.requests[0] as { arguments: { resourceUrl: string; request: unknown } }).arguments;
    expect(args.resourceUrl).toBe("mcp://tool/get_weather");
    expect(args.request).toEqual({
      transport: "mcp",
      method: "tools/call",
      originalUrl: "mcp://tool/get_weather",
      finalUrl: null,
    });
    expect(guard.records().find((r) => r.event === "settlement")).toMatchObject({ success: true });
  });

  it("the corrective-402 retry gets its own decision, needs a person while the first is live, and is counted", async () => {
    const guardian = fakeGuardian({
      decide: (inv) => ((inv as { toolName: string }).toolName === "x402.pay" ? "ALLOW" : "ASK"),
    });
    const { guard, wallet } = makeGuard({ guardian });
    // Test-only: the hook that makes x402 retry after a corrective 402.
    guard.client.onPaymentResponse(async (ctx) => (ctx.paymentRequired ? { recovered: true } : undefined));
    const mcp = fakeMcp({ corrective: true });
    const result = await guardedMcpClient(guard, mcp.client).callTool("get_weather");
    expect(result.paymentMade).toBe(true);
    expect(toolsAsked(guardian)).toEqual(["x402.pay", "x402.pay.above_cap"]);
    expect((guardian.requests[1] as { arguments: { amount: string } }).arguments.amount).toBe("12000");
    expect(wallet.signed).toHaveLength(2);
    expect(await guard.liveAuthorizations()).toHaveLength(2);
  });

  it("a rule ALLOW is not enough for the corrective retry", async () => {
    const guardian = fakeGuardian({ decide: () => "ALLOW" });
    const { guard, wallet } = makeGuard({ guardian });
    guard.client.onPaymentResponse(async (ctx) => (ctx.paymentRequired ? { recovered: true } : undefined));
    const mcp = fakeMcp({ corrective: true });
    await expect(guardedMcpClient(guard, mcp.client).callTool("get_weather")).rejects.toThrow(
      /PERSON_APPROVAL_REQUIRED/,
    );
    expect(wallet.signed).toHaveLength(1);
  });

  it("a corrective 402 that names the same tool in its other accepted form still needs a person", async () => {
    const guardian = fakeGuardian({ decide: () => "ALLOW" });
    const { guard, wallet } = makeGuard({ guardian });
    guard.client.onPaymentResponse(async (ctx) => (ctx.paymentRequired ? { recovered: true } : undefined));
    const mcp = fakeMcp({
      corrective: true,
      resourceUrl: "https://mcp.example.test/tools/get_weather",
      correctiveResourceUrl: "mcp://tool/get_weather",
    });
    const client = guardedMcpClient(guard, mcp.client, { serverUrl: "https://mcp.example.test/mcp" });
    await expect(client.callTool("get_weather")).rejects.toThrow(/PERSON_APPROVAL_REQUIRED/);
    expect(toolsAsked(guardian)).toEqual(["x402.pay", "x402.pay.above_cap"]);
    const second = guardian.requests[1] as { arguments: { reviewReasons: string[] } };
    expect(second.arguments.reviewReasons).toContain("LIVE_AUTHORIZATION_FOR_REQUEST");
    expect(wallet.signed).toHaveLength(1);
    expect(await guard.liveAuthorizations()).toHaveLength(1);
  });

  it("a second call to the same tool while the first authorization is live needs a person, whichever accepted form the server names", async () => {
    const guardian = fakeGuardian({ decide: () => "ALLOW" });
    const { guard, wallet } = makeGuard({ guardian });
    const options = { serverUrl: "https://mcp.example.test/mcp" };
    const first = guardedMcpClient(guard, fakeMcp({ resourceUrl: "https://mcp.example.test/tools/get_weather" }).client, options);
    expect((await first.callTool("get_weather")).paymentMade).toBe(true);
    const second = guardedMcpClient(guard, fakeMcp({ resourceUrl: "mcp://tool/get_weather" }).client, options);
    await expect(second.callTool("get_weather")).rejects.toThrow(/PERSON_APPROVAL_REQUIRED/);
    expect(toolsAsked(guardian)).toEqual(["x402.pay", "x402.pay.above_cap"]);
    expect(wallet.signed).toHaveLength(1);
  });

  it("DENY throws before any payload is created", async () => {
    const guardian = fakeGuardian({ decide: () => ({ deny: "POLICY_DENIED" }) });
    const { guard, wallet } = makeGuard({ guardian });
    const mcp = fakeMcp();
    await expect(guardedMcpClient(guard, mcp.client).callTool("get_weather")).rejects.toThrow(
      /GUARDIAN_DENIED:POLICY_DENIED/,
    );
    expect(wallet.signed).toHaveLength(0);
    expect(mcp.paid).toHaveLength(0);
  });

  it("the guard refuses to add onPaymentRequired hooks", () => {
    const { guard } = makeGuard({ guardian: fakeGuardian() });
    const client = guardedMcpClient(guard, fakeMcp().client);
    expect(() => client.onPaymentRequired(async () => ({ payment: {} as never }))).toThrow(/GUARD_SEALED/);
  });

  it("v1 payment terms are refused on MCP", async () => {
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian });
    const mcp = fakeMcp({ version: 1 });
    await expect(guardedMcpClient(guard, mcp.client).callTool("get_weather")).rejects.toThrow(
      /V1_NOT_SUPPORTED_ON_MCP/,
    );
    expect(guardian.calls).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  it("mcp://tool/<other tool> is refused, with or without serverUrl", async () => {
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian });
    for (const options of [{}, { serverUrl: "https://mcp.example.test/mcp" }]) {
      await expect(
        guardedMcpClient(guard, fakeMcp({ resourceUrl: "mcp://tool/other_tool" }).client, options).callTool("get_weather"),
      ).rejects.toThrow(/RESOURCE_HOST_MISMATCH/);
    }
    expect(guardian.calls).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  it("another tool or path on the serverUrl host is refused before Guardian or the wallet", async () => {
    const guardian = fakeGuardian({ decide: () => "ALLOW" });
    const { guard, wallet } = makeGuard({ guardian });
    const options = { serverUrl: "http://mcp.example.test:8402/mcp" };
    for (const resourceUrl of [
      "http://mcp.example.test:8402/tools/other_tool",
      "http://mcp.example.test:8402/tools/get_weather?x=1",
      "http://mcp.example.test:8402/tools/get_weather/",
      "http://mcp.example.test:8402/tools/get_weather#a",
      "http://mcp.example.test:8402/mcp",
      "http://mcp.example.test:8402/",
      "http://mcp.example.test:8402/other/get_weather",
      "https://mcp.example.test:8402/tools/get_weather",
      "http://mcp.example.test/tools/get_weather",
      "http://evil@mcp.example.test:8402/tools/get_weather",
      "mcp://tool/get_weather/x",
    ]) {
      await expect(
        guardedMcpClient(guard, fakeMcp({ resourceUrl }).client, options).callTool("get_weather"),
        resourceUrl,
      ).rejects.toThrow(/RESOURCE_HOST_MISMATCH/);
    }
    // Without serverUrl, even the right tool path on a server host is refused.
    await expect(
      guardedMcpClient(guard, fakeMcp({ resourceUrl: "http://mcp.example.test:8402/tools/get_weather" }).client).callTool(
        "get_weather",
      ),
    ).rejects.toThrow(/RESOURCE_HOST_MISMATCH/);
    expect(guardian.calls).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  it("the called tool is accepted as mcp://tool/<tool>, and as <serverUrl origin>/tools/<tool> when serverUrl is set", async () => {
    const guardian = fakeGuardian({ decide: () => "ALLOW" });
    const { guard, wallet } = makeGuard({ guardian });
    const a = await guardedMcpClient(guard, fakeMcp({ resourceUrl: "mcp://tool/get_weather" }).client).callTool(
      "get_weather",
    );
    expect(a.paymentMade).toBe(true);
    const b = await guardedMcpClient(guard, fakeMcp({ resourceUrl: "http://MCP.example.test:8402/tools/get_time" }).client, {
      serverUrl: "http://mcp.example.test:8402/mcp",
    }).callTool("get_time");
    expect(b.paymentMade).toBe(true);
    expect(toolsAsked(guardian)).toEqual(["x402.pay", "x402.pay"]);
    expect(wallet.signed).toHaveLength(2);
  });

  it("onPaymentRequested only checks locally that the guard is installed; it never asks Guardian", () => {
    const guardian = fakeGuardian();
    const { guard } = makeGuard({ guardian });
    const client = guardedMcpClient(guard, fakeMcp().client);
    const approve = (client as unknown as { options: { onPaymentRequested: () => boolean } }).options
      .onPaymentRequested;
    expect(approve()).toBe(true);
    expect(client.paymentClient).toBe(guard.client);
    expect(guardian.calls).toHaveLength(0);
  });
});
