/**
 * Runs the hook command so that every failure blocks the tool call.
 *
 * No imports, on purpose: this code must load and work when the rest of the
 * package, or its dependencies, cannot (a missing or unbuilt
 * @odingard/guardian-sdk, a syntax error, a broken install).
 *
 * Every agent the hook serves runs the tool when a hook fails in any way
 * other than exit 2 (Claude Code without `onFailure: "block"`, Codex, the
 * DeepSeek Harness bridge). So a failure before the hook has answered
 * (the module does not load, it throws, a promise is rejected and not
 * handled, the process is about to exit without an answer, a signal) is
 * answered here with a block: the reason on stderr, exit code 2, and the
 * Claude Code deny JSON on stdout. Exit 2 blocks in all three agents even
 * if stdout is not readable JSON.
 *
 * Once the hook has answered, its answer stands: a later stray error does
 * not change it.
 */

/** What the hook module gives the runner. */
export type HookModule = {
  main(argv: readonly string[]): Promise<void>;
  /** True once the hook has written its answer. */
  hookAnswered(): boolean;
};

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const ERROR_CLASS = /^(?:[A-Z][A-Za-z0-9]{0,55})?(?:Error|Exception)$/;

/**
 * A short, safe label for the failure: an error code or class name only.
 * Nothing else from the error (its message, a thrown string) is shown: it
 * could hold a secret or text meant for the model.
 */
function label(cause: unknown): string {
  if (typeof cause === "string") return CODE.test(cause) ? cause : "error";
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && CODE.test(code)) {
      return code;
    }
    const name = (cause as { name?: unknown }).name;
    if (typeof name === "string" && ERROR_CLASS.test(name)) {
      return name;
    }
  }
  return "error";
}

/** The block the agent gets when the hook fails. */
export function failureOutput(
  stage: "start" | "run",
  cause: unknown,
): { stdout: string; stderr: string; exitCode: 2 } {
  const reason =
    stage === "start"
      ? `Guardian hook failed to start (${label(cause)}), so the action was blocked. Nothing ran.`
      : `Guardian hook crashed (${label(cause)}), so the action was blocked. Nothing ran.`;
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
    stderr: reason,
    exitCode: 2,
  };
}

/**
 * Load the hook module and run it, blocking on any failure. `load` is where
 * module-load errors surface (a dynamic import), so they are caught too.
 */
export function runFailClosed(
  load: () => Promise<HookModule>,
  argv: readonly string[] = process.argv.slice(2),
): void {
  let hook: HookModule | undefined;
  let stage: "start" | "run" = "start";
  let settled = false;
  let failed = false;

  const answered = (): boolean => {
    try {
      return hook?.hookAnswered() === true;
    } catch {
      return false;
    }
  };

  const write = (stream: NodeJS.WriteStream, text: string): void => {
    try {
      stream.write(`${text}\n`);
    } catch {
      // A closed pipe must not stop the exit code below.
    }
  };

  const block = (cause: unknown): void => {
    failed = true;
    const out = failureOutput(stage, cause);
    write(process.stdout, out.stdout);
    write(process.stderr, out.stderr);
    process.exitCode = out.exitCode;
  };

  const fail = (cause: unknown): void => {
    if (failed) {
      process.exit(2);
    }
    if (answered()) {
      // The answer is out; keep it.
      process.exit(process.exitCode ?? 0);
    }
    block(cause);
    // Exit now: whatever failed may keep the process alive past the agent's
    // hook timeout, where the call would run.
    process.exit(2);
  };

  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  for (const signal of SIGNALS) process.on(signal, () => fail(signal));
  // The event loop ran dry while the hook had not finished: a promise that
  // never settles. Exit 0 with no output would let the call run.
  process.on("beforeExit", () => {
    if (!settled) fail("NO_ANSWER");
  });
  // Something called process.exit before the hook answered.
  process.on("exit", () => {
    if (!settled && !failed && !answered()) block("EXITED_EARLY");
  });

  (async () => {
    hook = await load();
    stage = "run";
    await hook.main(argv);
    settled = true;
  })().catch(fail);
}
