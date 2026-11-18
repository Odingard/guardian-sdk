import { describe, expect, it } from "vitest";

import { createGuardianClient } from "../index.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

type Sent = { url: string; method: string; body: unknown };

function client(answer: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const guardian = createGuardianClient({
    baseUrl: "https://api.example.test/",
    credential: "gak_test",
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const entry: Sent = {
        url: String(url),
        method: init?.method ?? "GET",
        body:
          init?.body === undefined || init.body === null
            ? undefined
            : JSON.parse(String(init.body)),
      };
      sent.push(entry);
      return answer(entry);
    },
  });
  return { guardian, sent };
}

const held = {
  requestId: "req_0123456789abcdef",
  action: "tool.invoke",
  toolName: "send_email",
  purpose: "Reply to the customer",
  createdAtEpochMs: 1_700_000_000_000,
  expiresAtEpochMs: 1_700_000_120_000,
};

describe("held requests: pending", () => {
  it("lists the agent's own held requests and passes the page", async () => {
    const { guardian, sent } = client(() =>
      json({ ok: true, requests: [held], next: "1700000000000:req_x" }),
    );
    expect(
      await guardian.pending!({ limit: 5, before: "1:req_0123456789abcdef" }),
    ).toEqual({ ok: true, requests: [held], next: "1700000000000:req_x" });
    expect(sent).toEqual([
      {
        url: "https://api.example.test/v1/agent/requests?status=pending&limit=5&before=1%3Areq_0123456789abcdef",
        method: "GET",
        body: undefined,
      },
    ]);
  });

  it("asks for the pending requests, with no page options by default", async () => {
    const { guardian, sent } = client(() =>
      json({ ok: true, requests: [], next: null }),
    );
    expect(await guardian.pending!()).toEqual({
      ok: true,
      requests: [],
      next: null,
    });
    expect(sent[0]!.url).toBe(
      "https://api.example.test/v1/agent/requests?status=pending",
    );
  });

  it("fails closed on an entry it cannot read, a refusal or an outage", async () => {
    for (const [answer, reasonCode] of [
      [
        json({ ok: true, requests: [{ ...held, createdAtEpochMs: "x" }] }),
        "MALFORMED_RESPONSE",
      ],
      [
        json({ ok: true, requests: [{ ...held, toolName: 3 }] }),
        "MALFORMED_RESPONSE",
      ],
      [json({ ok: true }), "HTTP_200"],
      [
        json({ ok: false, reasonCode: "UNAUTHENTICATED" }, 401),
        "UNAUTHENTICATED",
      ],
      [new Response("not json", { status: 502 }), "HTTP_502"],
    ] as const) {
      const { guardian } = client(() => answer.clone());
      expect(await guardian.pending!()).toEqual({ ok: false, reasonCode });
    }
    const down = createGuardianClient({
      baseUrl: "https://api.example.test",
      credential: "gak_test",
      fetch: async () => {
        throw new Error("down");
      },
    });
    expect(await down.pending!()).toEqual({
      ok: false,
      reasonCode: "SERVICE_UNAVAILABLE",
    });
  });
});

describe("held requests: withdraw", () => {
  it("withdraws one request by id", async () => {
    const answer = {
      ok: true,
      requestId: "req_0123456789abcdef",
      state: "withdrawn",
      withdrawnAtEpochMs: 1_700_000_001_000,
    };
    const { guardian, sent } = client(() => json(answer));
    expect(await guardian.withdraw!("req_0123456789abcdef")).toEqual(answer);
    expect(sent).toEqual([
      {
        url: "https://api.example.test/v1/agent/requests/req_0123456789abcdef/withdraw",
        method: "POST",
        body: {},
      },
    ]);
  });

  it("encodes the request id into the path", async () => {
    const { guardian, sent } = client(() =>
      json({ ok: false, reasonCode: "INVALID_REQUEST" }, 400),
    );
    await guardian.withdraw!("req_a/../b");
    expect(sent[0]!.url).toBe(
      "https://api.example.test/v1/agent/requests/req_a%2F..%2Fb/withdraw",
    );
  });

  it("reports a decided request with its state, and never a withdrawal it did not get", async () => {
    const decided = client(() =>
      json(
        {
          ok: false,
          reasonCode: "ALREADY_DECIDED",
          requestId: "req_0123456789abcdef",
          state: "approved",
        },
        409,
      ),
    );
    expect(await decided.guardian.withdraw!("req_0123456789abcdef")).toEqual({
      ok: false,
      reasonCode: "ALREADY_DECIDED",
      requestId: "req_0123456789abcdef",
      state: "approved",
    });
    expect(await withdrawHeld(decided.guardian)).not.toHaveProperty(
      "outcomeUnknown",
    );
    for (const [answer, reasonCode, outcomeUnknown] of [
      [
        json({
          ok: true,
          requestId: "req_x",
          state: "pending",
          withdrawnAtEpochMs: 1,
        }),
        "MALFORMED_RESPONSE",
        true,
      ],
      [json({ ok: true, state: "withdrawn" }), "MALFORMED_RESPONSE", true],
      [json({ ok: false, reasonCode: "NOT_FOUND" }, 404), "NOT_FOUND", false],
      [
        json({ ok: false, reasonCode: "RATE_LIMITED" }, 429),
        "RATE_LIMITED",
        false,
      ],
      [
        json({ ok: false, reasonCode: "SERVICE_UNAVAILABLE" }, 503),
        "SERVICE_UNAVAILABLE",
        true,
      ],
      [new Response("", { status: 500 }), "HTTP_500", true],
      [new Response("not json", { status: 200 }), "HTTP_200", true],
    ] as const) {
      const { guardian } = client(() => answer.clone());
      const result = await withdrawHeld(guardian);
      expect(result).toMatchObject({ ok: false, reasonCode });
      if (outcomeUnknown) {
        expect(result).toMatchObject({ outcomeUnknown: true });
      } else {
        expect(result).not.toHaveProperty("outcomeUnknown");
      }
    }
  });

  it("reports a lost answer as unconfirmed: the request may have been withdrawn", async () => {
    const down = createGuardianClient({
      baseUrl: "https://api.example.test",
      credential: "gak_test",
      fetch: async () => {
        throw new Error("connection reset");
      },
    });
    expect(await withdrawHeld(down)).toEqual({
      ok: false,
      reasonCode: "SERVICE_UNAVAILABLE",
      outcomeUnknown: true,
    });
  });
});

function withdrawHeld(guardian: ReturnType<typeof createGuardianClient>) {
  return guardian.withdraw!("req_0123456789abcdef");
}
