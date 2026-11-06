/**
 * Guardian for agents built on Anthropic's Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`).
 *
 *   import { query } from "@anthropic-ai/claude-agent-sdk";
 *   import { guardianHookMatcher } from "@odingard/guardian-hook/agent-sdk";
 *
 *   for await (const message of query({
 *     prompt: "Deploy the staging stack",
 *     options: { hooks: { PreToolUse: [guardianHookMatcher()] } },
 *   })) { ... }
 *
 * Every shell command, file write and MCP call the agent makes is sent to
 * Guardian for a deterministic ALLOW / ASK / DENY decision before it runs.
 * Deploys, destructive commands and pushes wait for a person to approve on
 * their phone; every allowed call leaves a verifiable receipt. Read-only
 * tools are left to the agent's own permissions.
 *
 * It is the same decision path as the Claude Code hook (`runHook`), so the
 * Agent SDK gets exactly the behaviour already proven there. A PreToolUse
 * hook runs for every tool call, including calls an allow rule or a bypass
 * mode would approve, and its deny holds in every permission mode.
 *
 * Fails closed: missing configuration, an unreachable Guardian or an
 * approval that does not arrive in time all deny the call. Register it with
 * `onFailure: "block"` (as `guardianHookMatcher` does) so that a crash also
 * blocks the call instead of letting it through.
 */
import type { DecideOptions } from "./decide.js";
import { MAX_WAIT_MS, runHook } from "./run.js";

type Env = Readonly<Record<string, string | undefined>>;

/** The PreToolUse input fields the hook reads (a subset of the SDK's type). */
export type GuardianHookInput = Readonly<{
  hook_event_name?: string;
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
}>;

/** The PreToolUse output the Agent SDK accepts (`{}` = no opinion). */
export type GuardianHookOutput =
  | Record<string, never>
  | {
      hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision: "allow" | "deny";
        permissionDecisionReason: string;
      };
    };

export type GuardianPreToolUseOptions = Readonly<{
  /**
   * Configuration (same names as the Claude Code hook):
   * GUARDIAN_AGENT_CREDENTIAL, GUARDIAN_CONNECTION_ID,
   * GUARDIAN_HOOK_ASK_CONNECTION_ID, GUARDIAN_BASE_URL,
   * GUARDIAN_HOOK_APPROVAL_TIMEOUT_MS. Default: `process.env`.
   */
  env?: Env;
  /** Label approvers see (default "Claude agent"). */
  agentName?: string;
  /** Progress lines, e.g. "held for approval". Default: stderr. */
  log?: (line: string) => void;
  /** For tests: a Guardian client stand-in. */
  client?: DecideOptions["client"];
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}>;

/** A PreToolUse callback for `query({ options: { hooks } })`. */
export function guardianPreToolUse(
  options: GuardianPreToolUseOptions = {},
): (input: GuardianHookInput) => Promise<GuardianHookOutput> {
  return async (input) => {
    if (input.hook_event_name && input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const base = options.env ?? process.env;
    const env: Env = {
      ...base,
      GUARDIAN_HOOK_AGENT_NAME:
        options.agentName ?? base.GUARDIAN_HOOK_AGENT_NAME ?? "Claude agent",
    };
    const output = await runHook(
      JSON.stringify({
        tool_name: input.tool_name,
        tool_input: input.tool_input,
        cwd: input.cwd,
      }),
      env,
      {
        log: options.log ?? ((line) => process.stderr.write(`${line}\n`)),
        ...(options.client ? { client: options.client } : {}),
        ...(options.wait ? { wait: options.wait } : {}),
        ...(options.now ? { now: options.now } : {}),
      },
    );
    // "" means the tool is not governed (read-only): no opinion.
    return output ? (JSON.parse(output) as GuardianHookOutput) : {};
  };
}

/**
 * Seconds the SDK waits for the hook: Guardian's 5-minute approval window
 * plus a margin, so a human approval is never cut off by the SDK timeout.
 */
export const GUARDIAN_HOOK_TIMEOUT_SECONDS = Math.ceil(MAX_WAIT_MS / 1000) + 30;

/**
 * The recommended registration: every tool, fail closed on a crash, and a
 * timeout longer than the approval window.
 */
export function guardianHookMatcher(options: GuardianPreToolUseOptions = {}) {
  return {
    hooks: [guardianPreToolUse(options)],
    timeout: GUARDIAN_HOOK_TIMEOUT_SECONDS,
    onFailure: "block" as const,
  };
}
