import { afterAll, describe, expect, it, vi } from "vitest";

import type { DecideOptions } from "../../hook/src/decide.js";
import plugin, {
  createGuardianToolHandler as createHandler,
  effectiveHookTimeoutMs,
  HOOK_PRIORITY,
  HOOK_TIMEOUT_MS,
  register,
  takeCredential,
} from "../src/index.js";
import { protectedInstall } from "./install-fixture.js";

/**
 * Every case below runs against a protected (read-only) install, so the
 * whole allow / ask / deny / fail-closed suite also proves that a protected
 * install leaves the normal flow unchanged.
 */
const INSTALL = protectedInstall();
afterAll(() => INSTALL.cleanup());
const createGuardianToolHandler: typeof createHandler = (options = {}) =>
  createHandler({ install: INSTALL.install, ...options });

/** Guardian as an OpenClaw before_tool_call plugin. */
type Client = DecideOptions["client"];
type Result = Awaited<ReturnType<Client["request"]>>;

const CONFIG = {
  connectionId: "pcn_everyday",
  askConnectionId: "pcn_ask",
};
const CREDENTIAL = "gac1.super-secret-credential";

function fakeGuardian(
  request: Result,
  claims: Result[] = [],
  executeOk = true,
) {
  const seen: { connectionId: string; toolName: string; purpose: string }[] =
    [];
  const executed: string[] = [];
  let claimAt = 0;
  const client: Client = {
    async request(invocation) {
      seen.push({
        connectionId: invocation.connectionId,
        toolName: "toolName" in invocation ? invocation.toolName : "",
        purpose: invocation.purpose ?? "",
      });
      return request;
    },
    async claim() {
      return claims[Math.min(claimAt++, claims.length - 1)]!;
    },
    async execute(input) {
      executed.push(input.requestId);
      return executeOk
        ? {
            ok: true,
            receipt: { receiptReference: "r", status: "succeeded" } as never,
          }
        : { ok: false, reasonCode: "CAPABILITY_REVOKED" };
    },
  };
  return { client, seen, executed };
}

/** A clock that advances only when the handler waits. */
function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    wait: async (ms: number) => {
      t += ms;
    },
  };
}

const pending = (id: string): Result => ({
  ok: false,
  reasonCode: "APPROVAL_REQUIRED",
  requestId: id,
});
const allowed = (id: string): Result => ({
  ok: true,
  requestId: id,
  decision: "ALLOW",
  capabilityToken: "cap",
});

const exec = (command: string) => ({
  toolName: "exec",
  params: { command },
  toolCallId: "tc1",
});

describe("guardian before_tool_call handler", () => {
  it("ALLOW: redeems the capability, then lets the call run with the params Guardian saw", async () => {
    const g = fakeGuardian(allowed("req_1"));
    const handler = createGuardianToolHandler({
      config: CONFIG,
      client: g.client,
      ...fakeClock(),
    });
    const out = await handler(exec("npm test"), { agentId: "main" });
    expect(out).toEqual({ params: { command: "npm test" } });
    expect(g.executed).toEqual(["req_1"]);
    expect(g.seen).toEqual([
      {
        connectionId: "pcn_everyday",
        toolName: "shell",
        purpose: "OpenClaw (main): Run: npm test",
      },
    ]);
  });

  it("ASK then approve: a deploy goes to the Ask connection and runs only after a person approves", async () => {
    const g = fakeGuardian(pending("req_2"), [
      pending("req_2"),
      allowed("req_2"),
    ]);
    const info = vi.fn();
    const handler = createGuardianToolHandler({
      config: CONFIG,
      client: g.client,
      logger: { info },
      ...fakeClock(),
    });
    const out = await handler(exec("terraform apply -auto-approve"));
    expect(out).toEqual({
      params: { command: "terraform apply -auto-approve" },
    });
    expect(g.seen[0]).toMatchObject({
      connectionId: "pcn_ask",
      toolName: "shell_deploy",
    });
    expect(g.executed).toEqual(["req_2"]);
    expect(info.mock.calls.flat().join("\n")).toMatch(/held for approval/);
  });

  it("ASK then expire: nobody approves in time, so the call is blocked and nothing is redeemed", async () => {
    const g = fakeGuardian(pending("req_3"), [pending("req_3")]);
    const handler = createGuardianToolHandler({
      config: CONFIG,
      client: g.client,
      ...fakeClock(),
    });
    const out = await handler(exec("rm -rf build"));
    expect(out).toMatchObject({
      block: true,
      blockReason: expect.stringMatching(/still waiting for a human/),
    });
    expect(g.executed).toEqual([]);
  });

  it("ASK then decline: blocked", async () => {
    const g = fakeGuardian(pending("req_4"), [
      { ok: false, reasonCode: "APPROVAL_DENIED", requestId: "req_4" },
    ]);
    const handler = createGuardianToolHandler({
      config: CONFIG,
      client: g.client,
      ...fakeClock(),
    });
    expect(
      await handler({ toolName: "message", params: { action: "send" } }),
    ).toMatchObject({
      block: true,
      blockReason: expect.stringMatching(/approver declined/),
    });
    expect(g.seen[0]?.connectionId).toBe("pcn_ask");
    expect(g.executed).toEqual([]);
  });

  it("DENY: blocked with Guardian's reason; nothing is redeemed", async () => {
    const g = fakeGuardian({
      ok: true,
      requestId: "req_5",
      decision: "DENY",
      reasonCode: "NOT_AUTHORIZED",
    });
    const handler = createGuardianToolHandler({
      config: CONFIG,
      client: g.client,
      ...fakeClock(),
    });
    expect(
      await handler({
        toolName: "composio__GMAIL_SEND_EMAIL",
        params: { to: "x@y.z" },
      }),
    ).toMatchObject({
      block: true,
      blockReason: expect.stringMatching(/NOT_AUTHORIZED/),
    });
    expect(g.seen[0]).toMatchObject({
      toolName: "mcp.composio.gmail_send_email",
      connectionId: "pcn_ask",
    });
    expect(g.executed).toEqual([]);
  });

  it("a failed redemption blocks the call", async () => {
    const g = fakeGuardian(allowed("req_6"), [], false);
    const handler = createGuardianToolHandler({
      config: CONFIG,
      client: g.client,
      ...fakeClock(),
    });
    expect(await handler(exec("ls"))).toMatchObject({ block: true });
  });

  it("read-only tools get no opinion and never reach Guardian", async () => {
    const g = fakeGuardian(allowed("req_7"));
    const handler = createGuardianToolHandler({
      config: CONFIG,
      client: g.client,
    });
    expect(
      await handler({ toolName: "read", params: { path: "a.ts" } }),
    ).toBeUndefined();
    expect(
      await handler({ toolName: "web_search", params: { query: "x" } }),
    ).toBeUndefined();
    expect(g.seen).toEqual([]);
  });

  it("returns a snapshot: params changed after the decision do not run", async () => {
    const g = fakeGuardian(allowed("req_8"));
    const handler = createGuardianToolHandler({
      config: CONFIG,
      client: g.client,
    });
    const event = exec("echo hi");
    const promise = handler(event);
    (event.params as { command: string }).command = "rm -rf /";
    expect(await promise).toEqual({ params: { command: "echo hi" } });
  });

  it("allowTierTools routes a named tool to the everyday connection", async () => {
    const g = fakeGuardian(allowed("req_9"));
    const handler = createGuardianToolHandler({
      config: { ...CONFIG, allowTierTools: ["openclaw.browser"] },
      client: g.client,
    });
    await handler({ toolName: "browser", params: { action: "snapshot" } });
    expect(g.seen[0]?.connectionId).toBe("pcn_everyday");
  });
});

describe("fail closed", () => {
  it("no configuration: every governed call is blocked, Guardian is never called", async () => {
    const fetch = vi.fn();
    const warn = vi.fn();
    const handler = createGuardianToolHandler({
      env: {},
      fetch: fetch as never,
      logger: { warn },
    });
    expect(await handler(exec("ls"))).toMatchObject({
      block: true,
      blockReason: expect.stringMatching(/GUARDIAN_AGENT_CREDENTIAL/),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    // Read-only tools are still left alone.
    expect(await handler({ toolName: "read", params: {} })).toBeUndefined();
  });

  it("a non-https base URL is refused", async () => {
    const handler = createGuardianToolHandler({
      config: { ...CONFIG, baseUrl: "http://guardian.local" },
      env: { GUARDIAN_AGENT_CREDENTIAL: CREDENTIAL },
    });
    expect(await handler(exec("ls"))).toMatchObject({
      block: true,
      blockReason: expect.stringMatching(/https/),
    });
  });

  it("Guardian unreachable: blocked, and the credential is never in the reason", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError(`connect ECONNREFUSED (${CREDENTIAL})`);
    });
    const info = vi.fn();
    const warn = vi.fn();
    const handler = createGuardianToolHandler({
      config: CONFIG,
      env: { GUARDIAN_AGENT_CREDENTIAL: CREDENTIAL },
      fetch: fetch as never,
      logger: { info, warn },
    });
    const out = await handler(exec("ls"));
    expect(out).toMatchObject({
      block: true,
      blockReason: expect.stringMatching(/could not be reached/),
    });
    expect(fetch).toHaveBeenCalledOnce();
    const everything = JSON.stringify([out, info.mock.calls, warn.mock.calls]);
    expect(everything).not.toContain(CREDENTIAL);
  });

  it("the real client sends the credential only to Guardian, over a bounded fetch", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response(
        JSON.stringify({
          ok: true,
          requestId: "req_r",
          decision: "DENY",
          reasonCode: "NOT_AUTHORIZED",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const handler = createGuardianToolHandler({
      config: { ...CONFIG, baseUrl: "https://guardian.example" },
      env: { GUARDIAN_AGENT_CREDENTIAL: CREDENTIAL },
      fetch: fetch as never,
    });
    const out = await handler(exec("ls"));
    expect(out).toMatchObject({ block: true });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/guardian\.example\//);
    expect(JSON.stringify(init.headers)).toContain(CREDENTIAL);
    expect(String(init.body)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(out)).not.toContain(CREDENTIAL);
  });

  it("a crashing client blocks the call", async () => {
    const client: Client = {
      request: async () => {
        throw new Error("boom");
      },
      claim: async () => {
        throw new Error("boom");
      },
      execute: async () => {
        throw new Error("boom");
      },
    };
    const handler = createGuardianToolHandler({ config: CONFIG, client });
    expect(await handler(exec("ls"))).toMatchObject({ block: true });
  });

  it("a malformed event blocks instead of throwing", async () => {
    const g = fakeGuardian(allowed("x"));
    const handler = createGuardianToolHandler({
      config: CONFIG,
      client: g.client,
    });
    expect(await handler({} as never)).toMatchObject({ block: true });
    expect(
      await handler({ toolName: "exec", params: { command: 1n } } as never),
    ).toMatchObject({ block: true });
    expect(g.executed).toEqual([]);
  });

  it("a cancelled tool call stops waiting and redeems nothing", async () => {
    const g = fakeGuardian(pending("req_a"), [
      pending("req_a"),
      allowed("req_a"),
    ]);
    const controller = new AbortController();
    const clock = fakeClock();
    const handler = createGuardianToolHandler({
      config: CONFIG,
      client: g.client,
      now: clock.now,
      wait: async (ms) => {
        controller.abort();
        await clock.wait(ms);
      },
    });
    expect(
      await handler(exec("terraform destroy"), {
        abortSignal: controller.signal,
      }),
    ).toMatchObject({ block: true });
    expect(g.executed).toEqual([]);
  });

  it("never waits or redeems past OpenClaw's hook timeout", async () => {
    // The operator left before_tool_call at 30 s: the ASK window shrinks to
    // fit, and an approval that lands after it is not redeemed.
    const g = fakeGuardian(pending("req_b"), [
      pending("req_b"),
      pending("req_b"),
      pending("req_b"),
      allowed("req_b"),
    ]);
    const clock = fakeClock();
    const start = clock.now();
    const handler = createGuardianToolHandler({
      config: CONFIG,
      client: g.client,
      hookTimeoutMs: 30_000,
      ...clock,
    });
    expect(await handler(exec("git push --force"))).toMatchObject({
      block: true,
    });
    expect(clock.now() - start).toBeLessThan(30_000 - 5_000);
    expect(g.executed).toEqual([]);
  });
});

describe("late approvals", () => {
  it("an approval that arrives after OpenClaw stopped waiting is never redeemed", async () => {
    // A slow claim: it returns ALLOW, but only after the hook budget is spent.
    const clock = fakeClock();
    const g = fakeGuardian(pending("req_late"));
    g.client.claim = async () => {
      await clock.wait(60_000);
      return allowed("req_late");
    };
    const handler = createGuardianToolHandler({
      config: CONFIG,
      client: g.client,
      hookTimeoutMs: 30_000,
      ...clock,
    });
    expect(await handler(exec("terraform apply"))).toMatchObject({
      block: true,
    });
    expect(g.executed).toEqual([]);
  });

  it("an approval redeemed after the deadline is still blocked (final deadline check)", async () => {
    // The redemption itself is slow: Guardian answers, but OpenClaw has
    // already stopped waiting, so the handler must not return params.
    const clock = fakeClock();
    const g = fakeGuardian(allowed("req_slow"));
    const execute = g.client.execute;
    g.client.execute = async (input) => {
      const out = await execute(input);
      await clock.wait(60_000);
      return out;
    };
    const handler = createGuardianToolHandler({
      config: CONFIG,
      client: g.client,
      hookTimeoutMs: 30_000,
      ...clock,
    });
    expect(await handler(exec("npm test"))).toMatchObject({ block: true });
  });
});

describe("security review cases", () => {
  it("send-keys with only a literal payload goes to the Ask connection and does not run unapproved", async () => {
    const g = fakeGuardian(pending("req_k"), [pending("req_k")]);
    const handler = createGuardianToolHandler({
      config: CONFIG,
      client: g.client,
      hookTimeoutMs: 30_000,
      ...fakeClock(),
    });
    const out = await handler({
      toolName: "process",
      params: {
        action: "send-keys",
        sessionId: "s1",
        literal: "git push --force origin main\r",
      },
    });
    expect(out).toMatchObject({ block: true });
    expect(g.seen[0]).toMatchObject({
      connectionId: "pcn_ask",
      toolName: "shell_destructive",
    });
    expect(g.seen[0]!.purpose).toContain("git push --force origin main");
    expect(g.executed).toEqual([]);
  });

  it("a decoy field is refused before Guardian is asked", async () => {
    const g = fakeGuardian(allowed("req_d"));
    const handler = createGuardianToolHandler({
      config: CONFIG,
      client: g.client,
      ...fakeClock(),
    });
    const out = await handler({
      toolName: "process",
      params: {
        action: "write",
        sessionId: "s1",
        text: "ls",
        data: "vercel deploy --prod\n",
      },
    });
    expect(out).toMatchObject({ block: true });
    expect(g.seen).toEqual([]);
  });

  it("disabling Guardian through exec or a config write needs a person", async () => {
    for (const event of [
      exec("openclaw plugins disable guardian"),
      {
        toolName: "write",
        params: { path: "/data/.openclaw/openclaw.json", content: "{}" },
      },
      {
        toolName: "edit",
        params: {
          path: "/srv/state/settings.json5",
          oldText: "a",
          newText: "b",
        },
      },
    ]) {
      const g = fakeGuardian(pending("req_c"), [pending("req_c")]);
      const handler = createGuardianToolHandler({
        config: CONFIG,
        env: { OPENCLAW_STATE_DIR: "/srv/state" },
        client: g.client,
        hookTimeoutMs: 30_000,
        ...fakeClock(),
      });
      expect(await handler(event)).toMatchObject({ block: true });
      expect(g.seen[0]).toMatchObject({
        connectionId: "pcn_ask",
        toolName: "shell_destructive",
      });
      expect(g.executed).toEqual([]);
    }
  });

  it("passes OpenClaw's toolKind through: Code Mode exec is governed as openclaw.code_mode_exec", async () => {
    const g = fakeGuardian(allowed("req_cm"));
    const handler = createGuardianToolHandler({
      config: { ...CONFIG, allowTierTools: ["openclaw.code_mode_exec"] },
      client: g.client,
      ...fakeClock(),
    });
    const params = { code: "return 1", command: "return 1" };
    expect(
      await handler({ toolName: "exec", toolKind: "code_mode_exec", params }),
    ).toEqual({ params });
    expect(g.seen[0]).toMatchObject({
      connectionId: "pcn_everyday",
      toolName: "openclaw.code_mode_exec",
    });
  });
});

describe("plugin registration", () => {
  it("takeCredential removes the credential from the environment exec children inherit", () => {
    const env: Record<string, string | undefined> = {
      GUARDIAN_AGENT_CREDENTIAL: ` ${CREDENTIAL} `,
      PATH: "/bin",
    };
    const slot: Record<symbol, unknown> = {};
    expect(takeCredential(env, slot)).toBe(CREDENTIAL);
    expect(env).toEqual({ PATH: "/bin" });
    // A reload finds it again without the environment variable.
    expect(takeCredential(env, slot)).toBe(CREDENTIAL);
    expect(takeCredential({}, {})).toBeUndefined();
  });

  it("honours OpenClaw's timeout precedence", () => {
    expect(effectiveHookTimeoutMs(undefined)).toBe(HOOK_TIMEOUT_MS);
    const cfg = (hooks: object) => ({
      plugins: { entries: { guardian: { hooks } } },
    });
    expect(effectiveHookTimeoutMs(cfg({ timeoutMs: 20_000 }))).toBe(20_000);
    expect(
      effectiveHookTimeoutMs(
        cfg({ timeoutMs: 20_000, timeouts: { before_tool_call: 330_000 } }),
      ),
    ).toBe(330_000);
    expect(
      effectiveHookTimeoutMs(cfg({ timeouts: { before_tool_call: 9e9 } })),
    ).toBe(600_000);
  });

  it("registers one before_tool_call hook with no matcher, last priority and the long budget", () => {
    const on = vi.fn();
    const saved = process.env.GUARDIAN_AGENT_CREDENTIAL;
    process.env.GUARDIAN_AGENT_CREDENTIAL = CREDENTIAL;
    try {
      register({
        id: "guardian",
        config: {},
        pluginConfig: CONFIG,
        logger: {},
        on,
      });
      expect(process.env.GUARDIAN_AGENT_CREDENTIAL).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.GUARDIAN_AGENT_CREDENTIAL;
      else process.env.GUARDIAN_AGENT_CREDENTIAL = saved;
    }
    expect(on).toHaveBeenCalledOnce();
    const [hookName, handler, opts] = on.mock.calls[0]!;
    expect(hookName).toBe("before_tool_call");
    expect(typeof handler).toBe("function");
    expect(opts).toEqual({
      priority: HOOK_PRIORITY,
      timeoutMs: HOOK_TIMEOUT_MS,
    });
    expect(opts).not.toHaveProperty("matcher");
  });

  it("exports a definition whose id matches openclaw.plugin.json", async () => {
    const manifest = (await import("../openclaw.plugin.json", {
      with: { type: "json" },
    })) as { default: { id: string } };
    expect(plugin.id).toBe(manifest.default.id);
    expect(plugin.register).toBe(register);
  });
});
