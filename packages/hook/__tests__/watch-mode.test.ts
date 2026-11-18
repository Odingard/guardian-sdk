/**
 * Watch mode: while the agent is watched, Guardian issues no capability
 * for a call it would have asked about or denied. The hook asks for the
 * watched answer and, for such a call, gives no permission decision (the
 * agent's own permissions apply). Anything else stays a deny.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { guardianPreToolUse } from "../src/agent-sdk.js";
import { governedCall } from "../src/classify.js";
import { decide, type DecideOptions } from "../src/decide.js";
import { runHookAs, watchModeFromEnv, type Dialect } from "../src/index.js";

type Client = DecideOptions["client"];
type Result = Awaited<ReturnType<Client["request"]>>;

const ENV = {
  GUARDIAN_AGENT_CREDENTIAL: "gac1-test-credential-never-printed",
  GUARDIAN_CONNECTION_ID: "pcn_everyday01",
  GUARDIAN_HOOK_ASK_CONNECTION_ID: "pcn_approval01",
  GUARDIAN_HOOK_WATCH_MODE: "on",
};

const quiet = { log: () => {}, wait: async () => {} };

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hook-watch-"));
  file = join(dir, "app.ts");
  writeFileSync(file, "const a = 1;\n");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fake(answer: Result, beforeAnswer: () => void = () => {}) {
  const invocations: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const client: Client = {
    async request(invocation) {
      invocations.push(invocation as Record<string, unknown>);
      calls.push("request");
      beforeAnswer();
      return answer;
    },
    async claim(requestId) {
      calls.push(`claim ${requestId}`);
      return { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId };
    },
    async execute({ requestId }) {
      calls.push(`execute ${requestId}`);
      return {
        ok: true,
        receipt: { receiptReference: "r", status: "succeeded" } as never,
      };
    },
  };
  return { client, invocations, calls };
}

const watched = (would: "ASK" | "DENY"): Result => ({
  ok: true,
  requestId: "req_watched1",
  decision: "DENY",
  reasonCode: "WATCHED",
  watched: would,
});

const stdin = (tool_name: string, tool_input: object) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
    cwd: dir,
  });

const bash = (dialect: Dialect) =>
  stdin(dialect === "dsh" ? "bash" : "Bash", {
    command: "terraform apply -auto-approve",
  });

describe("watch mode: a watched call is left to the agent", () => {
  for (const would of ["ASK", "DENY"] as const) {
    it(`Claude Code: no permission decision, a note for the person (would ${would})`, async () => {
      const g = fake(watched(would));
      const out = await runHookAs("claude-code", bash("claude-code"), ENV, {
        client: g.client,
        ...quiet,
      });
      expect(out.exitCode).toBe(0);
      expect(out.stderr).toBe("");
      const json = JSON.parse(out.stdout) as Record<string, unknown>;
      expect(Object.keys(json)).toEqual(["systemMessage"]);
      expect(String(json.systemMessage)).toContain(
        "Guardian is watching this agent",
      );
      expect(String(json.systemMessage)).toContain("req_watched1");
      expect(out.verdict).toMatchObject({
        decision: "watched",
        requestId: "req_watched1",
        wouldDecision: would,
      });
      // It asked for the watched answer, and redeemed nothing.
      expect(g.invocations[0]).toMatchObject({ watchAware: true });
      expect(g.calls).toEqual(["request"]);
    });
  }

  for (const dialect of ["codex", "dsh"] as const) {
    it(`${dialect}: no output and exit 0, so the agent's own permissions apply`, async () => {
      const g = fake(watched("ASK"));
      const out = await runHookAs(dialect, bash(dialect), ENV, {
        client: g.client,
        ...quiet,
      });
      expect(out).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
      expect(out.verdict?.decision).toBe("watched");
      expect(g.calls).toEqual(["request"]);
    });
  }

  it("Claude Agent SDK: no permission decision, a note for the person", async () => {
    const g = fake(watched("DENY"));
    const output = await guardianPreToolUse({
      env: ENV,
      client: g.client,
      ...quiet,
    })({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "terraform apply -auto-approve" },
      cwd: dir,
    });
    expect(Object.keys(output)).toEqual(["systemMessage"]);
  });

  it("an edit is left to the agent while its target is unchanged", async () => {
    const g = fake(watched("ASK"));
    const out = await runHookAs(
      "claude-code",
      stdin("Edit", { file_path: file, old_string: "1", new_string: "2" }),
      ENV,
      { client: g.client, ...quiet },
    );
    expect(out.verdict?.decision).toBe("watched");
    expect(
      (g.invocations[0]!.arguments as Record<string, unknown>)
        .guardianContentPins,
    ).toHaveLength(1);
  });

  it("an edit whose target changed after it was pinned is denied", async () => {
    const g = fake(watched("ASK"), () => writeFileSync(file, "changed\n"));
    const out = await runHookAs(
      "claude-code",
      stdin("Edit", { file_path: file, old_string: "1", new_string: "2" }),
      ENV,
      { client: g.client, ...quiet },
    );
    expect(out.verdict?.decision).toBe("deny");
    expect(out.stdout).toContain('"permissionDecision":"deny"');
    expect(out.stdout).toContain("CONTENT_CHANGED_SINCE_APPROVAL");
  });
});

describe("watch mode: everything else stays a deny", () => {
  const cases: [string, Result][] = [
    [
      "a WATCHED answer without a would-be decision",
      { ok: true, requestId: "req_w", decision: "DENY", reasonCode: "WATCHED" },
    ],
    [
      "a would-be decision on another reason",
      {
        ok: true,
        requestId: "req_w",
        decision: "DENY",
        reasonCode: "NOT_AUTHORIZED",
        watched: "ASK",
      },
    ],
    [
      "a watched answer that did not run (older SDK or hook)",
      {
        ok: true,
        requestId: "req_w",
        decision: "DENY",
        reasonCode: "WATCHED_NOT_RUN",
      },
    ],
    [
      "a malformed would-be decision",
      {
        ok: true,
        requestId: "req_w",
        decision: "DENY",
        reasonCode: "WATCHED",
        watched: "ALLOW" as never,
      },
    ],
    ["Guardian unreachable", { ok: false, reasonCode: "SERVICE_UNAVAILABLE" }],
  ];
  for (const [label, answer] of cases) {
    for (const dialect of ["claude-code", "codex", "dsh"] as const) {
      it(`${dialect}: ${label}`, async () => {
        const g = fake(answer);
        const out = await runHookAs(dialect, bash(dialect), ENV, {
          client: g.client,
          ...quiet,
        });
        expect(out.verdict?.decision).toBe("deny");
        if (dialect === "claude-code") {
          expect(out.stdout).toContain('"permissionDecision":"deny"');
        } else {
          expect(out.exitCode).toBe(2);
        }
        expect(g.calls).toEqual(["request"]);
      });
    }
  }

  for (const value of [undefined, "", "off", "true", "1", "ON "]) {
    it(`watch mode is off unless GUARDIAN_HOOK_WATCH_MODE=on (${JSON.stringify(value)})`, async () => {
      const g = fake(watched("ASK"));
      const env: Record<string, string | undefined> = {
        ...ENV,
        GUARDIAN_HOOK_WATCH_MODE: value,
      };
      const out = await runHookAs("claude-code", bash("claude-code"), env, {
        client: g.client,
        ...quiet,
      });
      expect(out.verdict?.decision).toBe("deny");
      expect(g.invocations[0]).not.toHaveProperty("watchAware");
      expect(watchModeFromEnv(env)).toBe(false);
    });
  }

  it("watch mode is on for an exact on, spaces trimmed", () => {
    expect(watchModeFromEnv({ GUARDIAN_HOOK_WATCH_MODE: " on " })).toBe(true);
  });

  it("names a watched call that did not run in plain words", async () => {
    const g = fake(cases[2]![1]);
    const out = await runHookAs("claude-code", bash("claude-code"), ENV, {
      client: g.client,
      ...quiet,
    });
    expect(out.verdict?.reason).toContain("WATCHED_NOT_RUN");
    expect(out.verdict?.reason).toContain("watch mode");
  });

  it("decide() without watchAware never answers watched", async () => {
    const call = governedCall({
      tool: "Bash",
      input: { command: "terraform apply -auto-approve" },
    })!;
    const g = fake(watched("ASK"));
    const verdict = await decide(call, {
      client: g.client,
      connectionId: "pcn_approval01",
      agentName: "Test",
      approvalTimeoutMs: 1_000,
      pollIntervalMs: 1,
      ...quiet,
    });
    expect(verdict.decision).toBe("deny");
    expect(g.invocations[0]).not.toHaveProperty("watchAware");
  });
});
