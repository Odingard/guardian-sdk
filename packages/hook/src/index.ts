#!/usr/bin/env node
/**
 * guardian-hook — put Guardian in front of a coding agent's tool calls.
 *
 * PreToolUse hook (stdin: hook JSON; stdout: decision JSON):
 *   guardian-hook               decide one Claude Code tool call
 *   guardian-hook codex         decide one OpenAI Codex CLI tool call
 *   guardian-hook dsh           decide one DeepSeek Harness tool call (via
 *                               its Claude Code hook bridge)
 *   guardian-hook [codex|dsh] setup  print the agent's hook config + tools
 *   guardian-hook classify CMD  show which Guardian tool a shell command maps to
 *
 * For codex and dsh a deny also exits 2 with the reason on stderr, because
 * both agents let a call run when a hook fails in any other way.
 *
 * Environment (same names as guardian-mcp):
 *   GUARDIAN_BASE_URL          default https://guardian-api.odingard.com
 *   GUARDIAN_AGENT_CREDENTIAL  required, the agent credential from the console
 *   GUARDIAN_CONNECTION_ID     required, the record-only tool-server
 *                              connection for the Allow-tier tools
 *   GUARDIAN_HOOK_ASK_CONNECTION_ID  the connection for the Ask-tier tools
 *                              (deploys, destructive, pushes, MCP). Guardian
 *                              modes are per connection, so without it every
 *                              tool shares one mode.
 *   GUARDIAN_HOOK_AGENT_NAME   label shown to approvers (default "Claude Code",
 *                              "Codex" or "DeepSeek Harness")
 *   GUARDIAN_HOOK_DIALECT      claude-code | codex | dsh, instead of the
 *                              subcommand
 *   GUARDIAN_HOOK_DEADLINE_MS  the hook's own hard deadline (default and
 *                              maximum 540000); past it the hook denies
 *   GUARDIAN_HOOK_APPROVAL_TIMEOUT_MS  how long ASK waits (default and
 *                              maximum 300000: the hook asks Guardian to keep
 *                              the request open that long, the gateway's
 *                              limit, and an ASK expires after it. Also under
 *                              Claude Code's 600 s hook timeout, because a
 *                              timed-out hook does not block)
 *
 * Fails closed: if Guardian cannot confirm a governed call, the call is denied.
 */
import { classifyCommand } from "./classify.js";
import {
  DIALECTS,
  formatVerdict,
  runHookAs,
  setupText,
  type Dialect,
  type HookResult,
} from "./run.js";

export * from "./run.js";

/**
 * The hook input. Resolves at end of input, or as soon as what has arrived
 * is a complete JSON object, so an agent that leaves stdin open is still
 * answered. Read under the hook's deadline (runHookAs takes the promise).
 */
export function readHookInput(
  stream: AsyncIterable<Buffer | string> = process.stdin,
): Promise<string> {
  return (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      if (/\}\s*$/.test(text)) {
        try {
          const value: unknown = JSON.parse(text);
          if (value && typeof value === "object") return text;
        } catch {
          // not complete yet
        }
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
}

function isDialect(value: string | undefined): value is Dialect {
  return (DIALECTS as readonly string[]).includes(value ?? "");
}

/** The agent from the subcommand, else GUARDIAN_HOOK_DIALECT, else Claude Code. */
export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { dialect: Dialect; rest: string[] } {
  const [first, ...rest] = argv;
  if (isDialect(first)) return { dialect: first, rest };
  const fromEnv = env.GUARDIAN_HOOK_DIALECT?.trim();
  return {
    dialect: isDialect(fromEnv) ? fromEnv : "claude-code",
    rest: [...argv],
  };
}

let dialect: Dialect = "claude-code";
let answered = false;

function emit(result: HookResult): void {
  if (answered) return;
  answered = true;
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}

/** Last line of defense: still fail closed in the agent's format. */
function crashed(): void {
  emit(
    formatVerdict(dialect, {
      decision: "deny",
      reason: "Guardian hook crashed. Nothing ran.",
    }),
  );
  // Exit now: whatever crashed may keep the process alive past the
  // agent's hook timeout, where the call would run.
  process.exit(process.exitCode ?? 2);
}

async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(argv, process.env);
  dialect = parsed.dialect;
  const [command, ...rest] = parsed.rest;
  if (command === "setup") {
    process.stdout.write(`${setupText(dialect)}\n`);
    return;
  }
  if (command === "classify") {
    process.stdout.write(`${classifyCommand(rest.join(" "))}\n`);
    return;
  }
  if (command === "--help" || command === "-h") {
    process.stdout.write(
      "guardian-hook [codex | dsh] [setup | classify <command>]\n",
    );
    return;
  }
  emit(
    await runHookAs(dialect, readHookInput(), process.env, {
      log: (line) => process.stderr.write(`${line}\n`),
    }),
  );
  // The answer is out. A request abandoned at the deadline may still hold a
  // socket open; do not let it keep the agent waiting.
  setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  /guardian-hook|hook[\\/]dist[\\/]index\.js$/.test(process.argv[1]);
if (invokedDirectly) {
  process.on("uncaughtException", crashed);
  process.on("unhandledRejection", crashed);
  main(process.argv.slice(2)).catch(crashed);
}
