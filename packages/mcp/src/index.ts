#!/usr/bin/env node
/**
 * @odingard/guardian-mcp — MCP stdio server that routes an agent's tool calls
 * through Guardian for a deterministic ALLOW / ASK / DENY decision before
 * anything executes.
 *
 *   guardian-mcp                               Guardian governance tools
 *   guardian-mcp proxy -- <command> [args...]  govern an existing stdio MCP server
 *   guardian-mcp proxy --url <https-url> [--transport sse] [--header "K: ${ENV}"]
 *                                              govern a remote MCP server
 *
 * Configuration (env): see `guardian-mcp --help`.
 */
import { createRequire } from "node:module";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createGuardianClient } from "@odingard/guardian-sdk";

import { describeTarget, parseCli } from "./config.js";
import { TOOLS, handleToolCall } from "./dispatch.js";
import { renderSuggestions, suggestTool } from "./presets.js";
import { createGovernedProxy } from "./proxy.js";
import {
  clientUpstream,
  connectUpstream,
  listAllTools,
  toolListFailure,
  UpstreamConnectError,
} from "./upstream.js";

/** Connect or exit: with no upstream there is nothing to serve (fail closed). */
async function connectOrExit(
  ...args: Parameters<typeof connectUpstream>
): ReturnType<typeof connectUpstream> {
  try {
    return await connectUpstream(...args);
  } catch (err) {
    process.stderr.write(
      `${err instanceof UpstreamConnectError ? err.message : "guardian-mcp: could not connect to the upstream MCP server. No tools are served."}\n`,
    );
    process.exit(1);
  }
}

const VERSION = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

const parsed = parseCli(process.argv.slice(2), process.env);
if (!parsed.ok) {
  process.stderr.write(`${parsed.message}\n`);
  process.exit(parsed.message.startsWith("guardian-mcp —") ? 0 : 2);
}
const config = parsed.config;

if (config.mode.kind === "tools") {
  const mode = config.mode;
  const lister = await connectOrExit(mode, process.env, {
    name: "guardian-mcp-tools",
    version: VERSION,
  });
  let tools: Awaited<ReturnType<typeof listAllTools>>;
  try {
    tools = await listAllTools(lister);
  } catch (err) {
    // Scrub the upstream's error (it can quote the URL, the response
    // body or a header) before printing it.
    process.stderr.write(`${toolListFailure(mode, err)}\n`);
    await lister.close().catch(() => {});
    process.exit(1);
  }
  await lister.close();
  const serverCommand = describeTarget(mode);
  process.stdout.write(
    mode.json
      ? `${JSON.stringify({ server: serverCommand, tools: tools.map(suggestTool) }, null, 2)}\n`
      : `${renderSuggestions(serverCommand, tools, "remote" in mode)}\n`,
  );
  process.exit(0);
}

const client = createGuardianClient({
  baseUrl: config.baseUrl,
  credential: config.credential,
  ...(config.adapterId ? { adapterId: config.adapterId } : {}),
});

const server = new Server(
  { name: "guardian-mcp", version: VERSION },
  { capabilities: { tools: {} } },
);

if (config.mode.kind === "proxy") {
  const upstreamClient = await connectOrExit(config.mode, process.env, {
    name: "guardian-mcp-proxy",
    version: VERSION,
  });
  let proxy: ReturnType<typeof createGovernedProxy>;
  try {
    proxy = createGovernedProxy({
      client,
      connectionId: config.connectionId!,
      autoRegister: config.autoRegister,
      upstreamTransport: "remote" in config.mode ? "remote" : "stdio",
      ...(config.mode.pinFiles ? { pinFiles: config.mode.pinFiles } : {}),
      ...(config.adapterId ? { adapterId: config.adapterId } : {}),
      log: (message) => process.stderr.write(`${message}\n`),
      upstream: clientUpstream(upstreamClient),
    });
  } catch (err) {
    // A bad --pin-file declaration: one readable line, nothing is served.
    process.stderr.write(
      `${err instanceof Error ? err.message : "guardian-mcp proxy: invalid configuration."}\n`,
    );
    await upstreamClient.close().catch(() => {});
    process.exit(2);
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await proxy.listTools(),
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) =>
      (await proxy.callTool(
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
        // Cancelled (notifications/cancelled) or timed-out requests are
        // not forwarded if the signal fires before the call is sent.
        { signal: extra.signal },
      )) as never,
  );
} else {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall(
      {
        client,
        defaultConnectionId: config.connectionId,
        adapterId: config.adapterId,
      },
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
    ),
  );
}

await server.connect(new StdioServerTransport());
