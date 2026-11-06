import { describe, expect, it } from "vitest";

import {
  createGuardianClient,
  GUARDIAN_DEFAULT_REQUEST_TTL_MS,
  GUARDIAN_MAX_REQUEST_TTL_MS,
} from "../index.js";

function stubFetch(body: unknown, status = 200) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

describe("createGuardianClient", () => {
  it("validates invocation params before any network call", async () => {
    const client = createGuardianClient({
      baseUrl: "https://api.example.test",
      credential: "gac1.test",
      fetch: stubFetch({}),
    });
    let threw = false;
    try {
      await client.request({
        action: "tool.invoke",
        connectionId: "not-a-pcn",
        toolName: "refund",
        arguments: {},
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("returns a DENY decision without executing", async () => {
    const client = createGuardianClient({
      baseUrl: "https://api.example.test",
      credential: "gac1.test",
      fetch: stubFetch({
        ok: true,
        requestId: "req_0123456789abcdef",
        decision: "DENY",
        reasonCode: "POLICY",
      }),
    });
    const result = await client.request({
      action: "tool.invoke",
      connectionId: "pcn_0123456789",
      toolName: "refund",
      arguments: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision).toBe("DENY");
      expect(result.capabilityToken).toBeUndefined();
    }
  });

  it("sends the request window asked for, within the gateway's limit", async () => {
    const sent: Record<string, unknown>[] = [];
    const client = createGuardianClient({
      baseUrl: "https://api.example.test",
      credential: "gac1.test",
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ ok: false, reasonCode: "APPROVAL_REQUIRED" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      },
    });
    const tool = {
      action: "tool.invoke" as const,
      connectionId: "pcn_0123456789",
      toolName: "deploy",
      arguments: {},
    };
    await client.request(tool);
    await client.request({ ...tool, ttlMs: GUARDIAN_MAX_REQUEST_TTL_MS });
    expect(sent.map((p) => p.requestedTtlMs)).toEqual([
      GUARDIAN_DEFAULT_REQUEST_TTL_MS,
      300_000,
    ]);
    for (const ttlMs of [0, 1.5, 300_001]) {
      expect(() => client.request({ ...tool, ttlMs })).toThrow(RangeError);
    }
    expect(sent).toHaveLength(2);
  });
});
