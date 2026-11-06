/**
 * Guardian Governed MCP setups.
 *
 * `guardian-mcp tools -- <server command>` connects to a real MCP server,
 * lists its tools and suggests a Guardian mode for each, so registering a
 * server's tools in the console is a copy job, not guesswork. Suggestions
 * come first from the server's own MCP annotations (readOnlyHint,
 * destructiveHint), then from the tool's verb; anything unclear is "ask".
 * They are suggestions only: the human sets the modes in the console.
 */
import type { UpstreamTool } from "./proxy.js";

/** Guardian tool names: /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, ≤ 64 chars. */
const GUARDIAN_TOOL_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const READ_VERBS = new Set([
  "get",
  "list",
  "search",
  "read",
  "describe",
  "show",
  "view",
  "find",
  "lookup",
  "count",
  "inspect",
  "status",
  "fetch",
]);

export type ToolSuggestion = Readonly<{
  name: string;
  suggestedMode: "allow" | "ask";
  why: string;
  /** False: Guardian rejects this name, so every call would be denied. */
  governable: boolean;
}>;

function firstWord(name: string): string {
  return (
    name
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .find(Boolean) ?? ""
  );
}

export function suggestTool(tool: UpstreamTool): ToolSuggestion {
  const governable =
    GUARDIAN_TOOL_NAME.test(tool.name) && tool.name.length <= 64;
  const annotations = (tool.annotations ?? {}) as {
    readOnlyHint?: unknown;
    destructiveHint?: unknown;
  };
  if (annotations.destructiveHint === true) {
    return {
      name: tool.name,
      suggestedMode: "ask",
      why: "server marks it destructive",
      governable,
    };
  }
  if (annotations.readOnlyHint === true) {
    return {
      name: tool.name,
      suggestedMode: "allow",
      why: "server marks it read-only",
      governable,
    };
  }
  const verb = firstWord(tool.name);
  if (READ_VERBS.has(verb)) {
    return {
      name: tool.name,
      suggestedMode: "allow",
      why: `name starts with "${verb}" (not annotated; check it really only reads)`,
      governable,
    };
  }
  return {
    name: tool.name,
    suggestedMode: "ask",
    why: verb ? `"${verb}" may change something` : "unclear what it does",
    governable,
  };
}

export function renderSuggestions(
  serverCommand: string,
  tools: readonly UpstreamTool[],
  remote = false,
): string {
  const rows = tools.map(suggestTool);
  const width = Math.max(4, ...rows.map((r) => r.name.length));
  const lines = [
    `Tools of: ${serverCommand}`,
    "",
    `${"Tool".padEnd(width)}  Suggested     Why`,
    ...rows.map(
      (r) =>
        `${r.name.padEnd(width)}  ${(r.suggestedMode === "ask" ? "Ask me first" : "Allow").padEnd(12)}  ${r.why}${r.governable ? "" : "  ⚠ name not accepted by Guardian"}`,
    ),
    "",
    "Register these in the Guardian console (Connections → Register a tool server →",
    "record-only), then set each mode for your agent. Run the server through",
    remote
      ? "`guardian-mcp proxy --url <same url> --header …` so every call is decided first."
      : "`guardian-mcp proxy -- <same command>` so every call is decided first.",
  ];
  const ungovernable = rows.filter((r) => !r.governable);
  if (ungovernable.length > 0) {
    lines.push(
      "",
      `⚠ ${ungovernable.length} tool name(s) don't match Guardian's naming rule`,
      "  (lowercase letters/digits, separated by . _ or -; at most 64 chars).",
      "  Calls to them will be denied. Leave them out, or use a server version",
      "  with compatible names.",
    );
  }
  return lines.join("\n");
}
