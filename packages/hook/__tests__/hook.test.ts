import { describe, expect, it } from "vitest";

import {
  classifyCommand,
  governedCall,
  HOOK_TOOLS,
  mcpToolName,
} from "../src/classify.js";
import {
  decide,
  FINAL_CHECK_LEAD_MS,
  type DecideOptions,
} from "../src/decide.js";
import {
  MAX_WAIT_MS,
  REQUEST_TTL_MS,
  runHook,
  SETTINGS_SNIPPET,
  setupText,
} from "../src/index.js";

type Client = DecideOptions["client"];
type Result = Awaited<ReturnType<Client["request"]>>;

function fakeClient(script: {
  request: Result | (() => never);
  claims?: Result[];
  execute?: Awaited<ReturnType<Client["execute"]>>;
}) {
  const calls: string[] = [];
  let claimAt = 0;
  const client: Client = {
    async request(invocation) {
      calls.push(
        `request ${"toolName" in invocation ? invocation.toolName : ""}`,
      );
      if (typeof script.request === "function") script.request();
      return script.request as Result;
    },
    async claim(requestId) {
      calls.push(`claim ${requestId}`);
      const claims = script.claims ?? [];
      return claims[Math.min(claimAt++, claims.length - 1)]!;
    },
    async execute({ requestId }) {
      calls.push(`execute ${requestId}`);
      return (
        script.execute ?? {
          ok: true,
          receipt: { receiptReference: "r", status: "succeeded" } as never,
        }
      );
    },
  };
  return { client, calls };
}

const base = (
  client: Client,
  extra: Partial<DecideOptions> = {},
): DecideOptions => ({
  client,
  connectionId: "con_hook",
  agentName: "Claude Code",
  approvalTimeoutMs: 10_000,
  pollIntervalMs: 1,
  wait: async () => {},
  ...extra,
});

const terraform = governedCall({
  tool: "Bash",
  input: { command: "terraform apply -auto-approve" },
})!;

describe("classify", () => {
  it.each([
    ["npm test", "shell"],
    ["ls -la && cat README.md", "shell"],
    ["terraform apply -auto-approve", "shell_deploy"],
    ["cd infra && terraform -chdir=prod destroy", "shell_deploy"],
    ["kubectl -n prod apply -f deploy.yaml", "shell_deploy"],
    ["helm upgrade api ./chart", "shell_deploy"],
    ["npm publish", "shell_deploy"],
    ["gh pr merge 12 --squash", "shell_deploy"],
    ["rm -rf build", "shell_destructive"],
    ["rm -fr /tmp/x", "shell_destructive"],
    ["git reset --hard HEAD~3", "shell_destructive"],
    ["git push --force origin main", "shell_destructive"],
    ["psql -c 'DROP TABLE users'", "shell_destructive"],
    ["git push origin feature", "git_push"],
    ["rm notes.txt", "shell"],
  ])("%s → %s", (command, expected) => {
    expect(classifyCommand(command)).toBe(expected);
  });

  it("produces Guardian-valid tool names, including for MCP tools", () => {
    const valid = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
    for (const t of HOOK_TOOLS) expect(t.name).toMatch(valid);
    for (const name of [
      mcpToolName("github", "create_pull_request"),
      mcpToolName("My-Server!!", "Do.Thing"),
      mcpToolName("9lives", "x".repeat(100)),
    ]) {
      expect(name).toMatch(valid);
      expect(name.length).toBeLessThanOrEqual(64);
    }
  });

  it("digests file contents instead of sending them; skips read-only tools", () => {
    const call = governedCall({
      tool: "Write",
      input: { file_path: "/repo/.env", content: "SECRET=abc" },
    })!;
    expect(call.toolName).toBe("file_write");
    expect(JSON.stringify(call.arguments)).not.toContain("SECRET=abc");
    expect(call.arguments.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const tool of ["Read", "Grep", "Glob", "LS", "WebSearch"]) {
      expect(governedCall({ tool, input: {} })).toBeNull();
    }
  });

  it("bounds long commands", () => {
    const call = governedCall({
      tool: "Bash",
      input: { command: `echo ${"a".repeat(5000)}` },
    })!;
    expect(String(call.arguments.command).length).toBeLessThan(2_100);
  });
});

describe("decide", () => {
  it("ALLOW: redeems the capability before the agent runs the call", async () => {
    const { client, calls } = fakeClient({
      request: {
        ok: true,
        requestId: "req_1",
        decision: "ALLOW",
        capabilityToken: "cap",
      },
    });
    const verdict = await decide(
      governedCall({ tool: "Bash", input: { command: "npm test" } })!,
      base(client),
    );
    expect(verdict).toMatchObject({
      decision: "allow",
      requestId: "req_1",
      approvedByHuman: false,
    });
    expect(calls).toEqual(["request shell", "execute req_1"]);
  });

  it("ASK: waits for the human, then claims and redeems", async () => {
    const lines: string[] = [];
    const { client, calls } = fakeClient({
      request: {
        ok: false,
        reasonCode: "APPROVAL_REQUIRED",
        requestId: "req_2",
      },
      claims: [
        { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId: "req_2" },
        {
          ok: true,
          requestId: "req_2",
          decision: "ALLOW",
          capabilityToken: "cap",
        },
      ],
    });
    const verdict = await decide(
      terraform,
      base(client, { log: (l) => lines.push(l) }),
    );
    expect(verdict).toMatchObject({
      decision: "allow",
      approvedByHuman: true,
      guardianDecision: "ASK",
    });
    expect(calls).toEqual([
      "request shell_deploy",
      "claim req_2",
      "claim req_2",
      "execute req_2",
    ]);
    expect(lines[0]).toMatch(/held for approval/);
  });

  it("ASK then declined: denied, nothing redeemed", async () => {
    const { client, calls } = fakeClient({
      request: {
        ok: false,
        reasonCode: "APPROVAL_REQUIRED",
        requestId: "req_3",
      },
      claims: [{ ok: false, reasonCode: "NOT_AUTHORIZED", requestId: "req_3" }],
    });
    const verdict = await decide(terraform, base(client));
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toMatch(/NOT_AUTHORIZED/);
    expect(calls.some((c) => c.startsWith("execute"))).toBe(false);
  });

  it("ASK timeout: denied, never auto-approved", async () => {
    let t = 0;
    const { client, calls } = fakeClient({
      request: { ok: true, requestId: "req_4", decision: "ASK" },
      claims: [
        { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId: "req_4" },
      ],
    });
    const verdict = await decide(
      terraform,
      base(client, { now: () => (t += 4_000) }),
    );
    expect(verdict).toMatchObject({
      decision: "deny",
      guardianDecision: "ASK",
    });
    expect(verdict.reason).toMatch(/still waiting/);
    expect(calls.some((c) => c.startsWith("execute"))).toBe(false);
  });

  it("DENY, unreachable Guardian and failed redemption all fail closed", async () => {
    const deny = fakeClient({
      request: {
        ok: true,
        requestId: "r",
        decision: "DENY",
        reasonCode: "POLICY",
      },
    });
    expect((await decide(terraform, base(deny.client))).decision).toBe("deny");
    const down = fakeClient({
      request: () => {
        throw new Error("network");
      },
    });
    expect((await decide(terraform, base(down.client))).reason).toMatch(
      /could not be reached/,
    );
    const revoked = fakeClient({
      request: {
        ok: true,
        requestId: "r",
        decision: "ALLOW",
        capabilityToken: "cap",
      },
      execute: { ok: false, reasonCode: "CAPABILITY_REVOKED" },
    });
    expect((await decide(terraform, base(revoked.client))).decision).toBe(
      "deny",
    );
  });
});

describe("decide: request ids and lost redemption answers", () => {
  const allowed: Result = {
    ok: true,
    requestId: "req_9",
    decision: "ALLOW",
    capabilityToken: "cap",
  };
  type Receipts = NonNullable<Client["receipts"]>;
  const withReceipts = (
    client: Client,
    calls: string[],
    answer: Awaited<ReturnType<Receipts>> | (() => never),
  ): Client => ({
    ...client,
    async receipts(requestId) {
      calls.push(`receipts ${requestId}`);
      if (typeof answer === "function") answer();
      return answer as Awaited<ReturnType<Receipts>>;
    },
  });

  it("a refusal tells the agent the request id", async () => {
    const { client } = fakeClient({
      request: { ok: false, reasonCode: "NOT_AUTHORIZED", requestId: "req_7" },
    });
    const verdict = await decide(terraform, base(client));
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toMatch(
      /^Guardian blocked shell_deploy \(NOT_AUTHORIZED\): .*\. Request req_7\. Do not retry/,
    );
  });

  it("an approval that was declined tells the agent the request id", async () => {
    const { client } = fakeClient({
      request: {
        ok: false,
        reasonCode: "APPROVAL_REQUIRED",
        requestId: "req_8",
      },
      claims: [{ ok: false, reasonCode: "NOT_AUTHORIZED", requestId: "req_8" }],
    });
    const verdict = await decide(terraform, base(client));
    expect(verdict.reason).toMatch(/\(NOT_AUTHORIZED\).*Request req_8\./);
  });

  it("an unreachable Guardian names no request (Guardian never saw one)", async () => {
    const { client } = fakeClient({
      request: {
        ok: false,
        reasonCode: "SERVICE_UNAVAILABLE",
        requestId: "req_local",
      },
    });
    const verdict = await decide(terraform, base(client));
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toMatch(
      /\(SERVICE_UNAVAILABLE\): Guardian could not be reached/,
    );
    expect(verdict.reason).not.toMatch(/req_local/);
  });

  it("a lost redemption answer is settled by lookup: verified → the call runs", async () => {
    const fake = fakeClient({
      request: allowed,
      execute: {
        ok: false,
        reasonCode: "SERVICE_UNAVAILABLE",
        outcomeUnknown: true,
      },
    });
    const client = withReceipts(fake.client, fake.calls, {
      ok: true,
      requestId: "req_9",
      receipts: [{ state: "verified", attemptId: "att_1" }],
    });
    const verdict = await decide(terraform, base(client));
    expect(verdict).toMatchObject({ decision: "allow", requestId: "req_9" });
    expect(verdict.reason).toMatch(/request req_9/);
    expect(fake.calls).toEqual([
      "request shell_deploy",
      "execute req_9",
      "receipts req_9",
    ]);
  });

  it("a thrown execute is looked up too", async () => {
    const fake = fakeClient({ request: allowed });
    const client = withReceipts(
      {
        ...fake.client,
        async execute() {
          throw new Error("socket hang up");
        },
      },
      fake.calls,
      { ok: true, requestId: "req_9", receipts: [{ state: "verified" }] },
    );
    expect((await decide(terraform, base(client))).decision).toBe("allow");
  });

  it("a lost answer for a redemption Guardian aborted is a deny", async () => {
    const fake = fakeClient({
      request: allowed,
      execute: { ok: false, reasonCode: "HTTP_502", outcomeUnknown: true },
    });
    const client = withReceipts(fake.client, fake.calls, {
      ok: true,
      requestId: "req_9",
      receipts: [{ state: "aborted" }],
    });
    const verdict = await decide(terraform, base(client));
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toMatch(/\(EXECUTION_NOT_SENT\).*Request req_9\./);
  });

  it.each([
    ["the lookup fails", { ok: false, reasonCode: "SERVICE_UNAVAILABLE" }],
    ["nothing is recorded yet", { ok: true, requestId: "req_9", receipts: [] }],
    [
      "the attempt is still committing",
      { ok: true, requestId: "req_9", receipts: [{ state: "committing" }] },
    ],
  ] as const)(
    "an unsettled lost answer is a deny that says nothing ran and not to retry (%s)",
    async (_name, answer) => {
      const fake = fakeClient({
        request: allowed,
        execute: {
          ok: false,
          reasonCode: "SERVICE_UNAVAILABLE",
          outcomeUnknown: true,
        },
      });
      const client = withReceipts(fake.client, fake.calls, answer as never);
      const verdict = await decide(terraform, base(client));
      expect(verdict.decision).toBe("deny");
      expect(verdict.requestId).toBe("req_9");
      expect(verdict.reason).toMatch(
        /^Guardian blocked shell_deploy \(EXECUTION_OUTCOME_UNKNOWN\)/,
      );
      expect(verdict.reason).toMatch(
        /Request req_9\. Nothing ran\. Do not retry/,
      );
      expect(verdict.reason).not.toMatch(/could not be reached/);
    },
  );

  it("a lookup that throws, or no lookup at all, is a deny", async () => {
    const fake = fakeClient({
      request: allowed,
      execute: {
        ok: false,
        reasonCode: "SERVICE_UNAVAILABLE",
        outcomeUnknown: true,
      },
    });
    const throwing = withReceipts(fake.client, fake.calls, () => {
      throw new Error("down");
    });
    expect((await decide(terraform, base(throwing))).reason).toMatch(
      /EXECUTION_OUTCOME_UNKNOWN/,
    );
    expect((await decide(terraform, base(fake.client))).reason).toMatch(
      /EXECUTION_OUTCOME_UNKNOWN/,
    );
  });

  it("a definitive refusal of the redemption is not looked up", async () => {
    const fake = fakeClient({
      request: allowed,
      execute: { ok: false, reasonCode: "CAPABILITY_REVOKED" },
    });
    const client = withReceipts(fake.client, fake.calls, {
      ok: true,
      requestId: "req_9",
      receipts: [{ state: "verified" }],
    });
    const verdict = await decide(terraform, base(client));
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toMatch(/\(CAPABILITY_REVOKED\).*Request req_9\./);
    expect(fake.calls.some((c) => c.startsWith("receipts"))).toBe(false);
  });
});

describe("Claude Code hook I/O", () => {
  const stdin = (tool_name: string, tool_input: object) =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name,
      tool_input,
      cwd: "/repo",
      tool_use_id: "t1",
    });

  it("prints a PreToolUse decision", async () => {
    const { client } = fakeClient({
      request: {
        ok: true,
        requestId: "req_9",
        decision: "ALLOW",
        capabilityToken: "cap",
      },
    });
    const out = JSON.parse(
      await runHook(stdin("Bash", { command: "npm test" }), {}, { client }),
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: expect.stringContaining("req_9"),
      },
    });
  });

  it("has no opinion on read-only tools", async () => {
    expect(await runHook(stdin("Read", { file_path: "/repo/a" }), {})).toBe("");
  });

  it("fails closed on bad input or missing config", async () => {
    for (const out of [
      await runHook("not json", {}),
      await runHook(stdin("Bash", { command: "ls" }), {}),
      await runHook(stdin("Bash", { command: "ls" }), {
        GUARDIAN_AGENT_CREDENTIAL: "c",
        GUARDIAN_CONNECTION_ID: "x",
        GUARDIAN_BASE_URL: "http://insecure",
      }),
    ]) {
      expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe(
        "deny",
      );
    }
  });

  it("setup snippet keeps the hook under Claude Code's 600 s timeout", () => {
    expect(SETTINGS_SNIPPET.hooks.PreToolUse[0]!.hooks[0]!.timeout).toBe(600);
    expect(setupText()).toContain("shell_deploy");
  });
});

describe("two connections (Guardian modes are per connection)", () => {
  const env = {
    GUARDIAN_CONNECTION_ID: "con_everyday",
    GUARDIAN_HOOK_ASK_CONNECTION_ID: "con_approval",
  };

  it("sends Allow-tier tools and Ask-tier tools to different connections", async () => {
    const { connectionFor } = await import("../src/index.js");
    expect(connectionFor("shell", env)).toBe("con_everyday");
    expect(connectionFor("file_write", env)).toBe("con_everyday");
    expect(connectionFor("shell_deploy", env)).toBe("con_approval");
    expect(connectionFor("shell_destructive", env)).toBe("con_approval");
    expect(connectionFor("git_push", env)).toBe("con_approval");
    expect(connectionFor("mcp.github.create_pull_request", env)).toBe(
      "con_approval",
    );
    // One connection only: everything shares it (and its single mode).
    expect(
      connectionFor("shell_deploy", { GUARDIAN_CONNECTION_ID: "con_one" }),
    ).toBe("con_one");
  });

  it("an ls before terraform apply does not wait for approval", async () => {
    const seen: string[] = [];
    const client: Client = {
      async request(invocation) {
        seen.push(invocation.connectionId);
        return invocation.connectionId === "con_everyday"
          ? {
              ok: true,
              requestId: "r1",
              decision: "ALLOW",
              capabilityToken: "c",
            }
          : { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId: "r2" };
      },
      async claim() {
        return {
          ok: true,
          requestId: "r2",
          decision: "ALLOW",
          capabilityToken: "c",
        };
      },
      async execute() {
        return { ok: true, receipt: {} as never };
      },
    };
    const run = (command: string) =>
      runHook(
        JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        env,
        { client, wait: async () => {} },
      );
    const ls = JSON.parse(await run("ls -la"));
    expect(ls.hookSpecificOutput.permissionDecisionReason).toMatch(
      /Allowed by Guardian policy/,
    );
    const apply = JSON.parse(await run("terraform apply"));
    expect(apply.hookSpecificOutput.permissionDecisionReason).toMatch(
      /Approved by a human/,
    );
    expect(seen).toEqual(["con_everyday", "con_approval"]);
  });
});

describe("setup completeness", () => {
  it("setup tells the human to allow each tool for the agent", () => {
    expect(setupText()).toMatch(/Allow a tool by name/);
  });

  it("an INVALID_REQUEST denial says how to fix it", async () => {
    const { client } = fakeClient({
      request: { ok: false, reasonCode: "INVALID_REQUEST" },
    });
    const verdict = await decide(terraform, base(client));
    expect(verdict.reason).toMatch(/Allow a tool by name/);
  });
});

describe("approval polling backoff", () => {
  it("backs off from 2 s to 10 s so a long wait does not flood the evidence chain", async () => {
    const waits: number[] = [];
    const claims: Result[] = Array.from({ length: 12 }, () => ({
      ok: false as const,
      reasonCode: "APPROVAL_REQUIRED",
      requestId: "req_b",
    }));
    claims.push({
      ok: true,
      requestId: "req_b",
      decision: "ALLOW",
      capabilityToken: "cap",
    });
    const { client } = fakeClient({
      request: {
        ok: false,
        reasonCode: "APPROVAL_REQUIRED",
        requestId: "req_b",
      },
      claims,
    });
    const verdict = await decide(
      terraform,
      base(client, {
        pollIntervalMs: 2_000,
        approvalTimeoutMs: 600_000,
        wait: async (ms) => {
          waits.push(ms);
        },
      }),
    );
    expect(verdict.decision).toBe("allow");
    expect(waits.slice(0, 5)).toEqual([2_000, 3_000, 4_500, 6_750, 10_000]);
    expect(Math.max(...waits)).toBe(10_000);
    // A one-minute wait now takes ~9 checks instead of ~30.
    let elapsed = 0;
    let checks = 0;
    for (const ms of waits) {
      if (elapsed >= 60_000) break;
      elapsed += ms;
      checks += 1;
    }
    expect(checks).toBeLessThanOrEqual(9);
  });
});

describe("request window", () => {
  it("asks Guardian to keep the request open 5 minutes and never waits longer", async () => {
    const seen: unknown[] = [];
    const client: Client = {
      async request(invocation) {
        seen.push((invocation as { ttlMs?: number }).ttlMs);
        return {
          ok: true,
          requestId: "req_t",
          decision: "ALLOW",
          capabilityToken: "cap",
        };
      },
      async claim() {
        throw new Error("not used");
      },
      async execute() {
        return {
          ok: true,
          receipt: { receiptReference: "r", status: "succeeded" } as never,
        } as never;
      },
    };
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    await runHook(input, {}, { client });
    expect(seen).toEqual([300_000]);
    expect(REQUEST_TTL_MS).toBe(300_000);
    expect(MAX_WAIT_MS).toBeLessThanOrEqual(REQUEST_TTL_MS);
  });
});

describe("approval in the last seconds of the window", () => {
  // Seen in a live run: approved 2 s before the window closed, but the next
  // 10 s poll landed after it, so Guardian refused the claim.
  function windowedClient(approvedAtMs: number, clock: { t: number }) {
    const client: Client = {
      async request() {
        return {
          ok: false,
          reasonCode: "APPROVAL_REQUIRED",
          requestId: "req_w",
        };
      },
      async claim() {
        if (clock.t >= 300_000) {
          return {
            ok: false,
            reasonCode: "APPROVAL_EXPIRED",
            requestId: "req_w",
          };
        }
        return clock.t >= approvedAtMs
          ? {
              ok: true,
              requestId: "req_w",
              decision: "ALLOW",
              capabilityToken: "cap",
            }
          : { ok: false, reasonCode: "APPROVAL_PENDING", requestId: "req_w" };
      },
      async execute() {
        return {
          ok: true,
          receipt: { receiptReference: "r", status: "succeeded" } as never,
        };
      },
    };
    return client;
  }

  it("is still picked up: the final check runs just before the window closes", async () => {
    const clock = { t: 0 };
    const waits: number[] = [];
    const verdict = await decide(
      terraform,
      base(windowedClient(298_000, clock), {
        pollIntervalMs: 2_000,
        approvalTimeoutMs: 300_000,
        requestTtlMs: 300_000,
        now: () => clock.t,
        wait: async (ms) => {
          waits.push(ms);
          clock.t += ms;
        },
      }),
    );
    expect(verdict.decision).toBe("allow");
    expect(clock.t).toBe(300_000 - FINAL_CHECK_LEAD_MS);
    expect(Math.max(...waits)).toBeLessThanOrEqual(10_000);
  });

  it("still denies when nobody approves, without checking after the window", async () => {
    const clock = { t: 0 };
    const verdict = await decide(
      terraform,
      base(windowedClient(Number.POSITIVE_INFINITY, clock), {
        pollIntervalMs: 2_000,
        approvalTimeoutMs: 300_000,
        requestTtlMs: 300_000,
        now: () => clock.t,
        wait: async (ms) => {
          clock.t += ms;
        },
      }),
    );
    expect(verdict.decision).toBe("deny");
    expect(clock.t).toBeLessThan(300_000);
  });
});

describe("approval window timing edges", () => {
  it("times the window from Guardian's reply, so request latency does not cut it short", async () => {
    // The request call takes 3 s; Guardian creates the request at 2 s and
    // accepts approvals until 302 s. An approval at 300.5 s must be claimed.
    const clock = { t: 0 };
    const client: Client = {
      async request() {
        clock.t += 3_000;
        return {
          ok: false,
          reasonCode: "APPROVAL_REQUIRED",
          requestId: "req_l",
        };
      },
      async claim() {
        if (clock.t >= 302_000) {
          return {
            ok: false,
            reasonCode: "APPROVAL_EXPIRED",
            requestId: "req_l",
          };
        }
        return clock.t >= 300_500
          ? {
              ok: true,
              requestId: "req_l",
              decision: "ALLOW",
              capabilityToken: "cap",
            }
          : { ok: false, reasonCode: "APPROVAL_PENDING", requestId: "req_l" };
      },
      async execute() {
        return {
          ok: true,
          receipt: { receiptReference: "r", status: "succeeded" } as never,
        };
      },
    };
    const verdict = await decide(
      terraform,
      base(client, {
        pollIntervalMs: 2_000,
        approvalTimeoutMs: 300_000,
        requestTtlMs: 300_000,
        now: () => clock.t,
        wait: async (ms) => {
          clock.t += ms;
        },
      }),
    );
    expect(verdict.decision).toBe("allow");
  });

  it("a short timeout still waits for an approval inside it", async () => {
    const clock = { t: 0 };
    const client: Client = {
      async request() {
        return {
          ok: false,
          reasonCode: "APPROVAL_REQUIRED",
          requestId: "req_s",
        };
      },
      async claim() {
        return clock.t >= 500
          ? {
              ok: true,
              requestId: "req_s",
              decision: "ALLOW",
              capabilityToken: "cap",
            }
          : { ok: false, reasonCode: "APPROVAL_PENDING", requestId: "req_s" };
      },
      async execute() {
        return {
          ok: true,
          receipt: { receiptReference: "r", status: "succeeded" } as never,
        };
      },
    };
    const verdict = await decide(
      terraform,
      base(client, {
        pollIntervalMs: 200,
        approvalTimeoutMs: 1_000,
        now: () => clock.t,
        wait: async (ms) => {
          clock.t += ms;
        },
      }),
    );
    expect(verdict.decision).toBe("allow");
    expect(clock.t).toBeLessThan(1_000);
  });
});
