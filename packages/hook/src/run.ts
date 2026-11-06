/**
 * The hook's logic, shared by the command line (index.ts: Claude Code,
 * Codex, DeepSeek Harness) and the Claude Agent SDK entry (agent-sdk.ts).
 * No side effects on import.
 */
import { createGuardianClient } from "@odingard/guardian-sdk";

import {
  classifyCommand,
  governedCall,
  HOOK_TOOLS,
  tierOf,
  type HookToolName,
} from "./classify.js";
import { decide, type HookVerdict } from "./decide.js";

type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_BASE_URL = "https://guardian-api.odingard.com";
/**
 * The gateway's longest request window (SDK GUARDIAN_MAX_REQUEST_TTL_MS).
 * The hook asks for all of it and never waits past it.
 */
export const REQUEST_TTL_MS = 300_000;
export const MAX_WAIT_MS = REQUEST_TTL_MS;
/**
 * The hook's own hard deadline. Past it the hook answers deny itself, so it
 * never reaches the agent's hook timeout (600 s in Claude Code, Codex and
 * DeepSeek Harness), where a timed-out hook lets the call run. It sits
 * above the 300 s approval window plus request latency.
 */
export const DEFAULT_DEADLINE_MS = 540_000;

/**
 * Which agent runs the hook. The decision is the same; what differs is the
 * output each agent understands and how a deny is made to hold.
 *
 * - claude-code: PreToolUse JSON on stdout, exit 0.
 * - codex: allow = no output, exit 0 (Codex documents allow only with
 *   updatedInput); deny = deny JSON on stdout + reason on stderr + exit 2.
 * - dsh: the DeepSeek Harness Claude Code hook bridge. Claude Code JSON,
 *   and a deny also exits 2 with the reason on stderr.
 */
export type Dialect = "claude-code" | "codex" | "dsh";

export const DIALECTS: readonly Dialect[] = ["claude-code", "codex", "dsh"];

const AGENT_NAMES: Record<Dialect, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  dsh: "DeepSeek Harness",
};

export type HookResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: 0 | 2;
  /** `null` = not governed: no opinion. */
  verdict: HookVerdict | null;
}>;

/** Format a verdict for one agent. */
export function formatVerdict(
  dialect: Dialect,
  verdict: HookVerdict | null,
): HookResult {
  if (verdict === null) {
    return { stdout: "", stderr: "", exitCode: 0, verdict };
  }
  if (dialect === "claude-code") {
    return {
      stdout: claudeCodeOutput(verdict),
      stderr: "",
      exitCode: 0,
      verdict,
    };
  }
  if (verdict.decision === "allow") {
    return {
      stdout: dialect === "codex" ? "" : claudeCodeOutput(verdict),
      stderr: "",
      exitCode: 0,
      verdict,
    };
  }
  // Belt and braces: exit 2 blocks in both agents even where the JSON is
  // not read, and stderr carries the reason the model sees.
  return {
    stdout: claudeCodeOutput(verdict),
    stderr: verdict.reason,
    exitCode: 2,
    verdict,
  };
}

/** Claude Code PreToolUse output. Exit code stays 0 so the JSON applies. */
export function claudeCodeOutput(verdict: HookVerdict): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: verdict.decision,
      permissionDecisionReason: verdict.reason,
    },
  });
}

export const SETTINGS_SNIPPET = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__.*",
        hooks: [
          {
            type: "command",
            command: "npx -y @odingard/guardian-hook",
            timeout: 600,
          },
        ],
      },
    ],
  },
};

/**
 * Codex: `~/.codex/hooks.json` (or `<repo>/.codex/hooks.json`). The `||`
 * turns a hook that cannot start (node or the package missing) into exit 2,
 * which blocks; Codex would otherwise treat that failure as non-blocking.
 */
export const CODEX_HOOK_COMMAND =
  'guardian-hook codex || { s=$?; [ $s -eq 2 ] || echo "Guardian hook failed to run. Nothing ran." >&2; exit 2; }';

export const CODEX_HOOKS_SNIPPET = {
  hooks: {
    PreToolUse: [
      {
        matcher: "^(Bash|apply_patch)$|^mcp__.*",
        hooks: [
          {
            type: "command",
            command: CODEX_HOOK_COMMAND,
            timeout: 600,
            statusMessage: "Guardian is checking this action",
          },
        ],
      },
    ],
  },
};

/**
 * DeepSeek Harness: the hooks.json the `@deepseek-ai/dsh-hooks-claude-code`
 * bridge reads. The matcher subject is dsh's own tool name (the bridge
 * passes it unchanged); Claude Code's names are listed too so a bridge that
 * renamed them would still reach the hook. The matcher selects whether the
 * hook runs at all, so a tool missing here is not governed.
 */
export const DSH_HOOK_COMMAND =
  'guardian-hook dsh || { s=$?; [ $s -eq 2 ] || echo "Guardian hook failed to run. Nothing ran." >&2; exit 2; }';

export const DSH_HOOKS_SNIPPET = {
  hooks: {
    PreToolUse: [
      {
        matcher:
          "^(bash|pwsh|terminal_send|write|edit|apply_patch|str_replace_editor|web_fetch|Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch)$|^mcp__.*",
        hooks: [{ type: "command", command: DSH_HOOK_COMMAND, timeout: 600 }],
      },
    ],
  },
};

/** Which connection a tool's request goes to (modes are per connection). */
export function connectionFor(
  toolName: HookToolName,
  env: Env,
): string | undefined {
  const allow = env.GUARDIAN_CONNECTION_ID?.trim() || undefined;
  if (tierOf(toolName) === "allow") return allow;
  return env.GUARDIAN_HOOK_ASK_CONNECTION_ID?.trim() || allow;
}

export function setupText(dialect: Dialect = "claude-code"): string {
  const list = (mode: "allow" | "ask") =>
    HOOK_TOOLS.filter((t) => t.suggestedMode === mode)
      .map((t) => `     ${t.name.padEnd(18)} ${t.description}`)
      .join("\n");
  return [
    "Guardian modes are set per connection, so the hook uses two record-only tool servers.",
    "",
    "1. In the Guardian console, Connections → Register a tool server → record-only:",
    '   a) "Coding agent — everyday" with these tools:',
    list("allow"),
    '   b) "Coding agent — needs approval" with these tools:',
    list("ask"),
    "      plus any MCP tools you use, named mcp.<server>.<tool>",
    "      (`npx @odingard/guardian-mcp tools -- <server>` lists them).",
    "",
    "2. Agents → your coding agent:",
    "   - set Allow on (a) and Ask me first on (b);",
    "   - on each of the two connection cards, type every tool name above into",
    '     "Allow a tool by name" and press Allow tool (once per tool).',
    "     Without this step every call is denied as INVALID_REQUEST.",
    "",
    "3. In the shell that starts the agent, export GUARDIAN_AGENT_CREDENTIAL,",
    "   GUARDIAN_CONNECTION_ID (a) and GUARDIAN_HOOK_ASK_CONNECTION_ID (b).",
    "",
    ...agentSteps(dialect),
  ].join("\n");
}

function agentSteps(dialect: Dialect): string[] {
  if (dialect === "codex") {
    return [
      "4. Install the hook where Codex runs (npm i -g @odingard/guardian-hook), then add",
      "   this to ~/.codex/hooks.json (or <repo>/.codex/hooks.json):",
      JSON.stringify(CODEX_HOOKS_SNIPPET, null, 2),
      "",
      "5. Trust it once with /hooks in the Codex TUI, or run headless with",
      "   `codex exec --dangerously-bypass-hook-trust ...`. Untrusted hooks are skipped.",
      "",
      "Governed: Bash (shell and unified exec_command), apply_patch file edits, MCP tools.",
      "NOT governed: write_stdin. Codex runs no hook when it types into an open",
      "exec_command session, so anything typed there skips Guardian. Starting an",
      "interactive shell, interpreter or ssh session is routed to shell_session (Ask);",
      "to close the gap, turn unified exec off in a managed requirements.toml:",
      "   [features]",
      "   unified_exec = false",
      "Also not governed: hosted tools such as WebSearch, and tool paths Codex runs",
      "without hooks. A missing, untrusted or unparseable hooks.json governs nothing.",
      "Codex lets a call run if the hook crashes or times out; the || above and the",
      "hook's own 540 s deadline turn those cases into a deny.",
    ];
  }
  if (dialect === "dsh") {
    return [
      "4. Install the hook in the image or on the volume (npm i -g @odingard/guardian-hook),",
      "   save this as /data/.dsh/guardian-hooks.json:",
      JSON.stringify(DSH_HOOKS_SNIPPET, null, 2),
      "",
      "5. Mount the Claude Code hook bridge in $DSH_HOME/cordis.patch.yml:",
      "   - insert:",
      "       - id: guardian-hooks",
      "         name: '@deepseek-ai/dsh-hooks-claude-code'",
      "         config: { configPath: /data/.dsh/guardian-hooks.json, defaultTimeoutMs: 600000 }",
      "",
      "Governed: bash, pwsh, terminal_send, write, edit, apply_patch, str_replace_editor",
      "(not view), web_fetch, MCP tools. The matcher decides whether the hook runs at",
      "all: a tool it does not name is not governed. NOT governed: every other dsh tool,",
      "including run_code itself, subagent, workflow, plugin_manager and",
      "load_workspace_dependencies (install packages), stagehand_act/stagehand_navigate",
      "(browser actions), send_message, spawn_teammate, team_task_*, job_*, schedule_*,",
      "skill, lsp, propose_action, terminal_open, web_search, read/glob/grep.",
      "A missing or unparseable hooks file: the bridge registers no hooks and nothing",
      "is governed. The bridge lets a call run if the hook crashes; the || above and",
      "the hook's own 540 s deadline turn those cases into a deny.",
    ];
  }
  return [
    "4. Add this to .claude/settings.json (project) or ~/.claude/settings.json (all projects):",
    JSON.stringify(SETTINGS_SNIPPET, null, 2),
    "",
    "Read-only tools (Read, Grep, Glob, LS, WebSearch) are not routed through Guardian.",
  ];
}

type HookInput = {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
};

type HookDeps = {
  client?: Parameters<typeof decide>[1]["client"];
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
};

/** Claude Code output (string; "" = no opinion). Kept for existing callers. */
export async function runHook(
  stdin: string,
  env: Env,
  deps: HookDeps = {},
): Promise<string> {
  return (await runHookAs("claude-code", stdin, env, deps)).stdout;
}

/**
 * Decide one tool call for `dialect`. Never throws and never outlives its
 * deadline (GUARDIAN_HOOK_DEADLINE_MS, default 540 s): whatever goes wrong,
 * the answer is a deny in the agent's own format. `stdin` may be a promise
 * so the deadline also covers reading it: an agent that never closes the
 * hook's stdin gets a deny, not a hang into its own timeout.
 */
export async function runHookAs(
  dialect: Dialect,
  stdin: string | Promise<string>,
  env: Env,
  deps: HookDeps = {},
): Promise<HookResult> {
  const requested = Number(
    env.GUARDIAN_HOOK_DEADLINE_MS ?? DEFAULT_DEADLINE_MS,
  );
  const deadlineMs =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, DEFAULT_DEADLINE_MS)
      : DEFAULT_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<HookVerdict>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          decision: "deny",
          reason:
            "Guardian hook: no decision before the hook's deadline. Nothing ran.",
        }),
      deadlineMs,
    );
    timer.unref?.();
  });
  try {
    const verdict = await Promise.race([
      evaluate(dialect, stdin, env, deps, deadlineMs).catch(
        (): HookVerdict => ({
          decision: "deny",
          reason: "Guardian hook: crashed. Nothing ran.",
        }),
      ),
      timedOut,
    ]);
    return formatVerdict(dialect, verdict);
  } finally {
    clearTimeout(timer);
  }
}

async function evaluate(
  dialect: Dialect,
  stdinText: string | Promise<string>,
  env: Env,
  deps: HookDeps,
  deadlineMs: number,
): Promise<HookVerdict | null> {
  const failClosed = (reason: string): HookVerdict => ({
    decision: "deny",
    reason: `Guardian hook: ${reason}`,
  });
  let input: HookInput;
  try {
    input = JSON.parse(await stdinText) as HookInput;
  } catch {
    return failClosed(
      "could not read the tool call from the agent. Nothing ran.",
    );
  }
  if (!input || typeof input.tool_name !== "string") {
    return failClosed("the tool call had no tool name. Nothing ran.");
  }
  const call = governedCall({
    tool: input.tool_name,
    input:
      input.tool_input && typeof input.tool_input === "object"
        ? (input.tool_input as Record<string, unknown>)
        : {},
    ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
  });
  // Not a governed tool: no opinion; the agent's own permissions apply.
  if (call === null) return null;

  const connectionId = connectionFor(call.toolName, env);
  const credential = env.GUARDIAN_AGENT_CREDENTIAL?.trim();
  const baseUrl = (env.GUARDIAN_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  if (!deps.client && (!credential || !connectionId)) {
    return failClosed(
      `GUARDIAN_AGENT_CREDENTIAL and GUARDIAN_CONNECTION_ID must be set (run \`${dialect === "claude-code" ? "npx @odingard/guardian-hook" : `guardian-hook ${dialect}`} setup\`). Nothing ran.`,
    );
  }
  if (!deps.client && !baseUrl.startsWith("https://")) {
    return failClosed("GUARDIAN_BASE_URL must be https. Nothing ran.");
  }
  const requested = Number(
    env.GUARDIAN_HOOK_APPROVAL_TIMEOUT_MS ?? MAX_WAIT_MS,
  );
  // Leave the deadline room for the request and the final redemption.
  const ceiling = Math.max(0, Math.min(MAX_WAIT_MS, deadlineMs - 30_000));
  const approvalTimeoutMs = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 0), ceiling)
    : ceiling;
  return decide(call, {
    client:
      deps.client ??
      createGuardianClient({
        baseUrl,
        credential: credential!,
        ...(env.GUARDIAN_ADAPTER_ID
          ? { adapterId: env.GUARDIAN_ADAPTER_ID }
          : {}),
      }),
    connectionId: connectionId ?? "",
    agentName: env.GUARDIAN_HOOK_AGENT_NAME?.trim() || AGENT_NAMES[dialect],
    approvalTimeoutMs,
    requestTtlMs: REQUEST_TTL_MS,
    pollIntervalMs: 2_000,
    ...(deps.wait ? { wait: deps.wait } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
}
