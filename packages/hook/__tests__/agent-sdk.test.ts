import { describe, expect, it } from "vitest";

import {
  GUARDIAN_HOOK_TIMEOUT_SECONDS,
  guardianHookMatcher,
  guardianPreToolUse,
} from "../src/agent-sdk.js";
import type { DecideOptions } from "../src/decide.js";
import { MAX_WAIT_MS } from "../src/index.js";

/** Guardian as a PreToolUse hook for the Claude Agent SDK. */
type Client = DecideOptions["client"];
type Result = Awaited<ReturnType<Client["request"]>>;

const ENV = {
  GUARDIAN_AGENT_CREDENTIAL: "gac1.test",
  GUARDIAN_CONNECTION_ID: "pcn_everyday",
  GUARDIAN_HOOK_ASK_CONNECTION_ID: "pcn_ask",
};

function fakeGuardian(request: Result, claims: Result[] = []) {
  const seen: { connectionId: string; toolName: string; purpose: string }[] =
    [];
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
    async execute() {
      return {
        ok: true,
        receipt: { receiptReference: "r", status: "succeeded" } as never,
      };
    },
  };
  return { client, seen };
}

const preToolUse = (tool_name: string, tool_input: object) => ({
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input,
  cwd: "/repo",
});

const quiet = { log: () => {}, wait: async () => {} };

describe("guardianPreToolUse (Claude Agent SDK)", () => {
  it("an allowed command runs, in the Agent SDK's PreToolUse output shape", async () => {
    const { client, seen } = fakeGuardian({
      ok: true,
      requestId: "req_1",
      decision: "ALLOW",
      capabilityToken: "cap",
    });
    const hook = guardianPreToolUse({ env: ENV, client, ...quiet });
    expect(await hook(preToolUse("Bash", { command: "npm test" }))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: expect.stringContaining("req_1"),
      },
    });
    expect(seen).toEqual([
      {
        connectionId: "pcn_everyday",
        toolName: "shell",
        purpose: expect.stringMatching(/^Claude agent: /),
      },
    ]);
  });

  it("a deploy goes to the Ask connection and runs only after a person approves", async () => {
    const { client, seen } = fakeGuardian(
      { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId: "req_2" },
      [
        { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId: "req_2" },
        {
          ok: true,
          requestId: "req_2",
          decision: "ALLOW",
          capabilityToken: "cap",
        },
      ],
    );
    const hook = guardianPreToolUse({
      env: ENV,
      client,
      agentName: "Deploy bot",
      ...quiet,
    });
    const out = await hook(preToolUse("Bash", { command: "terraform apply" }));
    expect(out).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    expect(seen[0]).toMatchObject({
      connectionId: "pcn_ask",
      toolName: "shell_deploy",
      purpose: expect.stringMatching(/^Deploy bot: /),
    });
  });

  it("denies when Guardian denies, or when no one approves in time", async () => {
    const denied = fakeGuardian({
      ok: true,
      requestId: "req_3",
      decision: "DENY",
      reasonCode: "NOT_AUTHORIZED",
    });
    expect(
      await guardianPreToolUse({ env: ENV, client: denied.client, ...quiet })(
        preToolUse("Bash", { command: "rm -rf build" }),
      ),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });

    let clock = 0;
    const pending = fakeGuardian(
      { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId: "req_4" },
      [{ ok: false, reasonCode: "APPROVAL_REQUIRED", requestId: "req_4" }],
    );
    const out = await guardianPreToolUse({
      env: ENV,
      client: pending.client,
      log: () => {},
      wait: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    })(preToolUse("Bash", { command: "git push origin main" }));
    expect(out).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("fails closed without configuration, and has no opinion on read-only tools", async () => {
    const hook = guardianPreToolUse({ env: {}, ...quiet });
    expect(
      await hook(preToolUse("Bash", { command: "npm test" })),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await hook(preToolUse("Read", { file_path: "/repo/a" }))).toEqual(
      {},
    );
    expect(
      await hook({ hook_event_name: "PostToolUse", tool_name: "Bash" }),
    ).toEqual({});
  });

  it("the recommended matcher blocks on a crash and outlasts the approval window", () => {
    const matcher = guardianHookMatcher({ env: ENV });
    expect(matcher.onFailure).toBe("block");
    expect(matcher.hooks).toHaveLength(1);
    expect(matcher.timeout).toBe(GUARDIAN_HOOK_TIMEOUT_SECONDS);
    expect(GUARDIAN_HOOK_TIMEOUT_SECONDS * 1000).toBeGreaterThan(MAX_WAIT_MS);
  });
});
