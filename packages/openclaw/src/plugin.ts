/**
 * The OpenClaw `before_tool_call` handler that sends each consequential tool
 * call to Guardian. No side effects on import.
 *
 *   ALLOW -> the single-use capability is redeemed (receipt recorded), then
 *            the handler returns the parameters Guardian saw, and the tool runs.
 *   ASK   -> the handler waits while a person approves or declines the exact
 *            call in Guardian (phone or console). Guardian is the authority:
 *            OpenClaw's own `requireApproval` is never used to let a call run.
 *   DENY  -> `{ block: true, blockReason }`. Nothing runs.
 *
 * Install integrity first: if the OpenClaw process user can change this
 * plugin, the OpenClaw config or the plugin directory (see integrity.ts),
 * every tool call is blocked and Guardian is not asked, unless the Gateway
 * was started with GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL=1.
 *
 * Fail closed: missing configuration, an unreachable Guardian, a crash, a
 * timeout, an aborted tool call or an approval that does not arrive in time
 * all return `block: true`. If the handler itself throws or OpenClaw's hook
 * timeout expires first, OpenClaw blocks the call (before_tool_call is
 * fail-closed in OpenClaw's hook runner).
 */
import {
  createGuardianClient,
  type GuardianClient,
} from "@odingard/guardian-sdk";

import { decide, type DecideOptions } from "../../hook/src/decide.js";
import { tierOf } from "../../hook/src/classify.js";
import {
  ALLOW_WRITABLE_INSTALL_ENV,
  checkInstallIntegrity,
  guardianStartupEnv,
  INSTALL_CHECK_CACHE_MS,
  installProblemMessage,
  type InstallCheckOptions,
  type InstallCheckResult,
} from "./integrity.js";
import {
  controlRootsFromEnv,
  governOpenClawCall,
  type GovernedCall,
  type HookToolName,
} from "./classify.js";

type Env = Readonly<Record<string, string | undefined>>;

export const PLUGIN_ID = "guardian";
export const DEFAULT_BASE_URL = "https://guardian-api.odingard.com";
/** Guardian's longest request window (SDK GUARDIAN_MAX_REQUEST_TTL_MS). */
export const REQUEST_TTL_MS = 300_000;
/**
 * The before_tool_call budget the plugin asks OpenClaw for: the 5-minute
 * approval window plus room to redeem the capability. Operators should set
 * the same value in `plugins.entries.guardian.hooks.timeouts.before_tool_call`.
 */
export const HOOK_TIMEOUT_MS = 330_000;
/** OpenClaw caps operator hook timeouts at this value. */
export const OPENCLAW_MAX_HOOK_TIMEOUT_MS = 600_000;
/**
 * Time kept back from the hook budget for the final claim and redemption.
 * Guardian is never asked to redeem after `budget - DEADLINE_MARGIN_MS`.
 */
export const EXECUTE_MARGIN_MS = 20_000;
export const DEADLINE_MARGIN_MS = 5_000;
/** One Guardian HTTP call may take at most this long. */
export const FETCH_TIMEOUT_MS = 15_000;
/**
 * Runs after every other before_tool_call handler, so the parameters it
 * returns (the ones Guardian saw) are the ones that execute.
 */
export const HOOK_PRIORITY = -10_000;

/** Non-secret settings (openclaw.json `plugins.entries.guardian.config`). */
export type GuardianPluginConfig = Readonly<{
  baseUrl?: string;
  connectionId?: string;
  askConnectionId?: string;
  agentName?: string;
  approvalTimeoutMs?: number;
  /** Extra Guardian tool names to send to the everyday (Allow) connection. */
  allowTierTools?: readonly string[];
}>;

/** The parts of OpenClaw's before_tool_call event the handler reads. */
export type BeforeToolCallEvent = Readonly<{
  toolName: string;
  params: Record<string, unknown>;
  derivedPaths?: readonly string[];
  /** OpenClaw tags Code Mode's exec as `code_mode_exec`. */
  toolKind?: string;
  runId?: string;
  toolCallId?: string;
}>;

export type BeforeToolCallContext = Readonly<{
  agentId?: string;
  sessionKey?: string;
  abortSignal?: AbortSignal;
}>;

export type BeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
};

export type Logger = Readonly<{
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}>;

export type GuardianHandlerOptions = Readonly<{
  config?: GuardianPluginConfig;
  /** Read once, at registration. The credential is taken from here. */
  env?: Env;
  /** The before_tool_call budget OpenClaw will actually give the handler. */
  hookTimeoutMs?: number;
  logger?: Logger;
  /**
   * Install-integrity check overrides (plugin directory, OpenClaw env, the
   * process user). Default: this plugin's own directory, `env`, this process.
   */
  install?: InstallCheckOptions & { cacheMs?: number };
  /** Tests: a Guardian client stand-in (skips credential checks). */
  client?: DecideOptions["client"];
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  fetch?: typeof fetch;
}>;

type Settings = {
  credential?: string;
  baseUrl: string;
  connectionId?: string;
  askConnectionId?: string;
  agentName: string;
  approvalTimeoutMs: number;
  allowTierTools: ReadonlySet<string>;
};

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveSettings(
  config: GuardianPluginConfig = {},
  env: Env = {},
): Settings {
  const requested = Number(
    config.approvalTimeoutMs ??
      env.GUARDIAN_OPENCLAW_APPROVAL_TIMEOUT_MS ??
      REQUEST_TTL_MS,
  );
  const approvalTimeoutMs = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 0), REQUEST_TTL_MS)
    : REQUEST_TTL_MS;
  return {
    credential: trimmed(env.GUARDIAN_AGENT_CREDENTIAL),
    baseUrl: (
      trimmed(config.baseUrl) ??
      trimmed(env.GUARDIAN_BASE_URL) ??
      DEFAULT_BASE_URL
    ).replace(/\/+$/, ""),
    connectionId:
      trimmed(config.connectionId) ?? trimmed(env.GUARDIAN_CONNECTION_ID),
    askConnectionId:
      trimmed(config.askConnectionId) ??
      trimmed(env.GUARDIAN_HOOK_ASK_CONNECTION_ID),
    agentName:
      trimmed(config.agentName) ??
      trimmed(env.GUARDIAN_HOOK_AGENT_NAME) ??
      "OpenClaw",
    approvalTimeoutMs,
    allowTierTools: new Set(
      (config.allowTierTools ?? []).filter((t) => typeof t === "string"),
    ),
  };
}

function connectionFor(toolName: HookToolName, s: Settings) {
  if (tierOf(toolName) === "allow" || s.allowTierTools.has(toolName)) {
    return s.connectionId;
  }
  return s.askConnectionId ?? s.connectionId;
}

function block(reason: string): BeforeToolCallResult {
  return { block: true, blockReason: reason };
}

/** Rejects when the tool call is cancelled, so waiting stops at once. */
function abortableWait(
  base: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
): (ms: number) => Promise<void> {
  if (!signal) return base;
  return (ms) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      const onAbort = () => reject(new Error("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      base(ms).then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
}

/**
 * Wraps the client so nothing is claimed or redeemed after OpenClaw has
 * stopped waiting (deadline) or after the tool call was cancelled. A refused
 * call surfaces to `decide` as an error, which it treats as a deny.
 */
function guardedClient(
  client: DecideOptions["client"],
  isOver: () => boolean,
): DecideOptions["client"] {
  const check = () => {
    if (isOver()) throw new Error("Guardian window closed");
  };
  return {
    request: async (input) => (check(), client.request(input)),
    claim: async (requestId) => (check(), client.claim(requestId)),
    execute: async (input) => (check(), client.execute(input)),
  };
}

function timedFetch(
  base: typeof fetch,
  signal: AbortSignal | undefined,
): typeof fetch {
  return (input, init) => {
    const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
    if (signal) signals.push(signal);
    if (init?.signal) signals.push(init.signal);
    return base(input, { ...init, signal: AbortSignal.any(signals) });
  };
}

/**
 * Builds the before_tool_call handler. Settings (and the credential) are
 * read once, here; nothing secret is kept anywhere the agent can see.
 */
export function createGuardianToolHandler(
  options: GuardianHandlerOptions = {},
): (
  event: BeforeToolCallEvent,
  ctx?: BeforeToolCallContext,
) => Promise<BeforeToolCallResult | undefined> {
  const log = options.logger ?? {};
  // GUARDIAN_* settings are honoured only from the Gateway's real start-up
  // environment: a key named in <cwd>/.env (which OpenClaw loads, unfiltered
  // for GUARDIAN_*) is ignored, whatever its value.
  const startup = guardianStartupEnv(
    options.env ?? {},
    options.install?.cwd ?? process.cwd(),
  );
  const env: Env = startup.env;
  if (startup.ignored.length) {
    log.warn?.(
      `Guardian: ignoring ${startup.ignored.join(", ")}: named in the Gateway working directory's .env, which the agent may be able to write. Set Guardian settings in the Gateway's own environment or the protected <state dir>/.env.`,
    );
  }
  const settings = resolveSettings(options.config, env);
  const controlRoots = controlRootsFromEnv(env);
  const now = options.now ?? Date.now;
  const baseWait =
    options.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const budget = Math.min(
    Math.max(Number(options.hookTimeoutMs ?? HOOK_TIMEOUT_MS) || 0, 0),
    OPENCLAW_MAX_HOOK_TIMEOUT_MS,
  );
  // Never wait for an approval past the point where OpenClaw stops waiting.
  const approvalTimeoutMs = Math.max(
    0,
    Math.min(settings.approvalTimeoutMs, budget - EXECUTE_MARGIN_MS),
  );

  const configProblem = (() => {
    if (options.client) return undefined;
    if (!settings.credential || !settings.connectionId) {
      return "GUARDIAN_AGENT_CREDENTIAL (Gateway environment) and connectionId (plugin config or GUARDIAN_CONNECTION_ID) must be set";
    }
    if (!settings.baseUrl.startsWith("https://")) {
      return "the Guardian base URL must be https";
    }
    return undefined;
  })();
  // The opt-out is read once, here, from the environment the Gateway was
  // started with: the agent cannot set it later.
  const allowWritableInstall = env[ALLOW_WRITABLE_INSTALL_ENV]?.trim() === "1";
  const installOptions: InstallCheckOptions = {
    env,
    ...options.install,
  };
  const cacheMs = Math.min(
    Math.max(
      Number(options.install?.cacheMs ?? INSTALL_CHECK_CACHE_MS) || 0,
      0,
    ),
    INSTALL_CHECK_CACHE_MS,
  );
  let lastCheck: { at: number; result: InstallCheckResult } | undefined;
  const installCheck = (): InstallCheckResult => {
    if (allowWritableInstall) return { ok: true };
    const t = now();
    if (lastCheck && t >= lastCheck.at && t - lastCheck.at < cacheMs) {
      return lastCheck.result;
    }
    const result = checkInstallIntegrity(installOptions);
    lastCheck = { at: t, result };
    return result;
  };
  if (allowWritableInstall) {
    log.warn?.(
      `Guardian: ${ALLOW_WRITABLE_INSTALL_ENV}=1, so the install-integrity check is off. The agent can switch Guardian off by changing the plugin or the OpenClaw config; do not rely on this deployment as tamper-proof.`,
    );
  } else {
    const first = installCheck();
    if (!first.ok) log.warn?.(installProblemMessage(first));
  }

  if (configProblem) {
    log.warn?.(
      `Guardian plugin is not configured: ${configProblem}. Every governed tool call will be blocked.`,
    );
  }

  return async (event, ctx) => {
    const started = now();
    try {
      // Tamper-resistance is a precondition: while the agent could change
      // the plugin or the OpenClaw config, nothing runs and Guardian is
      // not asked.
      const install = installCheck();
      if (!install.ok) return block(installProblemMessage(install));
      const toolName =
        typeof event?.toolName === "string" ? event.toolName : "";
      if (!toolName) {
        return block("Guardian: the tool call had no tool name. Nothing ran.");
      }
      // Snapshot what Guardian evaluates; these exact params are returned.
      const params: Record<string, unknown> =
        event.params && typeof event.params === "object"
          ? structuredClone(event.params)
          : {};
      let call: GovernedCall | null;
      try {
        call = governOpenClawCall({
          toolName,
          params,
          ...(event.derivedPaths ? { derivedPaths: event.derivedPaths } : {}),
          ...(typeof event.toolKind === "string"
            ? { toolKind: event.toolKind }
            : {}),
          controlRoots,
        });
      } catch {
        return block(
          `Guardian: could not read the ${toolName} call. Nothing ran.`,
        );
      }
      // Read-only tool: no opinion; OpenClaw's own policy applies.
      if (call === null) return undefined;

      if (configProblem) {
        return block(`Guardian: ${configProblem}. Nothing ran.`);
      }
      const connectionId = connectionFor(call.toolName, settings);
      if (!connectionId) {
        return block("Guardian: no connection is configured. Nothing ran.");
      }

      const signal = ctx?.abortSignal;
      const deadline = started + budget - DEADLINE_MARGIN_MS;
      const isOver = () => Boolean(signal?.aborted) || now() >= deadline;
      const client = guardedClient(
        options.client ??
          createGuardianClient({
            baseUrl: settings.baseUrl,
            credential: settings.credential!,
            fetch: timedFetch(options.fetch ?? fetch, signal),
          }),
        isOver,
      );
      const agentName = ctx?.agentId
        ? `${settings.agentName} (${ctx.agentId})`
        : settings.agentName;

      const verdict = await decide(call, {
        client,
        connectionId,
        agentName,
        approvalTimeoutMs,
        requestTtlMs: REQUEST_TTL_MS,
        pollIntervalMs: 2_000,
        wait: abortableWait(baseWait, signal),
        now,
        log: (line) => log.info?.(line),
      });
      if (verdict.decision !== "allow") return block(verdict.reason);
      if (isOver()) {
        return block(
          `Guardian: the approval for ${toolName} came too late for OpenClaw's hook timeout. Nothing ran.`,
        );
      }
      log.info?.(`Guardian: ${call.summary} — ${verdict.reason}`);
      return { params };
    } catch {
      // Includes an aborted tool call. Never echo error text: it may carry
      // request details.
      return block("Guardian: the check did not complete. Nothing ran.");
    }
  };
}
