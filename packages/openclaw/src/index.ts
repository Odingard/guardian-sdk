/**
 * @odingard/guardian-openclaw: a native OpenClaw plugin that puts Guardian
 * in front of every consequential tool call the agent makes.
 *
 *   openclaw plugins install @odingard/guardian-openclaw
 *   openclaw plugins enable guardian
 *
 * It registers one typed hook, `api.on("before_tool_call", ...)`, with no
 * matcher, so it sees every tool: exec, process, write, edit, apply_patch,
 * web_fetch, browser, message, sessions_spawn, cron, gateway, MCP tools
 * (`server__tool`, e.g. Composio's) and tools added by other plugins.
 * Read-only tools (read, web_search, ...) are left to OpenClaw.
 *
 * Configuration:
 *   Gateway environment (secret, never in openclaw.json):
 *     GUARDIAN_AGENT_CREDENTIAL   the agent credential from the Guardian console
 *   plugins.entries.guardian.config (or the env names in brackets):
 *     connectionId     [GUARDIAN_CONNECTION_ID]           everyday tools (Allow)
 *     askConnectionId  [GUARDIAN_HOOK_ASK_CONNECTION_ID]  deploys, destructive,
 *                      pushes, messages, MCP and other tools (Ask)
 *     baseUrl          [GUARDIAN_BASE_URL]  default https://guardian-api.odingard.com
 *     agentName        [GUARDIAN_HOOK_AGENT_NAME]  label approvers see
 *     approvalTimeoutMs  how long an ASK waits (max and default 300000)
 *     allowTierTools   extra Guardian tool names for the everyday connection
 *   plugins.entries.guardian.hooks.timeouts.before_tool_call: 330000
 *
 * Tamper-resistance is a deployment precondition: while the OpenClaw process
 * user can change this plugin, the OpenClaw config, <state>/extensions,
 * <state>/npm, <state>/hooks or a start-up .env, every tool call is blocked
 * (see README "Required: protect the install").
 * GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL=1 in the Gateway's start-up
 * environment turns that off, and with it any tamper-proof claim.
 *
 * GUARDIAN_* settings are honoured only from the Gateway's real start-up
 * environment: a key named in the Gateway working directory's .env (which
 * OpenClaw loads without filtering GUARDIAN_*) is ignored.
 *
 * Fails closed: if Guardian cannot confirm a governed call, it is blocked.
 */
import {
  createGuardianToolHandler,
  HOOK_PRIORITY,
  HOOK_TIMEOUT_MS,
  OPENCLAW_MAX_HOOK_TIMEOUT_MS,
  PLUGIN_ID,
  type GuardianPluginConfig,
  type Logger,
} from "./plugin.js";

export * from "./plugin.js";
export {
  governOpenClawCall,
  openclawToolName,
  patchPaths,
  READ_ONLY_TOOLS,
} from "./classify.js";
export {
  ALLOW_WRITABLE_INSTALL_ENV,
  checkInstallIntegrity,
  externalSpecifiers,
  findPluginDir,
  guardianStartupEnv,
  importSpecifiers,
  INSTALL_CHECK_CACHE_MS,
  installProblemMessage,
  nodeModulesLookup,
  openclawConfigCandidates,
  openclawConfigDir,
  openclawDotEnvFiles,
  openclawStateDir,
  workspaceDotEnvGuardianKeys,
  type InstallCheckOptions,
  type InstallCheckResult,
} from "./integrity.js";
import { workspaceDotEnvGuardianKeys } from "./integrity.js";

/**
 * The credential is read from the Gateway's environment once and then
 * removed from `process.env`, so commands the agent runs with `exec` (child
 * processes of the Gateway) do not inherit it. It is kept on a symbol of
 * this process so a plugin reload can still find it. A credential that may
 * have come from the working directory's .env (`ignore`) is removed but not
 * kept.
 */
const CREDENTIAL_SLOT = Symbol.for("odingard.guardian-openclaw.credential");
const SCRUBBED_ENV = ["GUARDIAN_AGENT_CREDENTIAL"] as const;

export function takeCredential(
  env: Record<string, string | undefined> = process.env,
  slot: Record<symbol, unknown> = globalThis as Record<symbol, unknown>,
  ignore = false,
): string | undefined {
  const fromEnv = env.GUARDIAN_AGENT_CREDENTIAL?.trim();
  if (fromEnv && !ignore) slot[CREDENTIAL_SLOT] = fromEnv;
  for (const name of SCRUBBED_ENV) delete env[name];
  const kept = slot[CREDENTIAL_SLOT];
  return typeof kept === "string" && kept ? kept : undefined;
}

type HookBudgetConfig = {
  plugins?: {
    entries?: Record<
      string,
      { hooks?: { timeoutMs?: unknown; timeouts?: Record<string, unknown> } }
    >;
  };
};

const positive = (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v > 0
    ? Math.min(v, OPENCLAW_MAX_HOOK_TIMEOUT_MS)
    : undefined;

/**
 * The budget OpenClaw will really give the handler: an operator's
 * `hooks.timeouts.before_tool_call` beats `hooks.timeoutMs`, which beats the
 * plugin's own `timeoutMs` (OpenClaw's documented precedence).
 */
export function effectiveHookTimeoutMs(
  config: unknown,
  pluginId: string = PLUGIN_ID,
): number {
  const hooks = (config as HookBudgetConfig | undefined)?.plugins?.entries?.[
    pluginId
  ]?.hooks;
  return (
    positive(hooks?.timeouts?.before_tool_call) ??
    positive(hooks?.timeoutMs) ??
    HOOK_TIMEOUT_MS
  );
}

/** The subset of OpenClaw's plugin API this plugin uses. */
export type OpenClawPluginApiLike = {
  id?: string;
  config?: unknown;
  pluginConfig?: Record<string, unknown>;
  logger?: Logger;
  on: (
    hookName: "before_tool_call",
    handler: ReturnType<typeof createGuardianToolHandler>,
    opts?: { priority?: number; timeoutMs?: number },
  ) => void;
};

export function register(
  api: OpenClawPluginApiLike,
  /** Tests: the Gateway's working directory and environment. */
  host: { cwd?: string; env?: Record<string, string | undefined> } = {},
): void {
  if (typeof api?.on !== "function") return;
  const cwd = host.cwd ?? process.cwd();
  const processEnv = host.env ?? process.env;
  const untrusted = workspaceDotEnvGuardianKeys(cwd);
  const credential = takeCredential(
    processEnv,
    undefined,
    untrusted.has("GUARDIAN_AGENT_CREDENTIAL"),
  );
  // The handler drops (and logs) every GUARDIAN_* key named in <cwd>/.env.
  const env = { ...processEnv, GUARDIAN_AGENT_CREDENTIAL: credential };
  const hookTimeoutMs = effectiveHookTimeoutMs(api.config, api.id ?? PLUGIN_ID);
  const handler = createGuardianToolHandler({
    config: (api.pluginConfig ?? {}) as GuardianPluginConfig,
    env,
    hookTimeoutMs,
    install: { cwd },
    ...(api.logger ? { logger: api.logger } : {}),
  });
  api.on("before_tool_call", handler, {
    priority: HOOK_PRIORITY,
    timeoutMs: HOOK_TIMEOUT_MS,
  });
}

/**
 * OpenClaw accepts a plain definition object as the module's default export
 * (the same shape `definePluginEntry` returns), so the plugin does not need
 * openclaw itself at runtime. The JSON schema matches openclaw.plugin.json.
 */
const plugin = {
  id: PLUGIN_ID,
  name: "Guardian",
  description:
    "Sends every consequential tool call to Guardian for an ALLOW / ASK / DENY decision before it runs. Fails closed.",
  register,
};

export default plugin;
