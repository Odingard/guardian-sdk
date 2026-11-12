// The guard with the real sdk 0.4.0 client (`createGuardianClient`) over a
// fake Guardian HTTP API: no network, a throwaway test key, nothing real.
// These cover the answers sdk 0.4.0 added: ALLOW without a token,
// rate limits and a busy database while a person decides, plan limits, and an
// execute whose outcome is unknown.
import { createGuardianClient } from "@odingard/guardian-sdk";
import { describe, expect, it } from "vitest";

import { guardedFetch } from "../src/fetch.js";
import { X402GuardRefused } from "../src/index.js";
import { guardedMcpClient } from "../src/mcp.js";
import { accept, fakeServer, makeGuard, paymentRequired, signatureValid } from "./helpers.js";

const URL_A = "https://api.example.test/report";
const BASE = "https://guardian.example.test";

type Answer = { status: number; body?: unknown } | "THROW";

type Script = {
  request: (requestId: string) => Answer;
  claims?: Answer[];
  execute?: (requestId: string) => Answer;
};

const allow = (requestId: string): Answer => ({
  status: 200,
  body: { ok: true, requestId, decision: "ALLOW", capabilityToken: `cap_${requestId.slice(4)}` },
});
const ask = (requestId: string): Answer => ({
  status: 200,
  body: { ok: true, requestId, decision: "ASK", reasonCode: "APPROVAL_REQUIRED" },
});
const executed = (requestId: string): Answer => ({
  status: 200,
  body: {
    ok: true,
    receipt: {
      schemaVersion: 1,
      requestId,
      receiptReference: `att_${requestId.slice(4, 28)}`,
      status: "sent-verified",
    },
  },
});

/** A fake Guardian HTTP API driven by a script; logs every call. */
function fakeGuardianHttp(script: Script, signedCount: () => number) {
  const log: { path: string; signedSoFar: number }[] = [];
  let requestId = "";
  let claimIndex = 0;
  const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    log.push({ path: url.pathname, signedSoFar: signedCount() });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    let answer: Answer;
    if (url.pathname === "/v1/agent/requests") {
      requestId = String(body.requestId);
      answer = script.request(requestId);
    } else if (url.pathname === "/v1/agent/claims") {
      const claims = script.claims ?? [];
      answer = claims[Math.min(claimIndex, claims.length - 1)] ?? { status: 404 };
      claimIndex += 1;
      if (typeof answer === "object" && answer.body === "ALLOW") answer = allow(requestId);
    } else if (url.pathname === "/v1/agent/execute") {
      answer = (script.execute ?? executed)(requestId);
    } else {
      answer = { status: 404, body: { ok: false, reasonCode: "NOT_FOUND" } };
    }
    if (answer === "THROW") throw new TypeError("fetch failed");
    return new Response(
      answer.body === undefined
        ? ""
        : typeof answer.body === "string"
          ? answer.body
          : JSON.stringify(answer.body),
      { status: answer.status, headers: { "content-type": "application/json" } },
    );
  };
  return { fetch: fetchImpl as typeof fetch, log };
}

function setup(script: Script) {
  let wallet: ReturnType<typeof makeGuard>["wallet"] | undefined;
  const http = fakeGuardianHttp(script, () => wallet?.signed.length ?? 0);
  const guardian = createGuardianClient({
    baseUrl: BASE,
    // A placeholder credential built at runtime; the fake API ignores it.
    credential: ["gac1", "test", "placeholder"].join("."),
    fetch: http.fetch,
  });
  const made = makeGuard({ guardian });
  wallet = made.wallet;
  const server = fakeServer({ terms: (url) => paymentRequired(url, [accept()]) });
  return { ...made, http, server, pay: guardedFetch(made.guard, server.fetch) };
}

const paths = (log: { path: string }[]) => log.map((l) => l.path.replace("/v1/agent/", ""));

describe("with the real sdk 0.4.0 client", () => {
  it("ALLOW then execute: one signature, after execute", async () => {
    const t = setup({ request: allow });
    expect((await t.pay(URL_A)).status).toBe(200);
    expect(paths(t.http.log)).toEqual(["requests", "execute"]);
    expect(t.http.log.every((l) => l.signedSoFar === 0)).toBe(true);
    expect(t.wallet.signed).toHaveLength(1);
    expect(await signatureValid(t.server.paid[0]!)).toBe(true);
  });

  it("ALLOW with no capability token: the client makes it a DENY, nothing is signed", async () => {
    const t = setup({
      request: (requestId) => ({ status: 200, body: { ok: true, requestId, decision: "ALLOW" } }),
    });
    await expect(t.pay(URL_A)).rejects.toThrow(/GUARDIAN_DENIED:MALFORMED_RESPONSE/);
    expect(t.wallet.signed).toHaveLength(0);
    expect(t.server.paid).toHaveLength(0);
    expect(paths(t.http.log)).toEqual(["requests"]);
  });

  it.each([
    ["a body that is not JSON", { status: 200, body: "<html>oops</html>" }],
    ["an unknown decision", { status: 200, body: { ok: true, requestId: "x", decision: "MAYBE" } }],
  ] as const)("a malformed answer (%s): nothing is signed", async (_n, answer) => {
    const t = setup({ request: () => answer });
    await expect(t.pay(URL_A)).rejects.toThrow(/GUARDIAN_(DENIED|UNREACHABLE)/);
    expect(t.wallet.signed).toHaveLength(0);
    expect(paths(t.http.log)).toEqual(["requests"]);
  });

  it("request answered 429 RATE_LIMITED: nothing is signed and the error names RATE_LIMITED", async () => {
    const t = setup({
      request: () => ({ status: 429, body: { ok: false, reasonCode: "RATE_LIMITED" } }),
    });
    await expect(t.pay(URL_A)).rejects.toThrow(/GUARDIAN_DENIED:RATE_LIMITED/);
    expect(t.wallet.signed).toHaveLength(0);
    expect(paths(t.http.log)).toEqual(["requests"]);
  });

  it("a plan limit at request: nothing is signed", async () => {
    const t = setup({
      request: () => ({ status: 402, body: { ok: false, reasonCode: "PLAN_LIMIT_EXCEEDED" } }),
    });
    await expect(t.pay(URL_A)).rejects.toThrow(/GUARDIAN_DENIED:PLAN_LIMIT_EXCEEDED/);
    expect(t.wallet.signed).toHaveLength(0);
  });

  it("an ASK stays held through RATE_LIMITED, DB_BUSY, 429, 503 and an outage, then signs once a person approves", async () => {
    const t = setup({
      request: ask,
      claims: [
        { status: 429, body: { ok: false, reasonCode: "RATE_LIMITED" } },
        { status: 503, body: { ok: false, reasonCode: "DB_BUSY" } },
        { status: 429 },
        { status: 503 },
        "THROW",
        { status: 409, body: { ok: false, reasonCode: "APPROVAL_PENDING" } },
        { status: 200, body: "ALLOW" },
      ],
    });
    expect((await t.pay(URL_A)).status).toBe(200);
    expect(paths(t.http.log)).toEqual([
      "requests",
      "claims",
      "claims",
      "claims",
      "claims",
      "claims",
      "claims",
      "claims",
      "execute",
    ]);
    // Nothing was signed while the request was held.
    expect(t.http.log.every((l) => l.signedSoFar === 0)).toBe(true);
    expect(t.wallet.signed).toHaveLength(1);
  });

  it("an ASK that is only ever rate limited ends at the deadline with no signature", async () => {
    let wallet: ReturnType<typeof makeGuard>["wallet"] | undefined;
    const http = fakeGuardianHttp(
      {
        request: ask,
        claims: [{ status: 429, body: { ok: false, reasonCode: "RATE_LIMITED" } }],
      },
      () => wallet?.signed.length ?? 0,
    );
    const guardian = createGuardianClient({
      baseUrl: BASE,
      credential: ["gac1", "test", "placeholder"].join("."),
      fetch: http.fetch,
    });
    const made = makeGuard({ guardian, requestTtlMs: 40 });
    wallet = made.wallet;
    const server = fakeServer({ terms: (url) => paymentRequired(url, [accept()]) });
    await expect(guardedFetch(made.guard, server.fetch)(URL_A)).rejects.toThrow(/APPROVAL_TIMEOUT/);
    expect(made.wallet.signed).toHaveLength(0);
    expect(paths(http.log)).not.toContain("execute");
  });

  it("a plan limit at claim: nothing is signed", async () => {
    const t = setup({
      request: ask,
      claims: [{ status: 402, body: { ok: false, reasonCode: "PLAN_LIMIT_EXCEEDED" } }],
    });
    await expect(t.pay(URL_A)).rejects.toThrow(/GUARDIAN_DENIED:PLAN_LIMIT_EXCEEDED/);
    expect(t.wallet.signed).toHaveLength(0);
    expect(paths(t.http.log)).not.toContain("execute");
  });

  it.each([
    ["answers 503", { status: 503, body: { ok: false, reasonCode: "SERVICE_UNAVAILABLE" } }],
    ["answers 500 with no body", { status: 500 }],
    ["cannot be reached", "THROW"],
    ["answers ok with a receipt it cannot read", { status: 200, body: { ok: true, receipt: {} } }],
  ] as const)(
    "execute %s: outcome unknown, nothing is signed, and the guard records it",
    async (_n, answer) => {
      const t = setup({ request: allow, execute: () => answer });
      const err = await t.pay(URL_A).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(/EXECUTE_FAILED/);
      expect(err?.message).toMatch(/outcome unknown/);
      expect(t.wallet.signed).toHaveLength(0);
      expect(t.server.paid).toHaveLength(0);
      const recs = t.guard.records();
      const requestId = recs.find((r) => r.event === "refused")?.requestId;
      expect(requestId).toMatch(/^req_/);
      expect(recs.find((r) => r.event === "refused")).toMatchObject({
        code: "EXECUTE_FAILED",
        outcomeUnknown: true,
        requestId,
      });
      expect(recs.find((r) => r.event === "redeemed-not-signed")).toMatchObject({
        outcomeUnknown: true,
        requestId,
      });
      expect(recs.some((r) => r.event === "signed")).toBe(false);
    },
  );

  it("execute refused outright (409 CAPABILITY_USED): nothing is signed, and the outcome is known", async () => {
    const t = setup({
      request: allow,
      execute: () => ({ status: 409, body: { ok: false, reasonCode: "CAPABILITY_USED" } }),
    });
    await expect(t.pay(URL_A)).rejects.toThrow(/EXECUTE_FAILED:CAPABILITY_USED/);
    expect(t.wallet.signed).toHaveLength(0);
    const recs = t.guard.records();
    expect(recs.find((r) => r.event === "refused")?.outcomeUnknown).toBeUndefined();
    expect(recs.some((r) => r.event === "redeemed-not-signed")).toBe(false);
  });

  it("over MCP the guard throws X402GuardRefused with outcomeUnknown and the request id", async () => {
    const t = setup({ request: allow, execute: () => ({ status: 503 }) });
    const pr = paymentRequired("mcp://tool/get_weather", [accept()]);
    const mcp = {
      async callTool() {
        return { content: [{ type: "text", text: JSON.stringify(pr) }], isError: true, structuredContent: pr };
      },
    };
    const err = await guardedMcpClient(t.guard, mcp as never)
      .callTool("get_weather")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(X402GuardRefused);
    const refusedErr = err as X402GuardRefused;
    expect(refusedErr.code).toBe("EXECUTE_FAILED");
    expect(refusedErr.outcomeUnknown).toBe(true);
    expect(refusedErr.requestId).toMatch(/^req_/);
    expect(t.wallet.signed).toHaveLength(0);
  });
});
