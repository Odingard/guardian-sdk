import { describe, expect, it } from "vitest";

import {
  createGuard,
  createGuardianClient,
  createTimeoutFetch,
  GUARDIAN_DEFAULT_CALL_TIMEOUT_MS,
  GUARDIAN_MAX_CALL_TIMEOUT_MS,
  GuardianApprovalPending,
  GuardianDenied,
  GuardianExecutionFailed,
  withRequestTimeout,
  type GuardianClient,
} from "../index.js";

/**
 * `createTimeoutFetch` / `withRequestTimeout`: every HTTP call of the real
 * client ends at the time limit or when the caller's signal aborts, and the
 * client and the guard report it fail closed. The transport below is a
 * stand-in that behaves like `fetch`: it rejects with the signal's reason
 * when the signal aborts, before or while it waits.
 */

const CONNECTION = "pcn_0123456789abcdef0123456789abcdef";
const TOKEN = "cap_0123456789abcdef0123456789abcdef";
const LIMIT = 25;

type Call = { path: string; signal: AbortSignal | undefined };
type Answer = Response | "hang";

/** Never answers; rejects like fetch when its signal aborts. */
function hang(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

function transport(
  answer: (path: string, body: unknown) => Answer | Promise<Answer>,
  calls: Call[] = [],
): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal ?? undefined;
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    calls.push({ path, signal });
    if (signal?.aborted) throw signal.reason;
    const answered = await answer(
      path,
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    );
    return answered === "hang" ? hang(signal) : answered;
  };
}

/** An answer whose headers arrive and whose body never ends. */
function stalledBody(signal: AbortSignal | undefined): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":true,'));
        signal?.addEventListener(
          "abort",
          () => controller.error(signal.reason),
          { once: true },
        );
      },
    }),
    { status: 200 },
  );
}

const allow = (body: unknown) =>
  Response.json({
    ok: true,
    requestId: (body as { requestId: string }).requestId,
    token: TOKEN,
  });

const executed = (body: unknown) =>
  Response.json({
    ok: true,
    receipt: {
      schemaVersion: 1,
      requestId: (body as { requestId: string }).requestId,
      receiptReference: "att_0123456789abcdef",
      status: "sent-verified",
    },
  });

function boundedClient(
  answer: (path: string, body: unknown) => Answer | Promise<Answer>,
  options: { calls?: Call[]; signal?: AbortSignal; timeoutMs?: number } = {},
): GuardianClient {
  return createGuardianClient(
    withRequestTimeout(
      {
        baseUrl: "https://guardian.test",
        credential: "gak_test",
        fetch: transport(answer, options.calls),
      },
      {
        timeoutMs: options.timeoutMs ?? LIMIT,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    ),
  );
}

const invocation = {
  action: "tool.invoke",
  connectionId: CONNECTION,
  toolName: "send_email",
  arguments: { to: "a@example.test" },
} as const;

describe("createTimeoutFetch", () => {
  it("rejects with a TimeoutError once the limit passes", async () => {
    const bounded = createTimeoutFetch({
      timeoutMs: LIMIT,
      fetch: transport(() => "hang"),
    });
    const started = Date.now();
    await expect(bounded("https://guardian.test/x")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("gives every call its own timer", async () => {
    const calls: Call[] = [];
    const bounded = createTimeoutFetch({
      timeoutMs: LIMIT,
      fetch: transport(() => "hang", calls),
    });
    await expect(bounded("https://guardian.test/a")).rejects.toBeDefined();
    // The first call's limit has passed; the second starts a new one.
    const second = bounded("https://guardian.test/b");
    expect(calls[1]!.signal!.aborted).toBe(false);
    await expect(second).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("passes an answer that arrives in time through unchanged", async () => {
    const bounded = createTimeoutFetch({
      timeoutMs: 5_000,
      fetch: transport(() => Response.json({ ok: true })),
    });
    const response = await bounded("https://guardian.test/x", {
      method: "POST",
      headers: { authorization: "Bearer gak_test" },
      body: "{}",
    });
    expect(await response.json()).toEqual({ ok: true });
  });

  it("keeps the call's method, headers and body", async () => {
    const seen: RequestInit[] = [];
    const bounded = createTimeoutFetch({
      fetch: async (_input, init) => {
        seen.push(init!);
        return Response.json({});
      },
    });
    await bounded("https://guardian.test/x", {
      method: "POST",
      headers: { authorization: "Bearer gak_test" },
      body: '{"a":1}',
    });
    expect(seen[0]).toMatchObject({
      method: "POST",
      headers: { authorization: "Bearer gak_test" },
      body: '{"a":1}',
    });
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("ends a call in flight when the caller's signal aborts", async () => {
    const controller = new AbortController();
    const bounded = createTimeoutFetch({
      timeoutMs: 5_000,
      signal: controller.signal,
      fetch: transport(() => "hang"),
    });
    const pending = bounded("https://guardian.test/x");
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });

  it("refuses a call made after the caller's signal aborted", async () => {
    const calls: Call[] = [];
    const bounded = createTimeoutFetch({
      signal: AbortSignal.abort(new Error("stopped")),
      fetch: transport(() => Response.json({}), calls),
    });
    await expect(bounded("https://guardian.test/x")).rejects.toThrow(
      "stopped",
    );
    expect(calls[0]!.signal!.aborted).toBe(true);
  });

  it("keeps a signal passed with the call itself", async () => {
    const controller = new AbortController();
    const bounded = createTimeoutFetch({
      timeoutMs: 5_000,
      fetch: transport(() => "hang"),
    });
    const pending = bounded("https://guardian.test/x", {
      signal: controller.signal,
    });
    controller.abort(new Error("call stopped"));
    await expect(pending).rejects.toThrow("call stopped");
  });

  describe("a Request input that carries its own signal", () => {
    // Like fetch, the stand-in sees only `init.signal`: the wrapper has to
    // carry the Request's signal into it.
    const seenSignal = (calls: Call[]) => calls[0]!.signal!;

    it("refuses a Request whose signal is already aborted", async () => {
      const calls: Call[] = [];
      const bounded = createTimeoutFetch({
        timeoutMs: 5_000,
        fetch: transport(() => Response.json({}), calls),
      });
      const request = new Request("https://guardian.test/x", {
        signal: AbortSignal.abort(new Error("request stopped")),
      });
      await expect(bounded(request)).rejects.toThrow("request stopped");
      expect(seenSignal(calls).aborted).toBe(true);
    });

    it("ends the call when the Request's signal aborts in flight", async () => {
      const controller = new AbortController();
      const calls: Call[] = [];
      const bounded = createTimeoutFetch({
        timeoutMs: 5_000,
        fetch: transport(() => "hang", calls),
      });
      const pending = bounded(
        new Request("https://guardian.test/x", { signal: controller.signal }),
      );
      controller.abort(new Error("request stopped"));
      await expect(pending).rejects.toThrow("request stopped");
    });

    it("lets an explicit init.signal override the Request's, as fetch does", async () => {
      const ofRequest = new AbortController();
      const ofInit = new AbortController();
      const calls: Call[] = [];
      const bounded = createTimeoutFetch({
        timeoutMs: 5_000,
        fetch: transport(() => "hang", calls),
      });
      const pending = bounded(
        new Request("https://guardian.test/x", { signal: ofRequest.signal }),
        { signal: ofInit.signal },
      );
      ofRequest.abort(new Error("request stopped"));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(seenSignal(calls).aborted).toBe(false); // overridden: not followed
      ofInit.abort(new Error("init stopped"));
      await expect(pending).rejects.toThrow("init stopped");
    });

    it("drops the Request's signal for an explicit init.signal of null", async () => {
      const calls: Call[] = [];
      const bounded = createTimeoutFetch({
        timeoutMs: 5_000,
        fetch: transport(() => Response.json({ ok: true }), calls),
      });
      const response = await bounded(
        new Request("https://guardian.test/x", {
          signal: AbortSignal.abort(new Error("request stopped")),
        }),
        { signal: null },
      );
      expect(await response.json()).toEqual({ ok: true });
      expect(seenSignal(calls).aborted).toBe(false);
    });

    it("still applies the time limit and the caller's signal", async () => {
      const bounded = createTimeoutFetch({
        timeoutMs: LIMIT,
        fetch: transport(() => "hang"),
      });
      await expect(
        bounded(
          new Request("https://guardian.test/x", {
            signal: new AbortController().signal,
          }),
        ),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    });
  });

  it("refuses a time limit that is not a whole number in range", () => {
    for (const timeoutMs of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      GUARDIAN_MAX_CALL_TIMEOUT_MS + 1,
      "100" as unknown as number,
    ]) {
      expect(() => createTimeoutFetch({ timeoutMs })).toThrow(RangeError);
      expect(() =>
        withRequestTimeout(
          { baseUrl: "https://guardian.test", credential: "gak_test" },
          { timeoutMs },
        ),
      ).toThrow(RangeError);
    }
    expect(() =>
      createTimeoutFetch({ timeoutMs: GUARDIAN_MAX_CALL_TIMEOUT_MS }),
    ).not.toThrow();
    expect(GUARDIAN_DEFAULT_CALL_TIMEOUT_MS).toBe(15_000);
  });
});

describe("withRequestTimeout", () => {
  it("keeps the config and bounds its fetch", async () => {
    const calls: Call[] = [];
    const config = withRequestTimeout(
      {
        baseUrl: "https://guardian.test",
        credential: "gak_test",
        adapterId: "adp_00000006",
        fetch: transport(() => "hang", calls),
      },
      { timeoutMs: LIMIT },
    );
    expect(config).toMatchObject({
      baseUrl: "https://guardian.test",
      credential: "gak_test",
      adapterId: "adp_00000006",
    });
    await expect(config.fetch!("https://guardian.test/x")).rejects.toMatchObject(
      { name: "TimeoutError" },
    );
    expect(calls).toHaveLength(1);
  });

  it("bounds the global fetch when the config has none", async () => {
    const original = globalThis.fetch;
    const calls: Call[] = [];
    globalThis.fetch = transport(() => "hang", calls);
    try {
      const config = withRequestTimeout(
        { baseUrl: "https://guardian.test", credential: "gak_test" },
        { timeoutMs: LIMIT },
      );
      await expect(
        config.fetch!("https://guardian.test/x"),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("the client with a time limit", () => {
  it("answers request and claim SERVICE_UNAVAILABLE, never an allow", async () => {
    const client = boundedClient(() => "hang");
    const requested = await client.request(invocation);
    expect(requested).toMatchObject({
      ok: false,
      reasonCode: "SERVICE_UNAVAILABLE",
    });
    expect((requested as { requestId?: string }).requestId).toMatch(/^req_/);
    expect(await client.claim("req_0123456789abcdef")).toEqual({
      ok: false,
      reasonCode: "SERVICE_UNAVAILABLE",
      requestId: "req_0123456789abcdef",
    });
  });

  it("answers execute with an unknown outcome", async () => {
    const client = boundedClient(() => "hang");
    expect(
      await client.execute({
        requestId: "req_0123456789abcdef",
        capabilityToken: TOKEN,
      }),
    ).toEqual({
      ok: false,
      reasonCode: "SERVICE_UNAVAILABLE",
      outcomeUnknown: true,
    });
  });

  it("answers the read and withdraw calls as failures", async () => {
    const client = boundedClient(() => "hang");
    expect(await client.receipts("req_0123456789abcdef")).toMatchObject({
      ok: false,
    });
    expect(await client.portableReceipt("req_0123456789abcdef")).toMatchObject(
      { ok: false },
    );
    expect(await client.pending!()).toEqual({
      ok: false,
      reasonCode: "SERVICE_UNAVAILABLE",
    });
    expect(await client.withdraw!("req_0123456789abcdef")).toEqual({
      ok: false,
      reasonCode: "SERVICE_UNAVAILABLE",
      outcomeUnknown: true,
    });
  });

  it("fails closed when the limit passes while the answer is read", async () => {
    const calls: Call[] = [];
    const client = createGuardianClient(
      withRequestTimeout(
        {
          baseUrl: "https://guardian.test",
          credential: "gak_test",
          fetch: async (input, init) => {
            calls.push({
              path: new URL(String(input)).pathname,
              signal: init?.signal ?? undefined,
            });
            return stalledBody(init?.signal ?? undefined);
          },
        },
        { timeoutMs: LIMIT },
      ),
    );
    expect(await client.request(invocation)).toMatchObject({
      ok: false,
      reasonCode: "HTTP_200",
    });
    expect(
      await client.execute({
        requestId: "req_0123456789abcdef",
        capabilityToken: TOKEN,
      }),
    ).toEqual({ ok: false, reasonCode: "HTTP_200", outcomeUnknown: true });
    expect(calls.every((call) => call.signal!.aborted)).toBe(true);
  });

  it("ends every call once the caller's signal aborts", async () => {
    const controller = new AbortController();
    const client = boundedClient(() => "hang", {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    const pending = client.request(invocation);
    controller.abort();
    expect(await pending).toMatchObject({
      ok: false,
      reasonCode: "SERVICE_UNAVAILABLE",
    });
    expect(
      await client.execute({
        requestId: "req_0123456789abcdef",
        capabilityToken: TOKEN,
      }),
    ).toMatchObject({ ok: false, outcomeUnknown: true });
  });
});

describe("the guard with a time limit", () => {
  function guarded(
    client: GuardianClient,
    mode: "inProcess" | "remote",
    ran: unknown[],
  ) {
    return createGuard({ client, connectionId: CONNECTION, mode })(
      "send_email",
      async (input: { to: string }) => {
        ran.push(input);
        return { sent: input.to };
      },
    );
  }

  it("denies and runs nothing when the request is not answered", async () => {
    const ran: unknown[] = [];
    const calls: Call[] = [];
    const call = guarded(
      boundedClient(() => "hang", { calls }),
      "inProcess",
      ran,
    );
    const error = await call({ to: "a@example.test" }).catch((e) => e);
    expect(error).toBeInstanceOf(GuardianDenied);
    expect(error.reasonCode).toBe("SERVICE_UNAVAILABLE");
    expect(ran).toEqual([]);
    expect(calls.map((c) => c.path)).toEqual(["/v1/agent/requests"]);
  });

  it("denies and runs nothing when the caller's signal aborts first", async () => {
    const ran: unknown[] = [];
    const controller = new AbortController();
    const call = guarded(
      boundedClient(() => "hang", {
        signal: controller.signal,
        timeoutMs: 5_000,
      }),
      "inProcess",
      ran,
    );
    const pending = call({ to: "a@example.test" }).catch((e) => e);
    controller.abort();
    expect(await pending).toBeInstanceOf(GuardianDenied);
    expect(ran).toEqual([]);
  });

  it("looks the request up when the redemption is not answered (inProcess)", async () => {
    const ran: unknown[] = [];
    const calls: Call[] = [];
    const receipts: unknown[] = [];
    const client = boundedClient(
      (path, body) => {
        if (path === "/v1/agent/requests") return allow(body);
        if (path === "/v1/agent/execute") return "hang";
        return Response.json({
          ok: true,
          requestId: path.split("/").pop(),
          receipts: [{ state: "verified", attemptId: "att_found" }],
        });
      },
      { calls },
    );
    const call = createGuard({
      client,
      connectionId: CONNECTION,
      mode: "inProcess",
      onReceipt: (event) => void receipts.push(event.receipt),
    })("send_email", async (input: { to: string }) => {
      ran.push(input);
      return { sent: input.to };
    });
    expect(await call({ to: "a@example.test" })).toEqual({
      sent: "a@example.test",
    });
    expect(ran).toHaveLength(1);
    expect(calls.map((c) => c.path.replace(/req_[0-9a-f]+/, "req"))).toEqual([
      "/v1/agent/requests",
      "/v1/agent/execute",
      "/v1/agent/receipts/req",
    ]);
    // The lookup ran on a new time limit, not the one that had passed.
    expect(calls[1]!.signal!.aborted).toBe(true);
    expect(receipts).toEqual([
      expect.objectContaining({
        receiptReference: "att_found",
        status: "sent-verified",
      }),
    ]);
  });

  it("reports an unknown outcome when the lookup is not answered either (remote)", async () => {
    const ran: unknown[] = [];
    const calls: Call[] = [];
    const call = guarded(
      boundedClient(
        (path, body) => (path === "/v1/agent/requests" ? allow(body) : "hang"),
        { calls },
      ),
      "remote",
      ran,
    );
    const error = await call({ to: "a@example.test" }).catch((e) => e);
    expect(error).toBeInstanceOf(GuardianExecutionFailed);
    expect(error).toMatchObject({
      reasonCode: "EXECUTION_OUTCOME_UNKNOWN",
      outcomeUnknown: true,
      localEffectRan: false,
    });
    expect(ran).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("reports a definitive failure when the lookup says nothing was sent (remote)", async () => {
    const ran: unknown[] = [];
    const call = guarded(
      boundedClient((path, body) => {
        if (path === "/v1/agent/requests") return allow(body);
        if (path === "/v1/agent/execute") return "hang";
        return Response.json({
          ok: true,
          requestId: path.split("/").pop(),
          receipts: [{ state: "aborted" }],
        });
      }),
      "remote",
      ran,
    );
    const error = await call({ to: "a@example.test" }).catch((e) => e);
    expect(error).toBeInstanceOf(GuardianExecutionFailed);
    expect(error.reasonCode).toBe("EXECUTION_NOT_SENT");
    expect(error.outcomeUnknown).not.toBe(true);
    expect(ran).toEqual([]);
  });

  it("returns Guardian's receipt when a remote execute is answered in time", async () => {
    const ran: unknown[] = [];
    const call = guarded(
      boundedClient((path, body) =>
        path === "/v1/agent/requests" ? allow(body) : executed(body),
      ),
      "remote",
      ran,
    );
    expect(await call({ to: "a@example.test" })).toMatchObject({
      guardian: {
        decision: "ALLOW",
        receipt: { status: "sent-verified" },
      },
    });
    expect(ran).toEqual([]);
  });

  it("keeps a held request held when its claim is not answered", async () => {
    const ran: unknown[] = [];
    let claims = 0;
    const client = boundedClient((path, body) => {
      if (path === "/v1/agent/requests") {
        return Response.json({
          ok: true,
          requestId: (body as { requestId: string }).requestId,
          decision: "ASK",
        });
      }
      if (path === "/v1/agent/claims") {
        claims += 1;
        return claims === 1 ? "hang" : allow(body);
      }
      return executed(body);
    });
    const call = guarded(client, "inProcess", ran);
    const pending = await call({ to: "a@example.test" }).catch((e) => e);
    expect(pending).toBeInstanceOf(GuardianApprovalPending);

    // The retry claims the held request; the claim is not answered.
    const lost = await call({ to: "a@example.test" }).catch((e) => e);
    expect(lost).toBeInstanceOf(GuardianDenied);
    expect(lost).toMatchObject({
      reasonCode: "SERVICE_UNAVAILABLE",
      requestId: pending.requestId,
    });
    expect(ran).toEqual([]);

    // Still held: the next retry claims the same request and runs once.
    expect(await call({ to: "a@example.test" })).toEqual({
      sent: "a@example.test",
    });
    expect(claims).toBe(2);
    expect(ran).toHaveLength(1);
  });
});
