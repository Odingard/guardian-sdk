import { describe, expect, it } from "vitest";

import {
  createGuard,
  createGuardianClient,
  createGuardianContext,
  GuardianDenied,
  GuardianExecutionFailed,
  settle,
  type GuardianClient,
  type GuardianInvocation,
  type GuardianRequestResult,
} from "../index.js";

/**
 * Watch mode. While the agent is in watch mode, Guardian records what it
 * would have decided. For a would-ask or a would-deny it issues no
 * capability; a caller that sent `x-guardian-watch-aware: 1` gets a watched
 * answer (`decision: "DENY"`, reasonCode `WATCHED`,
 * `watch: { wouldDecision }`). The guard asks for it only for a tool that
 * runs in the agent's own process, and then runs the tool with nothing to
 * record. A remote tool is never run by the SDK and never asks for the
 * watched answer.
 */

const CONNECTION = "pcn_0123456789abcdef0123456789abcdef";

type Seen = { url: string; headers: Record<string, string>; body: unknown };

function clientAnswering(body: unknown, seen: Seen[] = []): GuardianClient {
  return createGuardianClient({
    baseUrl: "https://guardian.test",
    credential: "gak_test",
    fetch: async (url, init) => {
      seen.push({
        url: String(url),
        headers: { ...(init?.headers as Record<string, string>) },
        body: JSON.parse(String(init?.body ?? "null")),
      });
      return Response.json(body);
    },
  });
}

const invocation = (watchAware?: boolean): GuardianInvocation => ({
  action: "tool.invoke",
  connectionId: CONNECTION,
  toolName: "delete_ticket",
  arguments: {},
  ...(watchAware === undefined ? {} : { watchAware }),
});

const watchedBody = (wouldDecision: unknown) => ({
  ok: true,
  requestId: "req_watched01",
  decision: "DENY",
  reasonCode: "WATCHED",
  watch: { wouldDecision },
});

describe("the client", () => {
  it("sends the watch-aware header only when asked, never in the proposal", async () => {
    const seen: Seen[] = [];
    const client = clientAnswering({ ok: true, decision: "DENY" }, seen);
    await client.request(invocation(true));
    await client.request(invocation(false));
    await client.request(invocation());
    expect(seen.map((s) => s.headers["x-guardian-watch-aware"])).toEqual([
      "1",
      undefined,
      undefined,
    ]);
    for (const s of seen) {
      expect(JSON.stringify(s.body)).not.toContain("watch");
    }
  });

  it("keeps an exact ASK or DENY on a watched DENY", async () => {
    for (const wouldDecision of ["ASK", "DENY"] as const) {
      const answered = await clientAnswering(
        watchedBody(wouldDecision),
      ).request(invocation(true));
      expect(answered).toEqual({
        ok: true,
        requestId: "req_watched01",
        decision: "DENY",
        reasonCode: "WATCHED",
        watched: wouldDecision,
      });
    }
  });

  it("ignores a watch field anywhere else", async () => {
    for (const wouldDecision of [undefined, "ALLOW", "deny", ["DENY"], {}]) {
      const answered = await clientAnswering(
        watchedBody(wouldDecision),
      ).request(invocation(true));
      expect(answered).toEqual({
        ok: true,
        requestId: "req_watched01",
        decision: "DENY",
        reasonCode: "WATCHED",
      });
    }
    // Not a WATCHED denial, or not a denial at all.
    const other = await clientAnswering({
      ...watchedBody("DENY"),
      reasonCode: "POLICY_DENY",
    }).request(invocation(true));
    expect(other).not.toHaveProperty("watched");
    const ask = await clientAnswering({
      ...watchedBody("DENY"),
      decision: "ASK",
    }).request(invocation(true));
    expect(ask).not.toHaveProperty("watched");
    const allow = await clientAnswering({
      ...watchedBody("DENY"),
      decision: "ALLOW",
      token: "cap",
    }).request(invocation(true));
    expect(allow).not.toHaveProperty("watched");
  });
});

function fakeClient(invoke: GuardianRequestResult) {
  const calls: string[] = [];
  const asked: GuardianInvocation[] = [];
  const client: GuardianClient = {
    async request(invocationSent) {
      calls.push(`request:${invocationSent.action}`);
      asked.push(invocationSent);
      return invoke;
    },
    async claim(requestId) {
      calls.push(`claim:${requestId}`);
      return { ok: false, reasonCode: "APPROVAL_PENDING" };
    },
    async execute({ requestId }) {
      calls.push(`execute:${requestId}`);
      return { ok: false, reasonCode: "AUTHORITY_NOT_ALLOWED" };
    },
    async portableReceipt() {
      return { ok: false, reasonCode: "UNUSED" };
    },
    async receipts() {
      return { ok: false, reasonCode: "UNUSED" };
    },
  };
  return { client, calls, asked };
}

const watched = (wouldDecision: "ASK" | "DENY"): GuardianRequestResult => ({
  ok: true,
  requestId: "req_watched01",
  decision: "DENY",
  reasonCode: "WATCHED",
  watched: wouldDecision,
});

describe("the guard while the agent is watched", () => {
  it("asks for the watched answer for an inProcess tool only", async () => {
    const local = fakeClient(watched("DENY"));
    await createGuard({ client: local.client, connectionId: CONNECTION })(
      "delete_ticket",
      () => "deleted",
    )({});
    expect(local.asked[0]).toMatchObject({ watchAware: true });

    const remote = fakeClient({
      ok: true,
      requestId: "req_r",
      decision: "DENY",
    });
    await createGuard({
      client: remote.client,
      connectionId: CONNECTION,
      mode: "remote",
    })(
      "delete_ticket",
      () => "deleted",
    )({}).catch(() => undefined);
    expect(remote.asked[0]).not.toHaveProperty("watchAware");
  });

  it("runs the tool once, records nothing and reports it", async () => {
    for (const wouldDecision of ["ASK", "DENY"] as const) {
      const { client, calls } = fakeClient(watched(wouldDecision));
      let ran = 0;
      const seen: unknown[] = [];
      const receipts: unknown[] = [];
      const tool = createGuard({
        client,
        connectionId: CONNECTION,
        onWatched: (event) => {
          seen.push(event);
        },
        onReceipt: (event) => {
          receipts.push(event);
        },
      })("delete_ticket", (input: { id: number }) => {
        ran += 1;
        return `deleted ${input.id}`;
      });
      await expect(tool({ id: 1 })).resolves.toBe("deleted 1");
      expect(ran).toBe(1);
      expect(calls).toEqual(["request:tool.invoke"]);
      expect(seen).toEqual([
        {
          toolName: "delete_ticket",
          requestId: "req_watched01",
          wouldDecision,
        },
      ]);
      expect(receipts).toEqual([]);
    }
  });

  it("returns the output even when onWatched throws", async () => {
    const { client } = fakeClient(watched("DENY"));
    const tool = createGuard({
      client,
      connectionId: CONNECTION,
      onWatched: () => {
        throw new Error("observer failed");
      },
    })("delete_ticket", () => "deleted");
    await expect(tool({})).resolves.toBe("deleted");
  });

  it("keeps every other DENY a denial", async () => {
    for (const answer of [
      { ok: true, requestId: "r1", decision: "DENY" },
      { ok: true, requestId: "r1", decision: "DENY", reasonCode: "WATCHED" },
      {
        ok: true,
        requestId: "r1",
        decision: "DENY",
        reasonCode: "POLICY_DENY",
        watched: "DENY",
      },
      {
        ok: true,
        requestId: "r1",
        decision: "DENY",
        reasonCode: "WATCHED",
        watched: "ALLOW",
      },
    ] as GuardianRequestResult[]) {
      const { client, calls } = fakeClient(answer);
      let ran = 0;
      const tool = createGuard({ client, connectionId: CONNECTION })(
        "delete_ticket",
        () => {
          ran += 1;
        },
      );
      await expect(tool({})).rejects.toBeInstanceOf(GuardianDenied);
      expect(ran).toBe(0);
      expect(calls).toEqual(["request:tool.invoke"]);
    }
  });

  it("never runs a remote tool on a watched answer", async () => {
    const { client, calls } = fakeClient(watched("DENY"));
    let ran = 0;
    const tool = createGuard({
      client,
      connectionId: CONNECTION,
      mode: "remote",
    })("delete_ticket", () => {
      ran += 1;
    });
    await expect(tool({})).rejects.toBeInstanceOf(GuardianDenied);
    expect(ran).toBe(0);
    expect(calls).toEqual(["request:tool.invoke"]);
  });

  it("still checks the content pins before the tool runs", async () => {
    const { client } = fakeClient(watched("DENY"));
    const ctx = createGuardianContext({
      client,
      connectionId: CONNECTION,
      mode: "inProcess",
      fileArgs: { send_report: ["attachmentPath"] },
    });
    let ran = false;
    const failure = await settle(
      ctx,
      "send_report",
      { attachmentPath: "/tmp/watch-report.pdf" },
      watched("DENY"),
      () => {
        ran = true;
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GuardianExecutionFailed);
    expect(failure).toMatchObject({
      reasonCode: "CONTENT_PIN_MISSING",
      localEffectRan: false,
    });
    expect(ran).toBe(false);
  });
});
