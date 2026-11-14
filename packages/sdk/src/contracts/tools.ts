// Generated file — do not edit.
import { z } from "zod";

import {
  apiEndpointWithinAllowlist,
  ApiRequestMethodSchema,
  ApiRequestUrlSchema,
  type ApiRequestParametersV1,
} from "./api.js";
import { canonicalJson } from "./canonical-json.js";
import { sha256Text } from "./digest.js";
import { ConnectionIdSchema } from "./identifiers.js";

/**
 * Tool / MCP authority surface.
 *
 * A "tool" is a named, human-installed entry in a tool server's catalog. Each
 * entry renders to a bounded https call inside the owning connection's
 * endpoint allowlist — the same transport surface as api.request,
 * with tool semantics layered on top by the action registry.
 *
 * `mcp.install` and `mcp.enable` are capability-expansion actions: they are
 * registered so proposals resolve through the same deterministic decision
 * path, but `requiresExplicitGrant` keeps them out of auto-derived grants.
 * An agent can only ever receive them when a human selects them explicitly —
 * self-serve escalation deterministically denies.
 */

export const TOOL_NAME_MAX_LENGTH = 64;
export const TOOL_ARGUMENTS_MAX_BYTES = 16_384;
export const TOOL_CATALOG_MAX_TOOLS = 64;
export const TOOL_SERVER_NAME_MAX_LENGTH = 128;
export const TOOL_SERVER_VERSION_MAX_LENGTH = 64;
export const TOOL_DESCRIPTION_MAX_LENGTH = 512;

export const ToolNameSchema = z
  .string()
  .min(1)
  .max(TOOL_NAME_MAX_LENGTH)
  .regex(
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
    "tool names are lowercase dotted/dashed identifiers",
  );
export type ToolName = z.infer<typeof ToolNameSchema>;

/**
 * The owner's statement of which argument of a tool holds the
 * amount it charges. Names are top-level argument names only (no dots,
 * paths or pointers), as fileArgs uses. Set on a catalog entry by the
 * owner only; the agent's integration echoes it on tool.invoke as
 * `amountArgument`, and binding requires the echo to equal the catalog.
 */
export const TOOL_ARGUMENT_NAME_MAX_LENGTH = 64;
export const TOOL_ALLOWED_ARGUMENTS_MAX = 64;
/** Currencies a tool amount may be in (minor units of US dollars only). */
export const TOOL_AMOUNT_CURRENCIES: readonly string[] = ["usd"];

export const ToolArgumentNameSchema = z
  .string()
  .min(1)
  .max(TOOL_ARGUMENT_NAME_MAX_LENGTH)
  .refine(
    (name) =>
      !/[./[\]]/.test(name) &&
      ![...name].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      }),
    "argument names are top-level names (no dots, paths or pointers)",
  )
  .refine((name) => name !== "__proto__", "argument name is reserved");

export const ToolAmountDeclarationSchema = z
  .object({
    argument: ToolArgumentNameSchema,
    unit: z.enum(["minor", "major"]),
    currency: z.literal("usd"),
    currencyArgument: ToolArgumentNameSchema.optional(),
    allowedArguments: z
      .array(ToolArgumentNameSchema)
      .min(1)
      .max(TOOL_ALLOWED_ARGUMENTS_MAX)
      .optional(),
  })
  .strict()
  .refine(
    (declaration) => declaration.currencyArgument !== declaration.argument,
    "the currency argument must differ from the amount argument",
  )
  .refine(
    (declaration) =>
      declaration.allowedArguments === undefined ||
      new Set(declaration.allowedArguments).size ===
        declaration.allowedArguments.length,
    "allowedArguments must be distinct",
  )
  .refine(
    (declaration) =>
      declaration.allowedArguments === undefined ||
      (declaration.allowedArguments.includes(declaration.argument) &&
        (declaration.currencyArgument === undefined ||
          declaration.allowedArguments.includes(declaration.currencyArgument))),
    "allowedArguments must include the amount and currency arguments",
  );
export type ToolAmountDeclaration = z.infer<typeof ToolAmountDeclarationSchema>;

/** A catalog entry: a named tool that renders to one allowlisted https call. */
export const ToolHttpDescriptorSchema = z
  .object({
    name: ToolNameSchema,
    description: z.string().max(TOOL_DESCRIPTION_MAX_LENGTH).optional(),
    transport: z.literal("http").optional(),
    method: ApiRequestMethodSchema,
    url: ApiRequestUrlSchema,
    amount: ToolAmountDeclarationSchema.optional(),
  })
  .strict();
export type ToolHttpDescriptor = z.infer<typeof ToolHttpDescriptorSchema>;

/**
 * A `record` catalog entry: the tool's implementation lives
 * in-host inside the tool-server runtime (framework adapters — Vercel AI,
 * LangChain — register the impl host-side). There is no URL: the invocation
 * never leaves the host, so no endpoint-allowlist leg exists. The governed
 * flow is propose → ALLOW → local run → redeem+record → receipt; the impl
 * runs exactly once, at commit, never before the decision and never again
 * on a failed execute.
 */
export const ToolRecordDescriptorSchema = z
  .object({
    name: ToolNameSchema,
    description: z.string().max(TOOL_DESCRIPTION_MAX_LENGTH).optional(),
    transport: z.literal("record"),
    amount: ToolAmountDeclarationSchema.optional(),
  })
  .strict();
export type ToolRecordDescriptor = z.infer<typeof ToolRecordDescriptorSchema>;

export const ToolDescriptorSchema = z.union([
  ToolRecordDescriptorSchema,
  ToolHttpDescriptorSchema,
]);
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

/** The tool-server catalog stored on a provider "tool" connection record. */
export const ToolServerCatalogSchema = z
  .object({
    serverName: z.string().min(1).max(TOOL_SERVER_NAME_MAX_LENGTH),
    serverVersion: z.string().min(1).max(TOOL_SERVER_VERSION_MAX_LENGTH),
    tools: z
      .array(ToolDescriptorSchema)
      .max(TOOL_CATALOG_MAX_TOOLS)
      .refine(
        (tools) =>
          new Set(tools.map((tool) => tool.name)).size === tools.length,
        "tool names must be unique within a catalog",
      ),
  })
  .strict();
export type ToolServerCatalog = z.infer<typeof ToolServerCatalogSchema>;

/** Bounded canonical JSON object (cycles, prototypes and depth are rejected). */
export const ToolArgumentsSchema = z.record(z.string(), z.unknown()).refine(
  (value) => {
    try {
      return canonicalJson(value).length <= TOOL_ARGUMENTS_MAX_BYTES;
    } catch {
      return false;
    }
  },
  {
    message:
      "arguments must be a bounded canonical JSON object (no cycles, accessors, or exotic prototypes)",
  },
);
export type ToolArguments = z.infer<typeof ToolArgumentsSchema>;

export const ToolInvokeParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.tool.invoke.v1"),
    connectionId: ConnectionIdSchema,
    toolName: ToolNameSchema,
    arguments: ToolArgumentsSchema,
    /** The echo of the catalog entry's amount declaration. */
    amountArgument: ToolAmountDeclarationSchema.optional(),
  })
  .strict();
export type ToolInvokeParametersV1 = z.infer<
  typeof ToolInvokeParametersV1Schema
>;

/**
 * mcp.install registers an additional catalog entry on an existing, human-
 * installed tool-server connection. It can never create a new connection or
 * widen the endpoint allowlist — both stay human-only.
 */
export const McpInstallParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.mcp.install.v1"),
    connectionId: ConnectionIdSchema,
    tool: ToolDescriptorSchema,
  })
  .strict();
export type McpInstallParametersV1 = z.infer<
  typeof McpInstallParametersV1Schema
>;

/** mcp.enable enables a catalog tool for the requesting agent. */
export const McpEnableParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.mcp.enable.v1"),
    connectionId: ConnectionIdSchema,
    toolName: ToolNameSchema,
  })
  .strict();
export type McpEnableParametersV1 = z.infer<typeof McpEnableParametersV1Schema>;

export type ToolAmountRefusal =
  | "AMOUNT_MISSING"
  | "AMOUNT_INVALID"
  | "CURRENCY_MISSING"
  | "CURRENCY_NOT_ALLOWED"
  | "AMOUNT_ARGUMENT_NOT_ALLOWED";

export type ToolAmountReading =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "money"; amountMinor: number; currency: "usd" }>
  | Readonly<{ kind: "refused"; code: ToolAmountRefusal }>;

/** Minor units as text, as api.request reads them. */
const TOOL_MINOR_UNITS = /^(0|[1-9][0-9]{0,15})$/;
/** Whole dollars with up to two decimals, as text. */
const TOOL_MAJOR_UNITS = /^(0|[1-9][0-9]{0,12})(?:\.([0-9]{1,2}))?$/;

/**
 * content pins: the reserved argument under which the SDK adds the
 * digest of each pinned file argument to a call, and the shape of one pin.
 * The one pin validator, shared by the SDK's execute-time re-check
 * (packages/sdk content-pins.ts) and readToolAmount's allowedArguments
 * check.
 */
export const CONTENT_PINS_ARGUMENT = "guardianContentPins";
/** At most this many pins per call. */
export const CONTENT_PINS_MAX = 16;
/** The modes a pinned file argument may be declared with. */
export const CONTENT_PIN_MODES: ReadonlySet<string> = new Set([
  "bytes",
  "copy",
  "recheck",
]);
const CONTENT_PIN_SHA256 = /^sha256:[0-9a-f]{64}$/;

export type ContentPinRecord = Readonly<{
  arg: string;
  index: number;
  mode: "bytes" | "copy" | "recheck";
  size: number;
  sha256: string;
}>;

/** True for one well-formed pin (other fields, e.g. a preview, are display data). */
export function isContentPinRecord(value: unknown): value is ContentPinRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const pin = value as Record<string, unknown>;
  return (
    typeof pin.arg === "string" &&
    typeof pin.index === "number" &&
    Number.isInteger(pin.index) &&
    pin.index >= 0 &&
    typeof pin.mode === "string" &&
    CONTENT_PIN_MODES.has(pin.mode) &&
    typeof pin.size === "number" &&
    Number.isInteger(pin.size) &&
    pin.size >= 0 &&
    typeof pin.sha256 === "string" &&
    CONTENT_PIN_SHA256.test(pin.sha256)
  );
}

/**
 * Whether the reserved content-pin argument
 * may pass allowedArguments. Only valid pin metadata qualifies: a list of
 * 1 to CONTENT_PINS_MAX well-formed pins, each for a listed argument the
 * call carries. It never admits any other extra argument, and it does not
 * check the files: the SDK re-checks every pin before the tool runs.
 */
function contentPinsWithin(
  value: unknown,
  allowed: readonly string[],
  args: ToolArguments,
): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= CONTENT_PINS_MAX &&
    value.every(
      (pin) =>
        isContentPinRecord(pin) &&
        pin.arg !== CONTENT_PINS_ARGUMENT &&
        allowed.includes(pin.arg) &&
        Object.prototype.hasOwnProperty.call(args, pin.arg),
    )
  );
}

function ownValue(args: ToolArguments, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(args, name)
    ? args[name]
    : undefined;
}

/**
 * The one reader of a tool call's amount, shared by tool.invoke's
 * parameter gate and authority facts and by the SDK. Reads only
 * `args[declaration.argument]` (top level, own property). Anything it
 * cannot read exactly is refused, never read as zero: no sign, `$`,
 * commas, spaces or exponent, and dollars are read by text arithmetic,
 * never floating point. Without a declaration there is no amount.
 */
export function readToolAmount(
  declaration: ToolAmountDeclaration | undefined,
  args: ToolArguments,
): ToolAmountReading {
  if (declaration === undefined) return { kind: "none" };
  const refuse = (code: ToolAmountRefusal): ToolAmountReading => ({
    kind: "refused",
    code,
  });
  if (
    declaration.allowedArguments !== undefined &&
    Object.keys(args).some(
      (name) =>
        !declaration.allowedArguments!.includes(name) &&
        !(
          name === CONTENT_PINS_ARGUMENT &&
          contentPinsWithin(args[name], declaration.allowedArguments!, args)
        ),
    )
  ) {
    return refuse("AMOUNT_ARGUMENT_NOT_ALLOWED");
  }
  const raw = ownValue(args, declaration.argument);
  if (raw === undefined || raw === null) return refuse("AMOUNT_MISSING");
  let amountMinor: number;
  if (declaration.unit === "minor") {
    if (typeof raw === "number") {
      if (!Number.isSafeInteger(raw) || raw < 0) {
        return refuse("AMOUNT_INVALID");
      }
      amountMinor = raw === 0 ? 0 : raw;
    } else if (typeof raw === "string") {
      if (!TOOL_MINOR_UNITS.test(raw)) return refuse("AMOUNT_INVALID");
      amountMinor = Number(raw);
    } else {
      return refuse("AMOUNT_INVALID");
    }
  } else if (typeof raw === "number") {
    if (
      !Number.isSafeInteger(raw) ||
      raw < 0 ||
      !Number.isSafeInteger(raw * 100)
    ) {
      return refuse("AMOUNT_INVALID");
    }
    amountMinor = raw === 0 ? 0 : raw * 100;
  } else if (typeof raw === "string") {
    const match = TOOL_MAJOR_UNITS.exec(raw);
    if (match === null) return refuse("AMOUNT_INVALID");
    const whole = Number(match[1]);
    const cents = Number((match[2] ?? "").padEnd(2, "0"));
    amountMinor = whole * 100 + cents;
  } else {
    return refuse("AMOUNT_INVALID");
  }
  if (!Number.isSafeInteger(amountMinor)) return refuse("AMOUNT_INVALID");
  if (declaration.currencyArgument !== undefined) {
    const currency = ownValue(args, declaration.currencyArgument);
    if (currency === undefined || currency === null) {
      return refuse("CURRENCY_MISSING");
    }
    if (
      typeof currency !== "string" ||
      !TOOL_AMOUNT_CURRENCIES.includes(currency.toLowerCase())
    ) {
      return refuse("CURRENCY_NOT_ALLOWED");
    }
  }
  return { kind: "money", amountMinor, currency: "usd" };
}

function sameAmountDeclaration(
  left: ToolAmountDeclaration | undefined,
  right: ToolAmountDeclaration | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === undefined && right === undefined;
  }
  return canonicalJson(left) === canonicalJson(right);
}

/** Methods whose rendered call carries no body (no arguments are sent). */
const TOOL_NO_BODY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * Whether a call's arguments reach the tool: a record tool runs in-host
 * with them, an http tool sends them as the JSON body, except GET and HEAD,
 * which render no body (renderToolInvocation).
 */
export function toolReceivesArguments(tool: ToolDescriptor): boolean {
  return tool.transport === "record" || !TOOL_NO_BODY_METHODS.has(tool.method);
}

/**
 * An amount declaration binds the amount the
 * tool receives, so it is accepted only on a tool whose arguments reach it.
 * On a GET or HEAD tool the endpoint never sees the approved amount, and a
 * charging endpoint could exceed the cap. Owner paths refuse such a
 * declaration and binding refuses the call (TOOL_AMOUNT_NOT_SENT).
 */
export function toolAmountSendable(tool: ToolDescriptor): boolean {
  return tool.amount === undefined || toolReceivesArguments(tool);
}

/**
 * Renders an invocation to the canonical api.request envelope the adapter
 * executes: the catalog method/url plus the arguments as a JSON body. Shared
 * by the binding check and the execution adapter so both see one rendering.
 */
export function renderToolInvocation(
  tool: ToolDescriptor,
  args: ToolArguments,
): Omit<ApiRequestParametersV1, "schema" | "connectionId"> {
  const parsedTool = ToolHttpDescriptorSchema.parse(tool);
  const body = canonicalJson(ToolArgumentsSchema.parse(args));
  return {
    method: parsedTool.method,
    url: parsedTool.url,
    headers: [{ name: "content-type", value: "application/json" }],
    ...(toolReceivesArguments(parsedTool) ? { body } : {}),
  };
}

export function toolVerificationProjection(input: ToolInvokeParametersV1) {
  const params = ToolInvokeParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.tool-invoke-projection.v1" as const,
    connectionId: params.connectionId,
    toolName: params.toolName,
    argumentsDigest: sha256Text(canonicalJson(params.arguments)),
  });
}

/** Same single verification level as api.request (post-commit-content). */
export function toolEnvelopeProjection(input: ToolInvokeParametersV1) {
  return toolVerificationProjection(input);
}

export function mcpInstallProjection(input: McpInstallParametersV1) {
  const params = McpInstallParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.mcp-projection.v1" as const,
    operation: "install" as const,
    connectionId: params.connectionId,
    toolName: params.tool.name,
    descriptorDigest: sha256Text(canonicalJson(params.tool)),
  });
}

export function mcpEnableProjection(input: McpEnableParametersV1) {
  const params = McpEnableParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.mcp-projection.v1" as const,
    operation: "enable" as const,
    connectionId: params.connectionId,
    toolName: params.toolName,
    descriptorDigest: null,
  });
}

export function findCatalogTool(
  connection: {
    toolServer?: { tools: readonly { name: string }[] };
  },
  toolName: string,
) {
  return connection.toolServer?.tools.find((tool) => tool.name === toolName);
}

/**
 * Binding hooks shared by the three tool/MCP definitions. `connection` is the
 * kernel-verified binding facts (catalog + per-agent enabled names).
 */
export function validateToolInvokeBinding(input: {
  params: ToolInvokeParametersV1;
  connection: {
    toolServer?: { tools: readonly ToolDescriptor[] };
    enabledToolNames?: readonly string[];
    endpointAllowlist?: readonly string[];
  };
}): { ok: true } | { ok: false; reasonCode: string } {
  const tool = findCatalogTool(input.connection, input.params.toolName);
  if (tool === undefined) {
    return { ok: false, reasonCode: "TOOL_NOT_IN_CATALOG" };
  }
  if (
    input.connection.enabledToolNames !== undefined &&
    !input.connection.enabledToolNames.includes(tool.name)
  ) {
    return { ok: false, reasonCode: "TOOL_NOT_GRANTED" };
  }
  const rendered = ToolDescriptorSchema.safeParse(tool);
  if (!rendered.success) {
    return { ok: false, reasonCode: "ENDPOINT_OUTSIDE_ALLOWLIST" };
  }
  // The echoed amount declaration must equal the owner's parsed
  // catalog entry (both absent, or both present and equal). Compared on the
  // strictly parsed descriptor only, never the raw stored entry, and before
  // the record early return so record tools are covered.
  if (
    !sameAmountDeclaration(input.params.amountArgument, rendered.data.amount)
  ) {
    return { ok: false, reasonCode: "TOOL_AMOUNT_DECLARATION_MISMATCH" };
  }
  // A declared amount on a tool that sends no arguments (GET, HEAD) never
  // reaches the endpoint, so it cannot bind what is charged (fail closed).
  if (!toolAmountSendable(rendered.data)) {
    return { ok: false, reasonCode: "TOOL_AMOUNT_NOT_SENT" };
  }
  // A record-transport tool has no endpoint: the impl runs inside the
  // tool-server host at commit, so no allowlist leg exists.
  if (rendered.data.transport === "record") {
    return { ok: true };
  }
  // readToolAmount lets content pins past allowedArguments because the
  // SDK removes them before a record tool runs. An http tool would
  // send them to the endpoint as an argument the owner did not list.
  const allowed = rendered.data.amount?.allowedArguments;
  if (
    allowed !== undefined &&
    Object.prototype.hasOwnProperty.call(
      input.params.arguments,
      CONTENT_PINS_ARGUMENT,
    ) &&
    !allowed.includes(CONTENT_PINS_ARGUMENT)
  ) {
    return { ok: false, reasonCode: "TOOL_ARGUMENT_NOT_ALLOWED" };
  }
  if (
    !apiEndpointWithinAllowlist(
      rendered.data.url,
      input.connection.endpointAllowlist ?? [],
    )
  ) {
    return { ok: false, reasonCode: "ENDPOINT_OUTSIDE_ALLOWLIST" };
  }
  return { ok: true };
}

export function validateMcpInstallBinding(input: {
  params: McpInstallParametersV1;
  connection: {
    toolServer?: { tools: readonly ToolDescriptor[] };
    endpointAllowlist?: readonly string[];
  };
}): { ok: true } | { ok: false; reasonCode: string } {
  // Amount declarations are set by the owner only, never by an
  // agent's install.
  if (input.params.tool.amount !== undefined) {
    return { ok: false, reasonCode: "TOOL_AMOUNT_OWNER_ONLY" };
  }
  const tools = input.connection.toolServer?.tools;
  if (tools === undefined) {
    return { ok: false, reasonCode: "CONNECTION_UNAVAILABLE" };
  }
  if (tools.length >= TOOL_CATALOG_MAX_TOOLS) {
    return { ok: false, reasonCode: "TOOL_CATALOG_FULL" };
  }
  if (tools.some((tool) => tool.name === input.params.tool.name)) {
    return { ok: false, reasonCode: "TOOL_ALREADY_INSTALLED" };
  }
  if (
    input.params.tool.transport === "record"
      ? false
      : !apiEndpointWithinAllowlist(
          input.params.tool.url,
          input.connection.endpointAllowlist ?? [],
        )
  ) {
    return { ok: false, reasonCode: "ENDPOINT_OUTSIDE_ALLOWLIST" };
  }
  return { ok: true };
}

export function validateMcpEnableBinding(input: {
  params: McpEnableParametersV1;
  connection: {
    toolServer?: { tools: readonly ToolDescriptor[] };
    enabledToolNames?: readonly string[];
  };
}): { ok: true } | { ok: false; reasonCode: string } {
  const tool = findCatalogTool(input.connection, input.params.toolName);
  if (tool === undefined) {
    return { ok: false, reasonCode: "TOOL_NOT_IN_CATALOG" };
  }
  if (input.connection.enabledToolNames?.includes(tool.name)) {
    return { ok: false, reasonCode: "TOOL_ALREADY_ENABLED" };
  }
  return { ok: true };
}
