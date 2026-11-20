import { describe, expect, it } from "vitest";

import {
  abortable,
  createGuardianContext,
  GuardianApprovalPending,
  runThroughGuardian,
  type GuardianAdapterOptions,
  type GuardianClient,
  type GuardianInvocation,
  type GuardianRequestResult,
} from "../index.js";

/**
 * `abortable(client, signal, run)`: a caller's abort rejects a guarded call
 * that has not started and refuses its later steps; a started call is never
 * abandoned. Driven here the way the adapters drive it, around the real
 * `runThroughGuardian`, with a stand-in Guardian client.
 */

const CONNECTION = "pcn_0123456789abcdef0123456789abcdef";
const TOKEN = "cap_0123456789abcdef0123456789abcdef";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const receiptFor = (requestId: string) => ({
  schemaVersion: 1 as const,
  requestId,
  receiptReference: "att_0123456789abcdef",
  status: "sent-verified" as const,
});

type Stub = GuardianClient & {
  calls: string[];
  requested: GuardianInvocation[];
};

function stubClient(
  overrides: Partial<{
    request: (input: GuardianInvocation) => Promise<GuardianRequestResult>;
    claim: (requestId: string) => Promise<GuardianRequestResult>;
    execute: GuardianClient["execute"];
  }> = {},
): Stub {
  const calls: string[] = [];
  const requested: GuardianInvocation[] = [];
  const allow: GuardianRequestResult = {
    ok: true,
    requestId: "req_allow",
    decision: "ALLOW",
    capabilityToken: TOKEN,
  };
  return {
    calls,
    requested,
    async request(input) {
      calls.push(`request:${input.action}`);
      requested.push(input);
      return overrides.request ? overrides.request(input) : allow;
    },
    async claim(requestId) {
      calls.push("claim");
      return overrides.claim ? overrides.claim(requestId) : allow;
    },
    async execute(input) {
      calls.push("execute");
      return overrides.execute
        ? overrides.execute(input)
        : { ok: true, receipt: receiptFor(input.requestId) as never };
    },
    async portableReceipt() {
      return { ok: false, reasonCode: "NOT_FOUND" };
    },
    async receipts(requestId) {
      calls.push("receipts");
      return { ok: true, requestId, receipts: [] };
    },
  };
}

/** One guarded call, wired as the framework adapters wire it. */
function guardedCall(
  client: GuardianClient,
  signal: AbortSignal | undefined,
  options: Partial<GuardianAdapterOptions>,
  tool: (input: unknown) => unknown,
  seenClients: GuardianClient[] = [],
) {
  const ctx = createGuardianContext({
    client,
    connectionId: CONNECTION,
    ...options,
  });
  return abortable(client, signal, (gated, startTool) => {
    seenClients.push(gated);
    return runThroughGuardian(
      gated === client ? ctx : { ...ctx, options: { ...ctx.options, client: gated } },
      "send_email",
      { to: "a@example.test" },
      (approved) => {
        startTool();
        return tool(approved);
      },
    );
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("abortable", () => {
  it("without a signal hands run the client itself and a no-op start", async () => {
    const client = stubClient();
    const seen: GuardianClient[] = [];
    const out = await abortable(client, undefined, async (given, startTool) => {
      seen.push(given);
      startTool();
      return "done";
    });
    expect(out).toBe("done");
    expect(seen[0]).toBe(client);
  });

  it("an already aborted signal rejects with its reason and never calls run", async () => {
    const client = stubClient();
    let ran = false;
    await expect(
      abortable(client, AbortSignal.abort(new Error("already stopped")), async () => {
        ran = true;
      }),
    ).rejects.toThrow("already stopped");
    expect(ran).toBe(false);
    expect(client.calls).toEqual([]);
  });

  it("rejects with a plain error when the signal carries no reason", async () => {
    const signal = { aborted: true, reason: undefined } as AbortSignal;
    await expect(
      abortable(stubClient(), signal, async () => "x"),
    ).rejects.toThrow("aborted");
  });

  it("with a signal hands run a view of the client, which still reaches its other members", async () => {
    const client = stubClient();
    const seen: GuardianClient[] = [];
    const controller = new AbortController();
    await abortable(client, controller.signal, async (given) => {
      seen.push(given);
      expect(await given.receipts("req_x")).toEqual({
        ok: true,
        requestId: "req_x",
        receipts: [],
      });
    });
    expect(seen[0]).not.toBe(client);
    expect(client.calls).toEqual(["receipts"]);
  });

  it("inProcess: an abort while Guardian decides rejects at once, and a late ALLOW runs nothing", async () => {
    const answer = deferred<GuardianRequestResult>();
    const client = stubClient({ request: () => answer.promise });
    const controller = new AbortController();
    let ran = 0;
    const call = guardedCall(client, controller.signal, { mode: "inProcess" }, () => {
      ran += 1;
    });
    const settled = call.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await tick();
    controller.abort(new Error("cancelled by caller"));
    expect(await settled).toBe("cancelled by caller");
    answer.resolve({
      ok: true,
      requestId: "req_late",
      decision: "ALLOW",
      capabilityToken: TOKEN,
    });
    await tick();
    expect(ran).toBe(0);
    expect(client.calls).toEqual(["request:tool.invoke"]);
  });

  it("remote: an abort while Guardian decides means Guardian is never asked to perform the call", async () => {
    const answer = deferred<GuardianRequestResult>();
    const client = stubClient({ request: () => answer.promise });
    const controller = new AbortController();
    const call = guardedCall(client, controller.signal, { mode: "remote" }, () => {
      throw new Error("a remote tool never runs locally");
    });
    const settled = call.catch((error: Error) => error.message);
    await tick();
    controller.abort(new Error("cancelled by caller"));
    expect(await settled).toBe("cancelled by caller");
    answer.resolve({
      ok: true,
      requestId: "req_late",
      decision: "ALLOW",
      capabilityToken: TOKEN,
    });
    await tick();
    expect(client.calls).toEqual(["request:tool.invoke"]);
  });

  it("inProcess: an abort after the tool started waits for its real outcome and records it", async () => {
    const client = stubClient();
    const controller = new AbortController();
    const working = deferred<string>();
    const started = deferred<void>();
    const call = guardedCall(client, controller.signal, { mode: "inProcess" }, () => {
      started.resolve();
      return working.promise;
    });
    let state = "pending";
    void call.then(
      () => (state = "resolved"),
      () => (state = "rejected"),
    );
    await started.promise;
    controller.abort(new Error("cancelled by caller"));
    await tick();
    expect(state).toBe("pending");
    working.resolve("sent");
    expect(await call).toBe("sent");
    expect(client.calls).toEqual(["request:tool.invoke", "execute"]);
  });

  it("remote: an abort after Guardian was asked to perform the call waits for the receipt", async () => {
    const performing = deferred<Awaited<ReturnType<GuardianClient["execute"]>>>();
    const asked = deferred<void>();
    const client = stubClient({
      execute: () => {
        asked.resolve();
        return performing.promise;
      },
    });
    const controller = new AbortController();
    const call = guardedCall(client, controller.signal, { mode: "remote" }, () => {
      throw new Error("a remote tool never runs locally");
    });
    let state = "pending";
    void call.then(
      () => (state = "resolved"),
      () => (state = "rejected"),
    );
    await asked.promise;
    controller.abort(new Error("cancelled by caller"));
    await tick();
    expect(state).toBe("pending");
    performing.resolve({ ok: true, receipt: receiptFor("req_allow") as never });
    expect(await call).toMatchObject({
      guardian: { decision: "ALLOW", requestId: "req_allow" },
    });
  });

  it("an abort between the ALLOW and the tool refuses the tool and redeems nothing", async () => {
    const controller = new AbortController();
    const client = stubClient({
      request: async () => {
        // The caller aborts while the answer is on its way back.
        controller.abort(new Error("cancelled by caller"));
        return {
          ok: true,
          requestId: "req_allow",
          decision: "ALLOW",
          capabilityToken: TOKEN,
        };
      },
    });
    let ran = 0;
    await expect(
      guardedCall(client, controller.signal, { mode: "inProcess" }, () => {
        ran += 1;
      }),
    ).rejects.toThrow("cancelled by caller");
    await tick();
    expect(ran).toBe(0);
    expect(client.calls).toEqual(["request:tool.invoke"]);
  });

  it("a record-transport setup step is not the tool starting", async () => {
    const controller = new AbortController();
    const client = stubClient({
      request: async (input) => ({
        ok: true,
        requestId: input.action === "mcp.install" ? "req_setup" : "req_tool",
        decision: "ALLOW",
        capabilityToken: TOKEN,
      }),
      execute: async (input) => {
        if (input.requestId === "req_setup") {
          // Aborted while the setup step is executed: still "deciding".
          controller.abort(new Error("cancelled during setup"));
        }
        return { ok: true, receipt: receiptFor(input.requestId) as never };
      },
    });
    let ran = 0;
    await expect(
      guardedCall(
        client,
        controller.signal,
        { mode: "inProcess", installRecordTransport: true },
        () => {
          ran += 1;
        },
      ),
    ).rejects.toThrow("cancelled during setup");
    await tick();
    expect(ran).toBe(0);
    expect(client.calls).toEqual(["request:mcp.install", "execute"]);
  });

  it("after the call settled, a later resume() is not refused by the old abort", async () => {
    const controller = new AbortController();
    const client = stubClient({
      request: async () => ({
        ok: true,
        requestId: "req_held",
        decision: "ASK",
      }),
    });
    let ran = 0;
    const pending = await guardedCall(
      client,
      controller.signal,
      { mode: "inProcess" },
      () => {
        ran += 1;
        return "sent";
      },
    ).catch((error: unknown) => error);
    expect(pending).toBeInstanceOf(GuardianApprovalPending);
    controller.abort(new Error("the run ended"));
    const resumed = await (pending as GuardianApprovalPending).resume();
    expect(resumed.output).toBe("sent");
    expect(ran).toBe(1);
    expect(client.calls).toEqual(["request:tool.invoke", "claim", "execute"]);
  });

  it("passes a failure of the call through and stops listening to the signal", async () => {
    const controller = new AbortController();
    const client = stubClient();
    await expect(
      guardedCall(client, controller.signal, { mode: "inProcess" }, () => {
        throw new Error("tool failed");
      }),
    ).rejects.toThrow("tool failed");
    controller.abort();
    expect(client.calls).toEqual(["request:tool.invoke"]);
  });
});
