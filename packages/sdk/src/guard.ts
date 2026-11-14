// Generated file — do not edit.
import {
  canonicalJson,
  readToolAmount,
  sha256Text,
  ToolAmountDeclarationSchema,
  type ToolAmountDeclaration,
} from "./contracts/index.js";

import {
  canonicalFileArgsDeclaration,
  normalizeFileArgPreviewRoots,
  normalizeFileArgPreviews,
  normalizeFileArgsSpec,
  carriesReservedKey,
  ContentPinError,
  CONTENT_PIN_KEY_RESERVED,
  CONTENT_PIN_REMOTE_MODE,
  CONTENT_PIN_UNREADABLE,
  pinArguments,
  verifyArguments,
  withoutPins,
  type FileArgsDeclaration,
  type FileArgsSpec,
  type VerifiedArguments,
} from "./content-pins.js";
import type {
  GuardianClient,
  GuardianMcpInvocation,
  GuardianRequestResult,
} from "./client.js";

/**
 * The catalog shape: a record-transport entry has no endpoint —
 * `execute` commits evidence instead of making an HTTP call. Adapters send
 * it through `mcp.install`; an older SDK build without record transport fails local validation
 * first, which the adapter reports as `GuardianRecordTransportRequired`.
 */
type RecordTransportToolDescriptor = Readonly<{
  name: string;
  description?: string;
  transport: "record";
}>;

/**
 * The governed-execution triad, canonical in the core SDK. Every
 * framework adapter (LangChain, Vercel AI, the MCP proxy) and the plain
 * `createGuard` helper share this one implementation: a tool never runs
 * unless Guardian issued a capability for this exact request.
 *
 * Two execution modes:
 *
 * - `remote` (default): the tool is a registered catalog entry — a bounded
 *   HTTPS call Guardian executes itself. `client.execute` IS the execution;
 *   the local `execute`/`func` implementation is never run.
 * - `inProcess` (opt-in): the local implementation is the tool. After ALLOW
 *   the impl runs first, then `client.execute` redeems the capability and
 *   records the evidence — which requires a `transport: "record"` catalog
 *   entry on the connection, registered once in the Guardian console. The
 *   SDK can propose it itself via `mcp.install` (`installRecordTransport:
 *   true`, opt-in), but only while no entry with that name exists yet.
 */

/** Thrown (or returned) when Guardian refuses an action before execution. */
export class GuardianDenied extends Error {
  readonly decision = "DENY" as const;
  readonly toolName: string;
  readonly reasonCode: string;
  readonly requestId: string | undefined;
  /** What the developer can do next. Never changes the decision. */
  readonly hint: string | undefined;

  constructor(args: {
    toolName: string;
    reasonCode: string;
    requestId?: string;
    hint?: string;
  }) {
    super(
      `Guardian denied "${args.toolName}"` +
        ` (reasonCode=${args.reasonCode})` +
        (args.requestId ? ` requestId=${args.requestId}` : "") +
        (args.hint ? `. ${args.hint}` : ""),
    );
    this.name = "GuardianDenied";
    this.toolName = args.toolName;
    this.reasonCode = args.reasonCode;
    this.requestId = args.requestId;
    this.hint = args.hint;
  }
}

/**
 * Actionable next steps for the denials developers hit first.
 * Display only: the decision and reason code are unchanged.
 */
export function denialHint(
  toolName: string,
  reasonCode: string,
  stage: "register" | "invoke",
): string | undefined {
  if (reasonCode === "PLAN_LIMIT_EXCEEDED") {
    return (
      "Your Guardian plan limit is reached: the Free plan's monthly " +
      "protected actions, or the spending cap on a paid plan. Upgrade or " +
      "raise the cap in Settings → Billing, or wait for the next period."
    );
  }
  if (reasonCode === "RATE_LIMITED") {
    return "Guardian is rate limiting this agent. Nothing was run; retry after a short wait.";
  }
  if (stage === "register") {
    return (
      `Guardian did not allow registering "${toolName}" automatically. ` +
      `Register it once in the Guardian console (Connections → tool server → ` +
      `"My own code (record-only)"), allow it for this agent, and pass ` +
      `installRecordTransport: false.`
    );
  }
  if (reasonCode === "INVALID_REQUEST") {
    return (
      `Check that "${toolName}" is registered on this connection and allowed ` +
      `for this agent (Guardian console → Agents → the agent → Tools).`
    );
  }
  return undefined;
}

/**
 * review: why an in-process call is refused when `mcp.install` says
 * the tool may already exist. Display only.
 */
function recordTransportUnverifiedHint(
  toolName: string,
  answer: string,
): string {
  return (
    `Guardian answered ${answer} when asked to register "${toolName}" as a ` +
    `record-only tool, so a tool with that name may already be registered ` +
    `on this connection. Guardian does not tell the SDK whether that entry ` +
    `is record-only. If it makes an HTTP call, your code and Guardian would ` +
    `both perform the action, so nothing ran. Automatic registration only ` +
    `works while no entry with that name exists: a restarted process, ` +
    `another worker or a new context cannot tell an entry the SDK ` +
    `registered earlier from any other. If "${toolName}" is ` +
    `registered in the Guardian console as a record-only tool ("My own ` +
    `code (record-only)") and allowed for this agent, pass ` +
    `installRecordTransport: false (the default). If Guardian should ` +
    `perform the call, ` +
    `use mode: "remote".`
  );
}

/** ALLOW was decided but redeeming the capability failed. */
export class GuardianExecutionFailed extends Error {
  readonly toolName: string;
  readonly requestId: string;
  readonly reasonCode: string;
  /**
   * inProcess only: the local tool already ran before Guardian's final
   * redemption refused it. The effect happened without a recorded receipt;
   * treat it as an incident, never as a successful governed action.
   */
  readonly localEffectRan: boolean;
  /**
   * The execution receipt Guardian returned when the outcome was not
   * verified (`not-sent`, `outcome-pending`, `outcome-unconfirmed`); in
   * inProcess mode, a `not-sent` receipt after the impl ran. Undefined when
   * Guardian refused the redemption itself.
   */
  readonly receipt: unknown;
  /**
   * The action may have happened, but Guardian's answer was lost or did not
   * confirm it (reasonCode `EXECUTION_OUTCOME_UNKNOWN`): the execute reply
   * never arrived, was a 5xx or could not be read, or the receipt is
   * `outcome-pending` / `outcome-unconfirmed`, and looking the request up
   * did not settle it. Do not retry the call: a retry is a new request and
   * may perform the action a second time. Check the requestId first.
   */
  readonly outcomeUnknown: boolean;
  /**
   * For an unknown outcome: what was observed (the client's failure code,
   * such as `SERVICE_UNAVAILABLE`, or the receipt status).
   */
  readonly detail: string | undefined;

  constructor(args: {
    toolName: string;
    requestId: string;
    reasonCode: string;
    localEffectRan?: boolean;
    receipt?: unknown;
    outcomeUnknown?: boolean;
    detail?: string;
  }) {
    super(
      args.outcomeUnknown
        ? `Guardian execution of "${args.toolName}" may have happened; ` +
            `do not retry; check requestId ${args.requestId}` +
            ` (reasonCode=${args.reasonCode}` +
            `${args.detail ? `, detail=${args.detail}` : ""}` +
            `${args.localEffectRan ? ", localEffectRan=true" : ""})`
        : args.localEffectRan
          ? `"${args.toolName}" ran, but Guardian could not record it; ` +
            `do not retry; check requestId ${args.requestId}` +
            ` (reasonCode=${args.reasonCode}, localEffectRan=true)`
          : `Guardian execution of "${args.toolName}" failed` +
            ` (requestId=${args.requestId}, reasonCode=${args.reasonCode})` +
            `${args.detail ? `: ${args.detail}` : ""}`,
    );
    this.name = "GuardianExecutionFailed";
    this.toolName = args.toolName;
    this.requestId = args.requestId;
    this.reasonCode = args.reasonCode;
    this.localEffectRan = args.localEffectRan ?? false;
    this.receipt = args.receipt;
    this.outcomeUnknown = args.outcomeUnknown ?? false;
    this.detail = args.detail;
  }
}

/** Reason code of an execution whose outcome is unknown. */
export const EXECUTION_OUTCOME_UNKNOWN = "EXECUTION_OUTCOME_UNKNOWN";

/**
 * `inProcess` mode needs a record-transport catalog entry on the tool
 * connection so `execute` commits evidence without an HTTP call. Thrown when
 * the auto-install proposal could not even be formed — the SDK/control
 * plane in use predates the `transport: "record"` tool kind.
 */
export class GuardianRecordTransportRequired extends Error {
  readonly toolName: string;

  constructor(args: { toolName: string }) {
    super(
      `Guardian in-process mode for "${args.toolName}" requires a ` +
        `record-transport catalog entry (transport: "record"), which needs ` +
        `the updated Guardian control plane — auto-install was rejected by ` +
        `the client before it reached the network`,
    );
    this.name = "GuardianRecordTransportRequired";
    this.toolName = args.toolName;
  }
}

export type GuardianResume<Output> = () => Promise<{
  requestId: string;
  receipt: unknown;
  output: Output | GuardianDecisionResult;
}>;

/**
 * Guardian held the action for human approval (`ASK`). Carries the requestId
 * the app needs to surface to the approver; `resume()` claims the approved
 * capability, executes it, and finishes the call — never before approval.
 */
export class GuardianApprovalPending<Output = unknown> extends Error {
  readonly decision = "ASK" as const;
  readonly requestId: string;
  readonly toolName: string;
  /**
   * The caller's arguments, without content pins: retrying the call with
   * them pins the files again (and claims this request while they are
   * unchanged).
   */
  readonly input: unknown;
  /**
   * What was proposed to Guardian: `input` plus, for a tool with
   * `fileArgs`, its content pins under `guardianContentPins`.
   */
  readonly proposedInput: unknown;
  readonly #resume: GuardianResume<Output>;

  constructor(
    args: {
      requestId: string;
      toolName: string;
      input: unknown;
      proposedInput?: unknown;
    },
    resume: GuardianResume<Output>,
  ) {
    super(
      `Guardian held "${args.toolName}" for human approval` +
        ` (requestId=${args.requestId})`,
    );
    this.name = "GuardianApprovalPending";
    this.requestId = args.requestId;
    this.toolName = args.toolName;
    this.input = args.input;
    this.proposedInput =
      "proposedInput" in args ? args.proposedInput : args.input;
    this.#resume = resume;
  }

  /** Claim + execute + finish after the human approves. */
  resume() {
    return this.#resume();
  }
}

/**
 * Serializable decision handed back to the model: ASK/DENY when mode is
 * "result", plus the ALLOW receipt a remote-mode call resolves to.
 */
export type GuardianDecisionResult =
  | {
      guardian: {
        decision: "ALLOW";
        requestId: string;
        toolName: string;
        receipt: unknown;
      };
    }
  | {
      guardian: {
        decision: "ASK";
        requestId: string;
        toolName: string;
        message: string;
      };
    }
  | {
      guardian: {
        decision: "DENY";
        toolName: string;
        reasonCode: string;
        requestId?: string;
        message: string;
      };
    };

export type GuardianMode = "throw" | "result";

/**
 * `remote`: the tool name is a registered Guardian catalog entry and the
 * server performs the bounded HTTPS call — the local impl never runs.
 * `inProcess`: the local impl IS the tool; it runs only after the capability
 * is issued and its evidence is recorded via execute afterwards.
 */
export type GuardianToolMode = "remote" | "inProcess";

export type GuardianAdapterOptions = Readonly<{
  client: GuardianClient;
  /** Tool connection id the proposals are authorized against. */
  connectionId: string;
  /** Adapter audience for executes; defaults to the tool adapter. */
  adapterId?: string;
  /** Human label for the agent in audit + default purpose strings. */
  agentName?: string;
  /** Static purpose or per-call purpose shown to approvers. */
  purpose?: string | ((toolName: string, input: unknown) => string);
  /**
   * Execution mode applied to every wrapped tool: "remote" (default) defers
   * execution to the Guardian catalog entry; "inProcess" runs the local
   * implementation and records the evidence. See `modes` for per-tool
   * overrides.
   */
  mode?: GuardianToolMode;
  /** Per-tool-name mode overrides, e.g. `{ refund_order: "remote" }`. */
  modes?: Readonly<Record<string, GuardianToolMode>>;
  /**
   * inProcess only: auto-propose `mcp.install` of a `transport: "record"`
   * catalog entry for each wrapped tool. Default false: register the tool
   * once in the Guardian console as record-only instead. `true` is an
   * opt-in that only works for a tool with no entry yet: the record of
   * which entries the SDK registered lives in this process's memory, so
   * after a restart, in another worker or in a fresh context Guardian's
   * "already registered" answer is refused as RECORD_TRANSPORT_UNVERIFIED
   * and nothing runs (the existing entry may be an HTTP tool), even for an
   * entry the SDK created itself. Such a process must use the
   * console-registered tool with this option off. Opting in
   * requires a control plane with record-transport support — an older SDK raises
   * `GuardianRecordTransportRequired` before any network call.
   */
  installRecordTransport?: boolean;
  /** What ASK does inside the wrapped call. Default "throw". */
  onAsk?: GuardianMode;
  /** What DENY does inside the wrapped call. Default "throw". */
  onDeny?: GuardianMode;
  /**
   * Called with the execution receipt after every ALLOW whose action
   * completed. An error it throws never turns the completed call into a
   * failure (a retry would repeat the action): it goes to `onReceiptError`,
   * or to `console.warn` when that is not set, and the call still returns.
   */
  onReceipt?: (event: {
    toolName: string;
    requestId: string;
    receipt: unknown;
  }) => void | PromiseLike<void>;
  /** Receives an error thrown by `onReceipt`. Its own errors are ignored. */
  onReceiptError?: (
    error: unknown,
    event: { toolName: string; requestId: string; receipt: unknown },
  ) => void;
  /**
   * Per tool: which top-level arguments are local file paths whose bytes
   * are pinned, e.g. `{ send_report: ["attachmentPath"] }`. `bytes` is the
   * default when you don't name a mode: a list of names, or `true` in place
   * of a mode (`{ attachmentPath: true }`), means `bytes`, so the tool
   * receives the verified bytes and there is no gap between the check and
   * the read. Name `"copy"` or `"recheck"` to choose a weaker mode
   * (`{ attachmentPath: "copy" }`).
   * Opt-in preview: `{ attachmentPath: { mode: "bytes", preview: true } }`
   * also puts a preview of the file in its pin, for the person who
   * approves: for a text file its first 20 lines (at most 2,048 bytes), for
   * any other file only its type and size. The preview text leaves your
   * machine and is stored with the approval like any other argument, also
   * when the call is denied; the short forms never send one. The agent
   * picks the path, so without `previewRoots` any file the process can
   * read may be previewed: add `previewRoots: ["/srv/reports"]` to preview
   * only files in those folders (others get a `withheld` preview, size
   * only).
   * Approval binds the exact arguments. A file path is an argument; the
   * file's contents are not, unless the argument is declared here. With
   * `fileArgs`, the SDK on your machine reads the file, puts its SHA-256 in
   * the approved arguments, and checks it again just before the tool runs;
   * Guardian's servers never see the file. A changed file is refused with
   * `CONTENT_CHANGED_SINCE_APPROVAL` and nothing runs. Paths must be
   * absolute (the SDK does not resolve relative paths or `~`). Needs
   * `inProcess` mode; Linux and macOS only (on Windows a declared file
   * argument is refused with `CONTENT_PIN_UNSUPPORTED_PLATFORM`).
   */
  fileArgs?: Readonly<Record<string, FileArgsDeclaration>>;
  /**
   * Per tool: which top-level argument holds the amount the tool charges,
   * exactly as the owner declared it on the tool in the Guardian console,
   * e.g. `{ purchase: { argument: "amount", unit: "minor", currency: "usd" } }`.
   * On each call the SDK sends this declaration with the call and the
   * amount it reads from that argument, and Guardian reads the amount
   * itself and decides on it (allow up to a limit, ask a person above it,
   * block above a maximum). A call whose amount cannot be read is blocked.
   * A tool the owner declared an amount for is blocked unless this matches
   * the console exactly. For a tool that runs in your own process
   * (`inProcess`), the limit applies to Guardian's decision, not to what
   * your code runs.
   */
  amountArgs?: Readonly<Record<string, ToolAmountDeclaration>>;
  /** Per pinned file cap in bytes (default 25 MiB). */
  maxPinBytes?: number;
  /** Cap for all pinned files of one call in bytes (default 64 MiB). */
  maxPinTotalBytes?: number;
}>;

/** Per-wrapper state: which record-transport entries were already ensured. */
export type GuardianContext = {
  options: GuardianAdapterOptions;
  ensured: Set<string>;
  /**
   * @deprecated No longer read: an "already installed" answer to
   * `mcp.install` is now refused before `tool.invoke`. Kept so adapters that
   * still set it compile.
   */
  unconfirmedInstalls?: Set<string>;
  /**
   * Record-transport entries this context installed itself (an
   * `mcp.install` of `transport: "record"` it committed), by
   * connection:tool. Only these are known to be record-only, so the next
   * attempt goes straight to `mcp.enable` instead of proposing the install
   * again (which would be refused as "already installed").
   */
  installed?: Set<string>;
  /**
   * Registration steps (mcp.install / mcp.enable) held for human approval,
   * by connection:tool. A retry of the tool call claims the held request
   * instead of proposing a new one, so the approval the person gave is used.
   */
  heldSetup?: Map<string, { step: SetupStep; requestId: string }>;
  /**
   * `tool.invoke` requests held for human approval, by connection, tool
   * name and a digest of the canonical arguments. A retry of the same call
   * with the same arguments claims the held request instead of proposing a
   * new one, so the approval the person gave is used.
   */
  heldInvocations?: Map<string, string>;
  /**
   * Opt-in: when set, the proposed input (with any content pins) of every
   * `tool.invoke` held for approval, by requestId, so a caller that later
   * settles the held request itself (the MCP proxy's claim) settles exactly
   * what was proposed. The caller deletes an entry once it is used.
   */
  proposedInputs?: Map<string, unknown>;
};

type SetupStep = "install" | "enable";

export function createGuardianContext(
  options: GuardianAdapterOptions,
): GuardianContext {
  assertFileArgsConfig(options);
  const fileArgs = canonicalFileArgs(options.fileArgs);
  const amountArgs = canonicalAmountArgs(options.amountArgs);
  return {
    // Auto-install is opt-in: it only works for an entry that does not exist
    // yet, because `installed` does not survive a restart.
    options: {
      ...options,
      ...(fileArgs === undefined ? {} : { fileArgs }),
      ...(amountArgs === undefined ? {} : { amountArgs }),
      installRecordTransport: options.installRecordTransport ?? false,
    },
    ensured: new Set(),
    installed: new Set(),
    heldSetup: new Map(),
    heldInvocations: new Map(),
  };
}

export function toolModeFor(
  options: GuardianAdapterOptions,
  toolName: string,
): GuardianToolMode {
  return options.modes?.[toolName] ?? options.mode ?? "remote";
}

/**
 * Every tool's file-argument declaration in the full form (each argument
 * with its mode). The short forms mean `bytes`: a list of names
 * (`["attachmentPath"]`) or `true` in place of a mode. Explicit modes are
 * kept. Throws a configuration error for an invalid declaration.
 */
export function normalizeFileArgs(
  fileArgs: GuardianAdapterOptions["fileArgs"],
): Readonly<Record<string, FileArgsSpec>> | undefined {
  if (fileArgs === undefined) return undefined;
  if (
    fileArgs === null ||
    typeof fileArgs !== "object" ||
    Array.isArray(fileArgs)
  ) {
    throw new TypeError("fileArgs must map tool names to declarations");
  }
  const out: Record<string, FileArgsSpec> = {};
  for (const [toolName, declaration] of Object.entries(fileArgs)) {
    const spec = normalizeFileArgsSpec(toolName, declaration);
    if (spec !== undefined) out[toolName] = spec;
  }
  return Object.freeze(out);
}

/**
 * Every tool's declaration in a canonical form that keeps the opt-in
 * preview (`{ mode, preview: true }`); the full form otherwise. What
 * `createGuardianContext` stores, so wrappers still read a mode per
 * argument through `normalizeFileArgsSpec`.
 */
function canonicalFileArgs(
  fileArgs: GuardianAdapterOptions["fileArgs"],
): Readonly<Record<string, FileArgsDeclaration>> | undefined {
  if (fileArgs === undefined) return undefined;
  if (
    fileArgs === null ||
    typeof fileArgs !== "object" ||
    Array.isArray(fileArgs)
  ) {
    throw new TypeError("fileArgs must map tool names to declarations");
  }
  const out: Record<string, FileArgsDeclaration> = {};
  for (const [toolName, declaration] of Object.entries(fileArgs)) {
    const canonical = canonicalFileArgsDeclaration(toolName, declaration);
    if (canonical !== undefined) out[toolName] = canonical;
  }
  return Object.freeze(out);
}

/** The tool's arguments declared with `preview: true` (sorted). */
function fileArgPreviewsFor(
  options: GuardianAdapterOptions,
  toolName: string,
): readonly string[] {
  if (!Object.hasOwn(options.fileArgs ?? {}, toolName)) return [];
  return normalizeFileArgPreviews(toolName, options.fileArgs?.[toolName]);
}

/** The tool's `previewRoots`, per argument that names them. */
function fileArgPreviewRootsFor(
  options: GuardianAdapterOptions,
  toolName: string,
): Readonly<Record<string, readonly string[]>> {
  if (!Object.hasOwn(options.fileArgs ?? {}, toolName)) return {};
  return normalizeFileArgPreviewRoots(toolName, options.fileArgs?.[toolName]);
}

/**
 * The tool's file-argument declaration in the full form, if it declares
 * any argument. The short forms mean `bytes`.
 */
function fileArgsFor(
  options: GuardianAdapterOptions,
  toolName: string,
): FileArgsSpec | undefined {
  if (!Object.hasOwn(options.fileArgs ?? {}, toolName)) return undefined;
  const spec = normalizeFileArgsSpec(toolName, options.fileArgs?.[toolName]);
  return spec !== undefined && Object.keys(spec).length > 0 ? spec : undefined;
}

/**
 * Configuration check for `fileArgs` (wrap time): every declaration names
 * top-level arguments with a known mode, and a tool with file arguments is
 * in-process. In remote mode Guardian performs the call and cannot read
 * the agent's files (CONTENT_PIN_REMOTE_MODE).
 */
function assertFileArgsConfig(
  options: GuardianAdapterOptions,
  only?: string,
): void {
  const all = options.fileArgs;
  if (all === undefined) return;
  if (all === null || typeof all !== "object" || Array.isArray(all)) {
    throw new TypeError("fileArgs must map tool names to declarations");
  }
  for (const [toolName, declaration] of Object.entries(all)) {
    if (only !== undefined && toolName !== only) continue;
    const spec = normalizeFileArgsSpec(toolName, declaration) ?? {};
    if (
      Object.keys(spec).length > 0 &&
      toolModeFor(options, toolName) === "remote"
    ) {
      throw new ContentPinError(
        CONTENT_PIN_REMOTE_MODE,
        `"${toolName}" declares fileArgs but runs in remote mode, where ` +
          `Guardian performs the call and cannot read your files. Use ` +
          `mode: "inProcess" (the LangChain and Vercel AI wrappers default ` +
          `to "remote").`,
      );
    }
  }
}

/**
 * Every tool's amount declaration, checked at wrap time with the
 * same schema Guardian uses. Throws a configuration error for an invalid
 * one, so a typo never reaches a call.
 */
function canonicalAmountArgs(
  amountArgs: GuardianAdapterOptions["amountArgs"],
): Readonly<Record<string, ToolAmountDeclaration>> | undefined {
  if (amountArgs === undefined) return undefined;
  if (
    amountArgs === null ||
    typeof amountArgs !== "object" ||
    Array.isArray(amountArgs)
  ) {
    throw new TypeError("amountArgs must map tool names to declarations");
  }
  const canonical: Record<string, ToolAmountDeclaration> = {};
  for (const [toolName, declaration] of Object.entries(amountArgs)) {
    const parsed = ToolAmountDeclarationSchema.safeParse(declaration);
    if (!parsed.success) {
      throw new TypeError(
        `amountArgs for "${toolName}" is not a valid amount declaration: ` +
          `use { argument, unit: "minor" | "major", currency: "usd" }, ` +
          `optionally with currencyArgument and allowedArguments, exactly ` +
          `as set on the tool in the Guardian console.`,
      );
    }
    canonical[toolName] = parsed.data;
  }
  return canonical;
}

function amountArgsFor(
  options: GuardianAdapterOptions,
  toolName: string,
): ToolAmountDeclaration | undefined {
  return Object.hasOwn(options.amountArgs ?? {}, toolName)
    ? options.amountArgs?.[toolName]
    : undefined;
}

/**
 * What the call sends for a declared amount: the declaration and,
 * when the SDK can read the amount, its value in cents. When it cannot,
 * no amount is sent and Guardian refuses the call (never allowed).
 */
export function amountFacts(
  declaration: ToolAmountDeclaration | undefined,
  args: Record<string, unknown>,
): { amountArgument?: ToolAmountDeclaration; valueCents?: number } {
  if (declaration === undefined) return {};
  const reading = readToolAmount(declaration, args);
  return {
    amountArgument: declaration,
    ...(reading.kind === "money" ? { valueCents: reading.amountMinor } : {}),
  };
}

/**
 * A plain explanation for a call Guardian refused before any
 * decision (INVALID_REQUEST, ACTION_PARAMETERS_INVALID) on a tool with an amount
 * declaration: either the amount could not be read, or this declaration
 * is not the one the owner set in the console.
 */
export function amountRefusalHint(
  toolName: string,
  declaration: ToolAmountDeclaration | undefined,
  args: Record<string, unknown>,
  reasonCode: string | undefined,
): string | undefined {
  // The hosted API answers a request refused before any decision as
  // INVALID_REQUEST; the gateway itself says ACTION_PARAMETERS_INVALID.
  if (
    declaration === undefined ||
    (reasonCode !== "ACTION_PARAMETERS_INVALID" &&
      reasonCode !== "INVALID_REQUEST")
  ) {
    return undefined;
  }
  const reading = readToolAmount(declaration, args);
  if (reading.kind === "refused") {
    const form =
      declaration.unit === "minor"
        ? "a whole number of cents, like 2000 for $20.00"
        : 'dollars as text, like "19.99", or as a whole number of dollars';
    return (
      `Guardian blocked this call to "${toolName}": the amount in its ` +
      `"${declaration.argument}" argument could not be read ` +
      `(${reading.code}). Send the amount as ${form}` +
      (declaration.allowedArguments === undefined
        ? ""
        : `, and only the arguments ${declaration.allowedArguments.join(", ")}`) +
      `. Nothing was run.`
    );
  }
  return (
    `Guardian refused this call to "${toolName}" before deciding. This ` +
    `agent sends the amount declaration ${canonicalJson(declaration)} for ` +
    `it, and Guardian accepts a call only when that equals the declaration ` +
    `the owner set on this tool in the Guardian console (Connections → ` +
    `Dollar amounts). Make amountArgs match the console exactly, and check ` +
    `that "${toolName}" is registered on this connection and allowed for ` +
    `this agent. Nothing was run.`
  );
}

export function toArgumentsRecord(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return input === undefined ? {} : { input };
}

function resolvePurpose(
  options: GuardianAdapterOptions,
  toolName: string,
  input: unknown,
): string {
  if (typeof options.purpose === "function") {
    return options.purpose(toolName, input);
  }
  if (typeof options.purpose === "string") {
    return options.purpose;
  }
  const agent = options.agentName ?? "agent";
  return `${agent} invoked ${toolName}`;
}

/**
 * review: claim answers that are not definitive. Guardian refused
 * the claim for now (unreachable, rate limited, or its database busy) and
 * decided nothing about the request, so a held request stays held and the
 * next retry claims the same request instead of proposing a new one (which
 * would need a second human approval).
 */
const RETRYABLE_CLAIM_REFUSALS = new Set([
  "SERVICE_UNAVAILABLE",
  "RATE_LIMITED",
  "DB_BUSY",
  "HTTP_429",
  "HTTP_503",
]);

function claimNotDefinitive(claimed: {
  ok: boolean;
  reasonCode?: string | undefined;
}): boolean {
  return (
    !claimed.ok &&
    claimed.reasonCode !== undefined &&
    RETRYABLE_CLAIM_REFUSALS.has(claimed.reasonCode)
  );
}

function deny(
  options: GuardianAdapterOptions,
  toolName: string,
  reasonCode: string,
  requestId: string | undefined,
  stage: "register" | "invoke" = "invoke",
  hintOverride?: string,
): GuardianDecisionResult {
  const hint = hintOverride ?? denialHint(toolName, reasonCode, stage);
  if (options.onDeny === "result") {
    return {
      guardian: {
        decision: "DENY",
        toolName,
        reasonCode,
        ...(requestId ? { requestId } : {}),
        message:
          `Guardian denied ${toolName} (${reasonCode}).` +
          (reasonCode === "RATE_LIMITED" || reasonCode === "DB_BUSY"
            ? " It can be retried after a short wait."
            : " Do not retry the same call.") +
          (hint ? ` ${hint}` : ""),
      },
    };
  }
  throw new GuardianDenied({
    toolName,
    reasonCode,
    ...(requestId ? { requestId } : {}),
    ...(hint ? { hint } : {}),
  });
}

function isLocalValidationError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

/**
 * Answers to `mcp.install` that mean "a tool with this name may already be
 * registered". The hosted gateway collapses every mcp.install binding
 * failure (TOOL_ALREADY_INSTALLED included) into ACTION_PARAMETERS_INVALID,
 * reported to the agent as INVALID_REQUEST.
 *
 * review: in-process mode refuses on these. The existing entry may be
 * an HTTP tool, and nothing the agent credential can read (the ALLOW or
 * claim answer, the opaque capability, the execution receipt) says which
 * transport it has. Running the local code and then redeeming an HTTP entry
 * would perform the action twice, so the SDK fails closed instead of going
 * on to `mcp.enable` and `tool.invoke`.
 */
const INSTALL_MAYBE_DONE: readonly string[] = [
  "TOOL_ALREADY_INSTALLED",
  "INVALID_REQUEST",
];

/**
 * Answers to `mcp.enable` that mean "already enabled". Enable is proposed
 * only for an entry this context installed (so it is record transport);
 * `tool.invoke` stays the authority.
 */
const ENABLE_MAYBE_DONE: readonly string[] = [
  "TOOL_ALREADY_ENABLED",
  "INVALID_REQUEST",
];

/**
 * Ensure a `transport: "record"` catalog entry exists for an in-process tool
 * and is enabled for this agent, so a later `execute` commits evidence
 * instead of an HTTP call. Idempotent per connection+tool.
 *
 * - A registration step held for approval earlier (onAsk "result", or a
 *   retry instead of `resume()`) is claimed first, so the approval is used.
 * - Runs only with `installRecordTransport: true` (opt-in).
 * - `mcp.install` proposes the entry. An "already installed" answer
 *   (including the hosted gateway's INVALID_REQUEST) is refused as
 *   RECORD_TRANSPORT_UNVERIFIED before anything runs: the existing entry may
 *   be an HTTP tool. That includes an entry this SDK registered in an
 *   earlier process: `installed` is in memory only. A tool registered in
 *   the console as record-only is used with `installRecordTransport` off
 *   (the default), which skips this step.
 * - After an install this context committed, `mcp.enable` goes through the
 *   same ALLOW/ASK/DENY gate; "already enabled" (or INVALID_REQUEST) counts
 *   as done. `tool.invoke` stays the authority either way.
 */
async function ensureRecordTransport<Output>(
  ctx: GuardianContext,
  toolName: string,
  input: unknown,
  runTool: RunTool<Output>,
): Promise<GuardianDecisionResult | void> {
  const { options } = ctx;
  if (options.installRecordTransport !== true) {
    return;
  }
  const key = `${options.connectionId}:${toolName}`;
  if (ctx.ensured.has(key)) {
    return;
  }
  const held = ctx.heldSetup?.get(key);
  if (held) {
    return claimHeldSetup(ctx, toolName, input, runTool, key, held);
  }
  if (ctx.installed?.has(key)) {
    // This context installed the record entry; only enabling is left.
    return enableRecordTransport(ctx, toolName, input, runTool, key);
  }
  let result: GuardianRequestResult;
  try {
    result = await options.client.request({
      action: "mcp.install",
      connectionId: options.connectionId,
      tool: {
        name: toolName,
        description:
          `In-process tool "${toolName}" — evidence record only ` +
          `(registered by a Guardian framework adapter)`,
        transport: "record",
      } satisfies RecordTransportToolDescriptor as unknown as Extract<
        GuardianMcpInvocation,
        { action: "mcp.install" }
      >["tool"],
      ...(options.adapterId ? { adapterId: options.adapterId } : {}),
      purpose: `Register in-process tool ${toolName} for evidence recording`,
    });
  } catch (err) {
    if (isLocalValidationError(err)) {
      throw new GuardianRecordTransportRequired({ toolName });
    }
    throw err;
  }
  if (!result.ok && INSTALL_MAYBE_DONE.includes(result.reasonCode)) {
    // Fail closed: never run local code for an entry Guardian might perform
    // as an HTTP call. Not remembered, so a retry asks Guardian again.
    return deny(
      options,
      toolName,
      "RECORD_TRANSPORT_UNVERIFIED",
      nonEmpty(result.requestId),
      "register",
      recordTransportUnverifiedHint(toolName, result.reasonCode),
    );
  }
  return governSetupStep(ctx, toolName, input, runTool, result, "install", key);
}

/** Propose `mcp.enable` for the record-transport entry (step two). */
async function enableRecordTransport<Output>(
  ctx: GuardianContext,
  toolName: string,
  input: unknown,
  runTool: RunTool<Output>,
  key: string,
): Promise<GuardianDecisionResult | void> {
  const { options } = ctx;
  const enabled = await options.client.request({
    action: "mcp.enable",
    connectionId: options.connectionId,
    toolName,
    ...(options.adapterId ? { adapterId: options.adapterId } : {}),
    purpose: `Enable in-process tool ${toolName} for this agent`,
  });
  if (!enabled.ok && ENABLE_MAYBE_DONE.includes(enabled.reasonCode)) {
    ctx.ensured.add(key);
    return;
  }
  return governSetupStep(ctx, toolName, input, runTool, enabled, "enable", key);
}

/** The step after `step` once it has executed. */
function afterSetupStep<Output>(
  ctx: GuardianContext,
  toolName: string,
  input: unknown,
  runTool: RunTool<Output>,
  step: SetupStep,
  key: string,
): () => Promise<GuardianDecisionResult | void> {
  if (step === "install") {
    return () => {
      (ctx.installed ??= new Set()).add(key);
      return enableRecordTransport(ctx, toolName, input, runTool, key);
    };
  }
  return async () => {
    ctx.ensured.add(key);
  };
}

function isStillHeld(answer: {
  ok: boolean;
  decision?: unknown;
  reasonCode?: unknown;
}): boolean {
  return answer.ok
    ? answer.decision === "ASK"
    : answer.reasonCode === "APPROVAL_PENDING" ||
        answer.reasonCode === "APPROVAL_REQUIRED";
}

/**
 * A retry of the tool call while a registration step is held: claim that
 * request. Approved → execute it and carry on; still held → ASK again (the
 * same requestId); anything else is a denial. The held entry is cleared only
 * after a definitive answer: an outage, or a claim that throws, keeps it.
 */
async function claimHeldSetup<Output>(
  ctx: GuardianContext,
  toolName: string,
  input: unknown,
  runTool: RunTool<Output>,
  key: string,
  held: { step: SetupStep; requestId: string },
): Promise<GuardianDecisionResult | void> {
  const { options } = ctx;
  const claimed = (await options.client.claim(
    held.requestId,
  )) as GuardianRequestResult;
  if (claimNotDefinitive(claimed)) {
    return deny(
      options,
      toolName,
      claimed.reasonCode ?? "SERVICE_UNAVAILABLE",
      held.requestId,
      "register",
    );
  }
  // Definitive: governSetupStep re-holds it if the claim is still an ASK.
  forgetHeldSetup(ctx, key, held.requestId);
  const answer: GuardianRequestResult = isStillHeld(claimed)
    ? {
        ok: true,
        requestId: held.requestId,
        decision: "ASK",
        reasonCode: claimed.reasonCode ?? "APPROVAL_PENDING",
      }
    : claimed;
  return governSetupStep(ctx, toolName, input, runTool, answer, held.step, key);
}

/** Clear a held setup step, only if it is still this request. */
function forgetHeldSetup(
  ctx: GuardianContext,
  key: string,
  requestId: string,
): void {
  if (ctx.heldSetup?.get(key)?.requestId === requestId) {
    ctx.heldSetup.delete(key);
  }
}

/**
 * One registration step (mcp.install or mcp.enable) through the
 * ALLOW/ASK/DENY gate. ALLOW → execute it, then `next()`. ASK → pending
 * handle whose `resume()` claims + executes the step, runs `next()`, then
 * continues the original tool call end to end. DENY → typed denial.
 * Returns a decision result only when the original call must stop here.
 */
async function governSetupStep<Output>(
  ctx: GuardianContext,
  toolName: string,
  input: unknown,
  runTool: RunTool<Output>,
  proposed: GuardianRequestResult,
  step: SetupStep,
  key: string,
): Promise<GuardianDecisionResult | void> {
  const { options } = ctx;
  const label =
    step === "install"
      ? `Installing the record-transport catalog entry for ${toolName}`
      : `Enabling ${toolName} for this agent`;
  const next = afterSetupStep(ctx, toolName, input, runTool, step, key);
  let result = proposed;
  if (!result.ok) {
    // The gateway reports a held registration as APPROVAL_REQUIRED
    // carrying its requestId — that is an ASK, not a denial.
    const held = result.requestId;
    if (
      result.reasonCode === "APPROVAL_REQUIRED" &&
      typeof held === "string" &&
      held.length > 0
    ) {
      result = {
        ok: true,
        requestId: held,
        decision: "ASK",
        reasonCode: result.reasonCode,
      };
    } else {
      return deny(
        options,
        toolName,
        result.reasonCode,
        nonEmpty(result.requestId),
        "register",
      );
    }
  }
  const commit = async (requestId: string, capabilityToken: string) => {
    const executed = await options.client.execute({
      requestId,
      capabilityToken,
    });
    if (!executed.ok) {
      throw new GuardianExecutionFailed({
        toolName,
        requestId,
        reasonCode: executed.reasonCode,
      });
    }
    return executed.receipt;
  };
  if (result.decision === "ALLOW" && result.capabilityToken) {
    await commit(result.requestId, result.capabilityToken);
    return next();
  }
  if (result.decision === "ASK") {
    const requestId = result.requestId;
    // Remembered so a retry of the tool call claims this request.
    (ctx.heldSetup ??= new Map()).set(key, { step, requestId });
    if (options.onAsk === "result") {
      return {
        guardian: {
          decision: "ASK",
          requestId,
          toolName,
          message:
            `${label} needs human approval (requestId ${requestId}). ` +
            `Retry the tool call after approval.`,
        },
      };
    }
    // resume() claims the step, executes it, runs the next step, then
    // continues the original tool call (propose → triad → impl/receipt).
    const resumeStep = async (): Promise<{
      requestId: string;
      receipt: unknown;
      output: Output | GuardianDecisionResult;
    }> => {
      // The held entry stays until the claim is definitive: an outage (or a
      // claim that throws) leaves it, so a retry claims this same request
      // instead of proposing a new registration step.
      const claimed = await options.client.claim(requestId);
      if (claimNotDefinitive(claimed)) {
        throw new GuardianDenied({
          toolName,
          reasonCode: claimed.reasonCode ?? "SERVICE_UNAVAILABLE",
          requestId,
        });
      }
      if (
        claimed.ok &&
        claimed.decision === "ALLOW" &&
        claimed.capabilityToken
      ) {
        forgetHeldSetup(ctx, key, requestId);
        const receipt = await commit(
          claimed.requestId,
          claimed.capabilityToken,
        );
        const gate = await next();
        const output =
          gate !== undefined
            ? gate
            : await runThroughGuardian(ctx, toolName, input, runTool);
        return { requestId: claimed.requestId, receipt, output };
      }
      // Claimed before the human decided — still held, not denied.
      if (isStillHeld(claimed)) {
        (ctx.heldSetup ??= new Map()).set(key, { step, requestId });
        throw new GuardianApprovalPending(
          { requestId, toolName, input },
          resumeStep,
        );
      }
      forgetHeldSetup(ctx, key, requestId);
      throw new GuardianDenied({
        toolName,
        reasonCode: claimed.ok
          ? (claimed.reasonCode ?? "MISSING_CAPABILITY")
          : claimed.reasonCode,
        requestId: claimed.ok ? claimed.requestId : requestId,
      });
    };
    throw new GuardianApprovalPending(
      { requestId, toolName, input },
      resumeStep,
    );
  }
  return deny(
    options,
    toolName,
    result.reasonCode ?? "MISSING_CAPABILITY",
    result.requestId,
    "register",
  );
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The local tool. It receives its own fresh, unfrozen copy of the input
 * that Guardian was asked to approve (a copy of the frozen snapshot); a
 * runner that ignores it keeps its own reference.
 */
export type RunTool<Output> = (input: unknown) => Output | PromiseLike<Output>;

/**
 * A deep-frozen copy of the call's input. The same copy is proposed to
 * Guardian and exposed as `GuardianApprovalPending.input`, so nothing can
 * change the arguments between approval and execution. The tool runs on its
 * own unfrozen clone of this copy, made just before it runs.
 */
function snapshotInput(toolName: string, input: unknown): unknown {
  let copy: unknown;
  try {
    copy = structuredClone(input);
  } catch {
    throw new TypeError(
      `Guardian could not copy the input of "${toolName}": it must be plain ` +
        `data (structuredClone failed). Nothing was proposed or run.`,
    );
  }
  if (!sameShape(input, copy, new Set())) {
    throw new TypeError(
      `Guardian could not copy the input of "${toolName}" faithfully: it ` +
        `holds a class instance or other non-plain object whose methods a ` +
        `copy would lose. Pass plain data. Nothing was proposed or run.`,
    );
  }
  return deepFreeze(copy);
}

/**
 * True when the copy kept every object's prototype. structuredClone turns a
 * class instance into a plain object, so the impl would fail only after an
 * ALLOW; refuse that before proposing instead.
 */
function sameShape(
  original: unknown,
  copy: unknown,
  seen: Set<object>,
): boolean {
  if (original === null || typeof original !== "object") return true;
  if (seen.has(original)) return true;
  seen.add(original);
  if (
    copy === null ||
    typeof copy !== "object" ||
    Object.getPrototypeOf(original) !== Object.getPrototypeOf(copy)
  ) {
    return false;
  }
  if (original instanceof Map && copy instanceof Map) {
    for (const [key, value] of original) {
      if (!sameShape(value, copy.get(key), seen)) return false;
    }
    return true;
  }
  if (ArrayBuffer.isView(original) || original instanceof Set) return true;
  for (const key of Object.keys(original)) {
    if (
      !sameShape(
        (original as Record<string, unknown>)[key],
        (copy as Record<string, unknown>)[key],
        seen,
      )
    ) {
      return false;
    }
  }
  return true;
}

function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value) ||
    ArrayBuffer.isView(value)
  ) {
    return value;
  }
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return value;
}

/** Key of a held `tool.invoke` request; undefined if it cannot be formed. */
function invocationKey(
  connectionId: string,
  toolName: string,
  input: unknown,
): string | undefined {
  try {
    const digest = sha256Text(canonicalJson(toArgumentsRecord(input)));
    return `${connectionId}:${toolName}:${digest}`;
  } catch {
    return undefined;
  }
}

function forgetHeldInvocation(
  ctx: GuardianContext,
  key: string | undefined,
  requestId: string,
): void {
  if (key !== undefined && ctx.heldInvocations?.get(key) === requestId) {
    ctx.heldInvocations.delete(key);
  }
}

/**
 * Run `onReceipt` for a completed action. Its error is reported on the side
 * and never changes the result: the action already happened.
 */
async function notifyReceipt(
  options: GuardianAdapterOptions,
  event: { toolName: string; requestId: string; receipt: unknown },
): Promise<void> {
  if (options.onReceipt === undefined) {
    return;
  }
  try {
    await options.onReceipt(event);
  } catch (error) {
    try {
      if (options.onReceiptError !== undefined) {
        options.onReceiptError(error, event);
      } else {
        console.warn(
          `Guardian: onReceipt failed for "${event.toolName}" ` +
            `(requestId=${event.requestId}); the action completed and its ` +
            `result was returned.`,
          error,
        );
      }
    } catch {
      // A failing error reporter changes nothing either.
    }
  }
}

/** True when an execute failure may hide a performed action. */
function executeOutcomeUnknown(executed: {
  reasonCode: string;
  outcomeUnknown?: boolean;
}): boolean {
  return (
    executed.outcomeUnknown === true ||
    executed.reasonCode === "SERVICE_UNAVAILABLE" ||
    /^HTTP_(0|5\d\d)$/.test(executed.reasonCode)
  );
}

/**
 * Turn a tool output that is an async iterable (an async generator, as AI
 * SDK streaming tools return) or a generator into its final value. Calling a
 * generator function runs none of its body, so redeeming the capability
 * before it is consumed would record an action that never ran. The output
 * is consumed to completion first; its last value is the result, as AI SDK
 * treats a streaming tool. A throw while consuming propagates and nothing is
 * redeemed, as for any tool that throws.
 */
async function drainIterable(output: unknown): Promise<unknown> {
  if (output === null || typeof output !== "object") {
    return output;
  }
  // Only generator functions (the AI SDK's streaming-tool shape) are run to
  // completion. Streams and other async iterables (a web ReadableStream, a
  // Node Readable) are data, not a tool body: return them unchanged.
  const tag = Object.prototype.toString.call(output);
  if (tag !== "[object AsyncGenerator]" && tag !== "[object Generator]") {
    return output;
  }
  let last: unknown;
  for await (const value of output as AsyncIterable<unknown>) {
    last = value;
  }
  return last;
}

type LookupAnswer =
  | { state: "verified"; receipt: unknown }
  | { state: "not-sent" }
  | { state: "unknown" };

/**
 * After a lost or unconfirmed execute: ask Guardian for the request's
 * recorded attempts. Only a verified attempt or a definitive abort settles
 * it; anything else (none recorded yet, still committing, the lookup
 * failing) stays unknown.
 */
async function lookUpExecution(
  client: GuardianClient,
  requestId: string,
): Promise<LookupAnswer> {
  let answer: Awaited<ReturnType<GuardianClient["receipts"]>> | undefined;
  try {
    answer = await client.receipts(requestId);
  } catch {
    return { state: "unknown" };
  }
  if (answer?.ok !== true || !Array.isArray(answer.receipts)) {
    return { state: "unknown" };
  }
  const records = answer.receipts as readonly {
    state?: unknown;
    attemptId?: unknown;
  }[];
  const verified = records.find((record) => record?.state === "verified");
  if (verified !== undefined) {
    return {
      state: "verified",
      receipt: {
        schemaVersion: 1,
        requestId,
        receiptReference: verified.attemptId,
        status: "sent-verified",
      },
    };
  }
  if (
    records.length > 0 &&
    records.every(
      (record) =>
        record?.state === "aborted" || record?.state === "commit-rejected",
    )
  ) {
    return { state: "not-sent" };
  }
  return { state: "unknown" };
}

/**
 * The triad applied to an already-answered request (request or claim).
 * remote: ALLOW → execute (Guardian performs the call) → receipt is the
 * output; the local impl never runs.
 * inProcess: ALLOW → run the impl → execute redeems + records → impl output.
 * ASK → pending handle; DENY → typed denial.
 *
 * When the execute was sent but its outcome is unknown (no answer, a 5xx,
 * an unreadable answer, or an `outcome-pending` / `outcome-unconfirmed`
 * receipt), the request is looked up first. If that does not settle it,
 * the call throws `GuardianExecutionFailed` with `outcomeUnknown: true` and
 * reasonCode `EXECUTION_OUTCOME_UNKNOWN`: the action may have happened and
 * must not be retried.
 */
export async function settle<Output>(
  ctx: GuardianContext,
  toolName: string,
  input: unknown,
  result: GuardianRequestResult,
  runTool: RunTool<Output>,
): Promise<Output | GuardianDecisionResult> {
  const { options } = ctx;
  const mode = toolModeFor(options, toolName);
  if (!result.ok) {
    // A held ASK arrives as 403 APPROVAL_REQUIRED carrying its requestId
    // (guardian-sdk >= 0.2.0); a claim made before the human decided comes
    // back APPROVAL_PENDING — still held, never a denial. Without a
    // requestId it cannot be resumed, so it fails closed as a denial.
    const heldRequestId = (result as { requestId?: unknown }).requestId;
    if (
      (result.reasonCode === "APPROVAL_REQUIRED" ||
        result.reasonCode === "APPROVAL_PENDING") &&
      typeof heldRequestId === "string" &&
      heldRequestId.length > 0
    ) {
      return settle(
        ctx,
        toolName,
        input,
        {
          ok: true,
          requestId: heldRequestId,
          decision: "ASK",
          reasonCode: result.reasonCode,
        },
        runTool,
      );
    }
    // Keep the server's requestId on a refusal (e.g. NOT_AUTHORIZED
    // for a grant that is off) so the agent can quote it and the operator
    // can find Guardian's record of the denial.
    return deny(
      options,
      toolName,
      result.reasonCode,
      nonEmpty(heldRequestId),
      "invoke",
    );
  }
  if (result.decision === "ALLOW" && result.capabilityToken) {
    const requestId = result.requestId;
    const unknownOutcome = async (
      localEffectRan: boolean,
      detail: string,
      receipt?: unknown,
    ): Promise<unknown> => {
      const found = await lookUpExecution(options.client, requestId);
      if (found.state === "verified") {
        return found.receipt;
      }
      if (found.state === "not-sent") {
        throw new GuardianExecutionFailed({
          toolName,
          requestId,
          reasonCode: localEffectRan ? detail : "EXECUTION_NOT_SENT",
          localEffectRan,
          ...(receipt === undefined ? {} : { receipt }),
        });
      }
      throw new GuardianExecutionFailed({
        toolName,
        requestId,
        reasonCode: EXECUTION_OUTCOME_UNKNOWN,
        localEffectRan,
        outcomeUnknown: true,
        detail,
        ...(receipt === undefined ? {} : { receipt }),
      });
    };
    if (mode === "remote") {
      if (fileArgsFor(options, toolName) !== undefined) {
        // Configuration error caught again here: never redeem a remote call
        // whose declared file arguments Guardian cannot check.
        throw new GuardianExecutionFailed({
          toolName,
          requestId,
          reasonCode: CONTENT_PIN_REMOTE_MODE,
          localEffectRan: false,
        });
      }
      const executed = await options.client.execute({
        requestId,
        capabilityToken: result.capabilityToken,
      });
      let receipt: unknown;
      if (!executed.ok) {
        if (!executeOutcomeUnknown(executed)) {
          throw new GuardianExecutionFailed({
            toolName,
            requestId,
            reasonCode: executed.reasonCode,
          });
        }
        receipt = await unknownOutcome(false, executed.reasonCode);
      } else {
        // Guardian performed the call; only `sent-verified` means the
        // upstream accepted it. `not-sent` is a definitive failure; any
        // other status (`outcome-pending`, `outcome-unconfirmed`) means the
        // action may have happened. Never an ALLOW success handed to the
        // model.
        receipt = executed.receipt;
        const status = (executed.receipt as { status?: unknown }).status;
        if (status === "not-sent") {
          throw new GuardianExecutionFailed({
            toolName,
            requestId,
            reasonCode: "EXECUTION_NOT_SENT",
            receipt: executed.receipt,
          });
        }
        if (status !== "sent-verified") {
          receipt = await unknownOutcome(
            false,
            String(status ?? "unknown"),
            executed.receipt,
          );
        }
      }
      await notifyReceipt(options, { toolName, requestId, receipt });
      return {
        guardian: {
          decision: "ALLOW",
          requestId,
          toolName,
          receipt,
        },
      };
    }
    // inProcess: the local impl runs only after an ALLOW
    // decision, but BEFORE the capability is redeemed. Redemption-time
    // checks (revocation, expiry, single use) therefore land after the
    // effect. This is decision-gated, not pre-execution enforcement; use
    // `remote` mode where Guardian must hold the effect itself.
    // The execution receipt does not say which transport performed it, so
    // the record-transport check cannot happen here, after the impl ran:
    // ensureRecordTransport refuses an entry it did not install, and
    // `installRecordTransport: false` means the developer registered it in
    // the console as record-only.
    // A streaming tool (async generator) runs to completion before the
    // capability is redeemed, so the record never precedes the action.
    // The impl gets its own unfrozen copy of the approved (frozen) input:
    // an impl that mutates its input after its effect keeps working, and
    // nothing outside can reach the object the impl runs on.
    // Content pins: re-read and re-hash every declared file argument just
    // before the tool runs, driven by the tool's `fileArgs` (not by what
    // the input carries). A missing or wrong pin, or a changed file,
    // refuses: the tool does not run and the capability is not redeemed.
    const spec = fileArgsFor(options, toolName);
    let prepared: VerifiedArguments | undefined;
    if (spec !== undefined || carriesReservedKey(input)) {
      try {
        prepared = await verifyArguments(spec ?? {}, input, options);
      } catch (err) {
        throw new GuardianExecutionFailed({
          toolName,
          requestId,
          reasonCode:
            err instanceof ContentPinError
              ? err.reasonCode
              : CONTENT_PIN_UNREADABLE,
          localEffectRan: false,
          ...(err instanceof Error ? { detail: err.message } : {}),
        });
      }
    }
    let output: Output;
    try {
      output = (await drainIterable(
        await runTool(
          prepared !== undefined ? prepared.toolInput : structuredClone(input),
        ),
      )) as Output;
    } finally {
      // A private copy is deleted when the tool settles, also on throw.
      await prepared?.cleanup().catch(() => undefined);
    }
    const executed = await options.client.execute({
      requestId,
      capabilityToken: result.capabilityToken,
    });
    let receipt: unknown;
    if (!executed.ok) {
      if (!executeOutcomeUnknown(executed)) {
        throw new GuardianExecutionFailed({
          toolName,
          requestId,
          reasonCode: executed.reasonCode,
          localEffectRan: true,
        });
      }
      receipt = await unknownOutcome(true, executed.reasonCode);
    } else {
      // The impl already ran. `not-sent` means Guardian did not record it:
      // a definitive failure after the effect (never success).
      // `outcome-pending` / `outcome-unconfirmed` leave the record unknown.
      receipt = executed.receipt;
      const status = (executed.receipt as { status?: unknown }).status;
      if (status === "not-sent") {
        throw new GuardianExecutionFailed({
          toolName,
          requestId,
          reasonCode: "EXECUTION_NOT_SENT",
          localEffectRan: true,
          receipt: executed.receipt,
        });
      }
      if (status === "outcome-pending" || status === "outcome-unconfirmed") {
        receipt = await unknownOutcome(true, status, executed.receipt);
      }
    }
    await notifyReceipt(options, { toolName, requestId, receipt });
    return output;
  }
  if (result.decision === "ASK") {
    const heldKey = invocationKey(options.connectionId, toolName, input);
    if (heldKey !== undefined) {
      // Remembered so a retry with the same arguments claims this request.
      (ctx.heldInvocations ??= new Map()).set(heldKey, result.requestId);
    }
    ctx.proposedInputs?.set(result.requestId, input);
    const resume = async () => {
      const claimed = await options.client.claim(result.requestId);
      if (!claimNotDefinitive(claimed)) {
        // Definitive: settle re-remembers it if it is still held.
        forgetHeldInvocation(ctx, heldKey, result.requestId);
      }
      let receipt: unknown;
      const output = await settle(
        {
          ...ctx,
          options: {
            ...options,
            onReceipt: async (event) => {
              receipt = event.receipt;
              await options.onReceipt?.(event);
            },
          },
        },
        toolName,
        input,
        claimed,
        runTool,
      );
      return { requestId: result.requestId, receipt, output };
    };
    if (options.onAsk === "result") {
      return {
        guardian: {
          decision: "ASK",
          requestId: result.requestId,
          toolName,
          message:
            `Held for human approval (requestId ${result.requestId}). ` +
            `Once a person approves it, call this tool again with exactly ` +
            `the same arguments: Guardian then uses the approved request ` +
            `instead of opening a new one.`,
        },
      };
    }
    throw new GuardianApprovalPending(
      {
        requestId: result.requestId,
        toolName,
        input: withoutPins(input),
        proposedInput: input,
      },
      resume,
    );
  }
  // DENY, or ALLOW with no capability — never run the tool either way.
  const reasonCode = result.reasonCode ?? "MISSING_CAPABILITY";
  return deny(options, toolName, reasonCode, result.requestId, "invoke");
}

/**
 * Ensure the record-transport entry (inProcess), propose, settle. The input
 * is copied and frozen first (the impl later gets its own unfrozen clone); a retry of a call held for approval, with the
 * same arguments, claims the held request instead of proposing a new one.
 */
export async function runThroughGuardian<Output>(
  ctx: GuardianContext,
  toolName: string,
  input: unknown,
  runTool: RunTool<Output>,
): Promise<Output | GuardianDecisionResult> {
  const { options } = ctx;
  const snapshot = snapshotInput(toolName, input);
  // The reserved key is refused for every tool, so an agent cannot supply
  // a pin of its own.
  if (carriesReservedKey(snapshot)) {
    return deny(
      options,
      toolName,
      CONTENT_PIN_KEY_RESERVED,
      undefined,
      "invoke",
      `The argument name "guardianContentPins" is reserved for content pins. Nothing was proposed or run.`,
    );
  }
  assertFileArgsConfig(options, toolName);
  // Pin step: before any request (record transport included), so a refusal
  // sends nothing. The pinned copy is proposed and keys the held retry, so
  // a changed file is a new request needing a new approval.
  let proposed: unknown = snapshot;
  const spec = fileArgsFor(options, toolName);
  if (spec !== undefined) {
    try {
      proposed = deepFreeze(
        await pinArguments(
          spec,
          snapshot,
          options,
          fileArgPreviewsFor(options, toolName),
          fileArgPreviewRootsFor(options, toolName),
        ),
      );
    } catch (err) {
      return deny(
        options,
        toolName,
        err instanceof ContentPinError
          ? err.reasonCode
          : CONTENT_PIN_UNREADABLE,
        undefined,
        "invoke",
        `${err instanceof Error ? err.message : "The file could not be pinned"}. Nothing was proposed or run.`,
      );
    }
  }
  if (toolModeFor(options, toolName) === "inProcess") {
    const gate = await ensureRecordTransport(ctx, toolName, snapshot, runTool);
    if (gate !== undefined) {
      return gate;
    }
  }
  const heldKey = invocationKey(options.connectionId, toolName, proposed);
  const heldRequestId =
    heldKey === undefined ? undefined : ctx.heldInvocations?.get(heldKey);
  if (heldRequestId !== undefined) {
    const claimed = await options.client.claim(heldRequestId);
    if (claimNotDefinitive(claimed)) {
      // Not definitive: keep it held so the next retry claims it again.
      return deny(
        options,
        toolName,
        claimed.reasonCode ?? "SERVICE_UNAVAILABLE",
        heldRequestId,
        "invoke",
      );
    }
    // Definitive: settle remembers it again if it is still held.
    forgetHeldInvocation(ctx, heldKey, heldRequestId);
    // The owner changed the tool's amount declaration since the
    // call was proposed (binding refuses the held request).
    const heldHint = claimed.ok
      ? undefined
      : amountRefusalHint(
          toolName,
          amountArgsFor(options, toolName),
          toArgumentsRecord(proposed),
          claimed.reasonCode,
        );
    if (heldHint !== undefined) {
      return deny(
        options,
        toolName,
        claimed.reasonCode ?? "ACTION_PARAMETERS_INVALID",
        heldRequestId,
        "invoke",
        heldHint,
      );
    }
    const answer: GuardianRequestResult = isStillHeld(claimed)
      ? {
          ok: true,
          requestId: heldRequestId,
          decision: "ASK",
          reasonCode: claimed.reasonCode ?? "APPROVAL_PENDING",
        }
      : claimed.ok
        ? claimed
        : { ...claimed, requestId: claimed.requestId ?? heldRequestId };
    return settle(ctx, toolName, proposed, answer, runTool);
  }
  const args = toArgumentsRecord(proposed);
  const declaration = amountArgsFor(options, toolName);
  const result = await options.client.request({
    action: "tool.invoke",
    connectionId: options.connectionId,
    toolName,
    arguments: args,
    ...amountFacts(declaration, args),
    ...(options.adapterId ? { adapterId: options.adapterId } : {}),
    purpose: resolvePurpose(options, toolName, snapshot),
  });
  const hint = result.ok
    ? undefined
    : amountRefusalHint(toolName, declaration, args, result.reasonCode);
  if (!result.ok && hint !== undefined) {
    return deny(
      options,
      toolName,
      result.reasonCode,
      result.requestId,
      "invoke",
      hint,
    );
  }
  return settle(ctx, toolName, proposed, result, runTool);
}

/**
 * Options for `createGuard`. Same as the adapter options except the
 * default mode is `inProcess`: a guarded function is the developer's own
 * action code, so it runs only after ALLOW and its evidence is recorded.
 */
export type GuardOptions = GuardianAdapterOptions;

/** A guarded function: same input, resolves to the impl output (or a decision result in "result" mode). */
export type GuardedFunction<Input, Output> = (
  input: Input,
) => Promise<Output | GuardianDecisionResult>;

export type Guard = <Input, Output>(
  toolName: string,
  impl: (input: Input) => Output | PromiseLike<Output>,
) => GuardedFunction<Input, Output>;

/**
 * Put Guardian in front of any action code, from any agent
 * framework.
 *
 * ```ts
 * const guard = createGuard({ client, connectionId: "con_…" });
 * const payInvoice = guard("pay_invoice", async (inv: Invoice) => stripe.paymentIntents.create(…));
 * await payInvoice({ invoiceId: "inv_42", amountCents: 1_240_000, payee: "acme" });
 * // ALLOW → your code runs, receipt recorded. ASK → GuardianApprovalPending (resume() after approval).
 * // DENY → GuardianDenied; your code never runs.
 * ```
 *
 * In-process mode is decision-gated: your code runs after ALLOW and before
 * the capability is redeemed, so redemption-time revocation lands after the
 * effect (reported as `GuardianExecutionFailed` with `localEffectRan`). Use
 * `mode: "remote"` with a registered catalog tool where Guardian itself must
 * hold the effect.
 */
export function createGuard(options: GuardOptions): Guard {
  // Production denies first-use auto-registration unless the grant
  // pins mcp.install, so createGuard expects the tool to be registered once
  // in the console (record-only). installRecordTransport: true opts in, for
  // a tool with no entry yet (createGuardianContext's default is off too).
  const ctx = createGuardianContext({
    ...options,
    mode: options.mode ?? "inProcess",
  });
  return <Input, Output>(
      toolName: string,
      impl: (input: Input) => Output | PromiseLike<Output>,
    ): GuardedFunction<Input, Output> =>
    (input: Input) =>
      runThroughGuardian<Output>(ctx, toolName, input, (approved) =>
        impl(approved as Input),
      );
}

/** One-off form of `createGuard(options)(toolName, impl)`. */
export function guard<Input, Output>(
  options: GuardOptions,
  toolName: string,
  impl: (input: Input) => Output | PromiseLike<Output>,
): GuardedFunction<Input, Output> {
  return createGuard(options)(toolName, impl);
}
