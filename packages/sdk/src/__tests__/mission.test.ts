import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Text } from "../contracts/index.js";
import { receiptKeyIdFromX } from "../evidence/receipt.js";
import {
  createMissionClient,
  MISSION_FALLBACK_REASONS,
  MISSION_RECORD_DOMAIN,
  verifyMissionRecordOffline,
} from "../index.js";

type Sent = { credential: string; body: Record<string, unknown> };

function fake(answer: (sent: Sent) => [number, unknown]) {
  const sent: Sent[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const entry: Sent = {
      credential: String(
        (init.headers as Record<string, string>).authorization,
      ).replace(/^Bearer /, ""),
      body:
        typeof init.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {},
    };
    sent.push(entry);
    const [status, body] = answer(entry);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { sent, fetcher };
}

const invocation = {
  action: "tool.invoke" as const,
  connectionId: "pcn_56f422277fc0cd0b86910604d9d901aa",
  toolName: "book_flight",
  arguments: { amount: "640.00" },
};

describe("missions", () => {
  it("decides inside the mission with the mission credential", async () => {
    const { sent, fetcher } = fake((entry) => [
      200,
      { ok: true, requestId: entry.body.requestId, token: "cap_1" },
    ]);
    const guardian = createMissionClient({
      baseUrl: "https://guardian.test",
      agentCredential: "gak_agent",
      missionCredential: "gak_mission",
      fetch: fetcher,
    });
    expect(await guardian.request(invocation)).toMatchObject({
      decision: "ALLOW",
      via: "mission",
    });
    expect(sent.map((entry) => entry.credential)).toEqual(["gak_mission"]);
  });

  it("falls back to a normal request when the mission does not cover it", async () => {
    const { sent, fetcher } = fake((entry) =>
      entry.credential === "gak_mission"
        ? [403, { ok: false, reasonCode: "MERCHANT_NOT_ALLOWED" }]
        : [
            202,
            {
              ok: false,
              reasonCode: "APPROVAL_REQUIRED",
              requestId: entry.body.requestId,
            },
          ],
    );
    const guardian = createMissionClient({
      baseUrl: "https://guardian.test",
      agentCredential: "gak_agent",
      missionCredential: "gak_mission",
      fetch: fetcher,
    });
    expect(await guardian.request(invocation)).toMatchObject({
      reasonCode: "APPROVAL_REQUIRED",
      via: "standing",
      missionReasonCode: "MERCHANT_NOT_ALLOWED",
    });
    expect(sent.map((entry) => entry.credential)).toEqual([
      "gak_mission",
      "gak_agent",
    ]);
  });

  it("falls back on an authorization refusal, not on an outage", () => {
    expect(MISSION_FALLBACK_REASONS.has("NOT_AUTHORIZED")).toBe(true);
    expect(MISSION_FALLBACK_REASONS.has("SERVICE_UNAVAILABLE")).toBe(false);
    expect(MISSION_FALLBACK_REASONS.has("INVALID_REQUEST")).toBe(false);
    expect(MISSION_FALLBACK_REASONS.has("APPROVAL_REQUIRED")).toBe(false);
  });

  it("refuses records it cannot read", () => {
    expect(MISSION_RECORD_DOMAIN).toBe("odingard.guardian.mission-record.v1");
    expect(verifyMissionRecordOffline(null, { keys: [] })).toEqual({
      valid: false,
      reasonCode: "RECORD_MALFORMED",
    });
    expect(verifyMissionRecordOffline({}, { ok: false })).toEqual({
      valid: false,
      reasonCode: "RECORD_MALFORMED",
    });
  });

  it("sends a claim to the credential that made the request", async () => {
    const { sent, fetcher } = fake((entry) =>
      entry.credential === "gak_mission"
        ? [403, { ok: false, reasonCode: "NOT_AUTHORIZED" }]
        : [200, { ok: true, requestId: "req_standing", token: "cap_2" }],
    );
    const guardian = createMissionClient({
      baseUrl: "https://guardian.test",
      agentCredential: "gak_agent",
      missionCredential: "gak_mission",
      fetch: fetcher,
    });
    expect(await guardian.request(invocation)).toMatchObject({
      via: "standing",
      missionReasonCode: "NOT_AUTHORIZED",
    });
    expect(guardian.routeOf("req_standing")).toBe("standing");
    await guardian.claim("req_standing");
    expect(sent.map((entry) => entry.credential)).toEqual([
      "gak_mission",
      "gak_agent",
      "gak_agent",
    ]);
  });

  it("refuses a request id it did not make, sending nothing", async () => {
    const { sent, fetcher } = fake(() => [200, { ok: true }]);
    const guardian = createMissionClient({
      baseUrl: "https://guardian.test",
      agentCredential: "gak_agent",
      missionCredential: "gak_mission",
      fetch: fetcher,
    });
    expect(await guardian.claim("req_other")).toEqual({
      ok: false,
      reasonCode: "MISSION_REQUEST_UNKNOWN",
    });
    expect(await guardian.receipts("req_other")).toEqual({
      ok: false,
      reasonCode: "MISSION_REQUEST_UNKNOWN",
    });
    expect(sent).toEqual([]);
  });

  it("does not fall back when Guardian is unavailable", async () => {
    const { sent, fetcher } = fake(() => [
      503,
      { ok: false, reasonCode: "SERVICE_UNAVAILABLE" },
    ]);
    const guardian = createMissionClient({
      baseUrl: "https://guardian.test",
      agentCredential: "gak_agent",
      missionCredential: "gak_mission",
      fetch: fetcher,
    });
    const result = await guardian.request(invocation);
    expect(result.via).toBe("mission");
    expect(sent.map((entry) => entry.credential)).toEqual(["gak_mission"]);
  });
});

describe("signed mission records", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  const keyId = receiptKeyIdFromX(x);
  const keys = { keys: [{ kty: "OKP", crv: "Ed25519", x, kid: keyId }] };

  type Body = Record<string, unknown> & {
    card: unknown;
    limits: Record<string, unknown>;
    grants: unknown[];
    stillAsks: string[];
  };

  const digestOf = (body: Body): string =>
    sha256Text(
      canonicalJson({
        schema: "guardian.mission.v1",
        card: body.card,
        endsAtEpochMs: body.limits.endsAtEpochMs,
        currency: body.limits.currency,
        limitCents: body.limits.limitCents,
        actionLimit: body.limits.actionLimit,
        maxSubSeats: body.limits.maxSubSeats,
        grants: body.grants,
        stillAsks: body.stillAsks,
      }),
    );

  const signed = (body: Body, domain = MISSION_RECORD_DOMAIN) => ({
    ...body,
    proof: {
      algorithm: "Ed25519",
      canonicalization: "guardian-canonical-json.v1",
      domain: MISSION_RECORD_DOMAIN,
      keyId,
      signature: sign(
        null,
        Buffer.from(canonicalJson({ domain, record: body }), "utf8"),
        privateKey,
      ).toString("base64url"),
    },
  });

  const body = (): Body => {
    const base: Body = {
      schema: "guardian.mission-record.v1",
      missionId: "msn_1",
      tenantId: "ten_1",
      principalId: "prn_1",
      agentId: "agt_1",
      title: "Book my Denver trip",
      card: { sites: ["airline.example"], actions: ["commerce.purchase"] },
      limits: {
        endsAtEpochMs: 1_800_000_000_000,
        currency: "USD",
        limitCents: 200_000,
        actionLimit: 10,
        maxSubSeats: 0,
      },
      grants: [{ grantId: "grt_1", action: "commerce.purchase" }],
      stillAsks: ["email.send"],
      cardDigest: "",
      approval: { approvedAtEpochMs: 1_799_000_000_000, by: "prn_1" },
    };
    base.cardDigest = digestOf(base);
    return base;
  };

  it("accepts a record Guardian's key signed", () => {
    expect(verifyMissionRecordOffline(signed(body()), keys)).toEqual({
      valid: true,
      keyId,
    });
    expect(
      verifyMissionRecordOffline(signed(body()), { ok: true, keys }),
    ).toEqual({ valid: true, keyId });
  });

  it("refuses a record whose limits changed after signing", () => {
    const record = signed(body());
    const changed: Body = {
      ...record,
      limits: { ...record.limits, limitCents: 900_000 },
    };
    changed.cardDigest = digestOf(changed);
    expect(verifyMissionRecordOffline(changed, keys)).toEqual({
      valid: false,
      reasonCode: "RECORD_SIGNATURE_INVALID",
    });
  });

  it("refuses a signed record whose digest does not match its card", () => {
    const wrong = body();
    wrong.cardDigest = sha256Text("another card");
    expect(verifyMissionRecordOffline(signed(wrong), keys)).toEqual({
      valid: false,
      reasonCode: "RECORD_DIGEST_MISMATCH",
    });
  });

  it("refuses a record signed under another domain", () => {
    expect(
      verifyMissionRecordOffline(
        signed(body(), "odingard.guardian.receipt.v1"),
        keys,
      ),
    ).toEqual({ valid: false, reasonCode: "RECORD_SIGNATURE_INVALID" });
    const record = signed(body());
    expect(
      verifyMissionRecordOffline(
        { ...record, proof: { ...record.proof, domain: "other" } },
        keys,
      ),
    ).toEqual({ valid: false, reasonCode: "RECORD_MALFORMED" });
  });

  it("refuses a record signed by a key outside the key set", () => {
    const other = generateKeyPairSync("ed25519").publicKey.export({
      format: "jwk",
    }).x!;
    const otherId = receiptKeyIdFromX(other);
    expect(
      verifyMissionRecordOffline(signed(body()), {
        keys: [{ kty: "OKP", crv: "Ed25519", x: other, kid: otherId }],
      }),
    ).toEqual({ valid: false, reasonCode: "RECORD_KEY_UNKNOWN" });
  });
});
