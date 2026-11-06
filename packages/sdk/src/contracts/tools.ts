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

/** A catalog entry: a named tool that renders to one allowlisted https call. */
export const ToolHttpDescriptorSchema = z
  .object({
    name: ToolNameSchema,
    description: z.string().max(TOOL_DESCRIPTION_MAX_LENGTH).optional(),
    transport: z.literal("http").optional(),
    method: ApiRequestMethodSchema,
    url: ApiRequestUrlSchema,
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
    ...(parsedTool.method === "GET" || parsedTool.method === "HEAD"
      ? {}
      : { body }),
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
  // A record-transport tool has no endpoint: the impl runs inside the
  // tool-server host at commit, so no allowlist leg exists.
  if (rendered.data.transport === "record") {
    return { ok: true };
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
