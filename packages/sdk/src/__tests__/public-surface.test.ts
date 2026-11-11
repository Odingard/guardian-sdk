import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTENT_CHANGED_SINCE_APPROVAL,
  CONTENT_PIN_INVALID_ARGUMENT,
  CONTENT_PIN_KEY,
  CONTENT_PIN_KEY_RESERVED,
  CONTENT_PIN_MISSING,
  CONTENT_PIN_NOT_REGULAR_FILE,
  CONTENT_PIN_REMOTE_MODE,
  CONTENT_PIN_REMOTE_UPSTREAM,
  CONTENT_PIN_TOO_LARGE,
  CONTENT_PIN_TOO_MANY,
  CONTENT_PIN_UNREADABLE,
  CONTENT_PIN_UNSTABLE,
  CONTENT_PIN_UNSUPPORTED_PLATFORM,
  classifyRequestResult,
  createEmbeddedApprovalClient,
  createGuardianClient,
  fetchReceiptVerificationKeys,
  guardianCatalog,
  isHumanSessionToken,
  pinFile,
  verifyPin,
  verifyReceiptOffline,
  verifyReceiptOnline,
  verticalsForAction,
} from "../index.js";
import * as sdk from "../index.js";
import type {
  ContentPin,
  ContentPinReasonCode,
  FileArgMode,
  FileArgsSpec,
  FileDigest,
  PinFileOptions,
  PinnedFile,
} from "../index.js";

const fixtures = join(import.meta.dirname, "fixtures");
const receipt = JSON.parse(
  readFileSync(join(fixtures, "staging-receipt.json"), "utf8"),
) as Record<string, unknown>;
const keys = JSON.parse(
  readFileSync(join(fixtures, "staging-keys.json"), "utf8"),
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const tool = {
  action: "tool.invoke" as const,
  connectionId: "pcn_0123456789abcdef0123456789abcdef",
  toolName: "refund",
  arguments: { amount: 10 },
};

describe("request lifecycle", () => {
  it("a held ASK (403 APPROVAL_REQUIRED) keeps its requestId and classifies as ASK", async () => {
    const client = createGuardianClient({
      baseUrl: "https://api.example.test",
      credential: "gac1.test",
      fetch: async () =>
        json({ ok: false, reasonCode: "APPROVAL_REQUIRED" }, 403),
    });
    const result = await client.request(tool);
    expect(result.ok).toBe(false);
    expect(result.requestId).toMatch(/^req_[0-9a-f]{32}$/);
    const decision = classifyRequestResult(result);
    expect(decision.decision).toBe("ASK");
    expect(decision.requestId).toBe(result.requestId);
  });

  it("fails closed when Guardian is unreachable", async () => {
    const client = createGuardianClient({
      baseUrl: "https://api.example.test",
      credential: "gac1.test",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const result = await client.request(tool);
    expect(result).toMatchObject({
      ok: false,
      reasonCode: "SERVICE_UNAVAILABLE",
    });
    expect(classifyRequestResult(result).decision).toBe("DENY");
  });

  it("treats ALLOW without a capability token as DENY (ambiguity)", () => {
    expect(
      classifyRequestResult({
        ok: true,
        requestId: "req_x",
        decision: "ALLOW",
      }),
    ).toMatchObject({ decision: "DENY", reasonCode: "CAPABILITY_MISSING" });
  });

  it("forwards governed invocations with provenance and the right adapter", async () => {
    let sent: Record<string, unknown> = {};
    const client = createGuardianClient({
      baseUrl: "https://api.example.test",
      credential: "gac1.test",
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return json({
          ok: true,
          decision: "DENY",
          reasonCode: "NOT_AUTHORIZED",
        });
      },
    });
    await client.request({
      action: "agent.message",
      connectionId: "pcn_0123456789abcdef0123456789abcdef",
      materialParameters: { schema: "x" },
      intentId: "int_0123456789abcdef0123456789abcdef",
    });
    expect(sent.requestedAdapterId).toBe("adp_00000007");
    expect(sent.resource).toBe(
      "guardian-agent:pcn_0123456789abcdef0123456789abcdef",
    );
    expect(sent.intentId).toBe("int_0123456789abcdef0123456789abcdef");
  });

  it("retrieves the portable receipt for a request", async () => {
    let url = "";
    const client = createGuardianClient({
      baseUrl: "https://api.example.test/",
      credential: "gac1.test",
      fetch: async (u) => {
        url = String(u);
        return json({ ok: true, receipt });
      },
    });
    const result = await client.portableReceipt("req_probe_w20_fix1");
    expect(url).toBe(
      "https://api.example.test/v1/agent/receipts/req_probe_w20_fix1/portable",
    );
    expect(result.ok).toBe(true);
  });
});

describe("portable receipt verification", () => {
  it("verifies a real staging receipt offline against the published keys", () => {
    const result = verifyReceiptOffline(receipt, keys);
    expect(result).toMatchObject({ valid: true, decision: "ALLOW" });
  });

  it("rejects a tampered receipt", () => {
    const tampered = structuredClone(receipt) as {
      action: { materialParameters: { url: string } };
    };
    tampered.action.materialParameters.url = "https://attacker.example/";
    expect(verifyReceiptOffline(tampered, keys).valid).toBe(false);
  });

  it("rejects a receipt signed by an unknown key", () => {
    const other = {
      keys: [{ ...keys.keys[0], kid: "rkey_00000000000000000000000000000000" }],
    };
    expect(verifyReceiptOffline(receipt, other)).toMatchObject({
      valid: false,
      reasonCode: "UNKNOWN_KEY",
    });
  });

  it("fetches keys and verifies online without any credential", async () => {
    const calls: Array<{ url: string; auth: unknown }> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        auth: (init?.headers as Record<string, string> | undefined)
          ?.authorization,
      });
      return url.endsWith("/verification-keys")
        ? json(keys)
        : json({ valid: true });
    };
    const fetched = await fetchReceiptVerificationKeys(
      "https://api.example.test",
      { fetch },
    );
    expect(fetched.ok).toBe(true);
    const online = await verifyReceiptOnline(
      "https://api.example.test",
      receipt,
      { fetch },
    );
    expect(online).toMatchObject({ ok: true, result: { valid: true } });
    expect(calls.every((c) => c.auth === undefined)).toBe(true);
  });
});

describe("embedded approvals are human-only", () => {
  for (const token of [
    "gak_shortbutagentcredential",
    "gac1.abcdefghijklmnop",
    "gcap.v1.key_1.xyz",
  ]) {
    it(`refuses agent credential shape ${token.slice(0, 5)} before any request`, async () => {
      let called = false;
      const client = createEmbeddedApprovalClient({
        baseUrl: "https://api.example.test",
        sessionToken: token,
        fetch: (async () => {
          called = true;
          return json({ ok: true });
        }) as typeof fetch,
      });
      const result = await client.decideApproval("apr_x", {
        expectedVersion: 1,
        decision: "approve",
        presentationDigest: "d".repeat(64),
      });
      expect(result).toEqual({
        ok: false,
        reasonCode: "HUMAN_SESSION_REQUIRED",
      });
      expect(called).toBe(false);
    });
  }

  it("sends a human session token as the bearer", async () => {
    let auth = "";
    const client = createEmbeddedApprovalClient({
      baseUrl: "https://api.example.test",
      sessionToken: "eyJhbGciOiJSUzI1NiJ9.human.session",
      fetch: (async (_u: URL, init: RequestInit) => {
        auth = (init.headers as Record<string, string>).authorization ?? "";
        return json({ ok: true, approvals: [] });
      }) as unknown as typeof fetch,
    });
    expect(isHumanSessionToken("eyJhbGciOiJSUzI1NiJ9.human.session")).toBe(
      true,
    );
    expect((await client.listApprovals()).ok).toBe(true);
    expect(auth).toBe("Bearer eyJhbGciOiJSUzI1NiJ9.human.session");
  });
});

describe("public catalog metadata", () => {
  it("is declarative only and generated from the canonical catalog", () => {
    expect(guardianCatalog.schema).toBe("guardian.public-catalog.v1");
    expect(guardianCatalog.authority).toBe("none");
    expect(guardianCatalog.counts.verticals).toBe(
      guardianCatalog.verticals.length,
    );
    expect(verticalsForAction("tool.invoke").length).toBeGreaterThan(0);
  });
});

describe("content pins (public surface)", () => {
  it("exports the reserved key and every refusal code by its own name", () => {
    expect(CONTENT_PIN_KEY).toBe("guardianContentPins");
    const codes: Record<string, ContentPinReasonCode> = {
      CONTENT_CHANGED_SINCE_APPROVAL,
      CONTENT_PIN_INVALID_ARGUMENT,
      CONTENT_PIN_KEY_RESERVED,
      CONTENT_PIN_MISSING,
      CONTENT_PIN_NOT_REGULAR_FILE,
      CONTENT_PIN_REMOTE_MODE,
      CONTENT_PIN_REMOTE_UPSTREAM,
      CONTENT_PIN_TOO_LARGE,
      CONTENT_PIN_TOO_MANY,
      CONTENT_PIN_UNREADABLE,
      CONTENT_PIN_UNSTABLE,
      CONTENT_PIN_UNSUPPORTED_PLATFORM,
    };
    for (const [name, value] of Object.entries(codes)) {
      expect(value).toBe(name);
    }
    expect(Object.keys(codes)).toHaveLength(12);
  });

  it("exports pinFile and verifyPin but not the internal file-system seam", () => {
    expect(typeof pinFile).toBe("function");
    expect(typeof verifyPin).toBe("function");
    expect("setContentPinFsForTests" in sdk).toBe(false);
    expect("ContentPinError" in sdk).toBe(false);
  });

  it("the public types describe the declaration and the pin record", () => {
    const mode: FileArgMode = "bytes";
    const spec: FileArgsSpec = { attachmentPath: mode };
    const pin: ContentPin = {
      arg: "attachmentPath",
      index: 0,
      mode: "recheck",
      name: "report.pdf",
      size: 1,
      sha256: `sha256:${"a".repeat(64)}`,
    };
    const absent: FileDigest = { absent: true };
    const options: PinFileOptions = { allowAbsent: true };
    const file: Pick<PinnedFile, "name" | "size"> = { name: "x", size: 0 };
    expect([spec, pin, absent, options, file]).toHaveLength(5);
  });

  it("refuses a relative path before reading anything", async () => {
    await expect(pinFile("relative/report.pdf")).rejects.toMatchObject({
      reasonCode: CONTENT_PIN_INVALID_ARGUMENT,
    });
  });
});
