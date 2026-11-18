import { describe, expect, it } from "vitest";

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
});
