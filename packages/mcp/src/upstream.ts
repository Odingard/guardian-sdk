/**
 * Connect to the MCP server the proxy governs: a stdio child
 * or a remote server over Streamable HTTP or SSE.
 *
 * The proxy always serves stdio to the agent. For a remote upstream the URL
 * and header values (API keys) live only in this process: they are sent to
 * the upstream origin and nowhere else, and every diagnostic is scrubbed of
 * them before it is printed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  describeTarget,
  redact,
  secretsOf,
  upstreamEnv,
  type UpstreamTarget,
} from "./config.js";
import type { Upstream, UpstreamCallResult, UpstreamTool } from "./proxy.js";

export class UpstreamConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamConnectError";
  }
}

export function upstreamTransport(
  target: UpstreamTarget,
  env: Readonly<Record<string, string | undefined>>,
): Transport {
  if (!("remote" in target)) {
    return new StdioClientTransport({
      command: target.command,
      args: target.args,
      env: upstreamEnv(env),
      stderr: "inherit",
    });
  }
  const { url, transport, headers } = target.remote;
  // Redirects stay on the upstream's own origin (the SDK default), so the
  // API key is never replayed to another host.
  const options = {
    requestInit: { headers },
    redirectPolicy: "same-origin" as const,
  };
  return transport === "sse"
    ? new SSEClientTransport(new URL(url), options)
    : new StreamableHTTPClientTransport(new URL(url), options);
}

/**
 * Connect an MCP client to the upstream. Failure throws an
 * `UpstreamConnectError` whose message names the origin only and carries no
 * secret, so the CLI can print it and exit without serving any tool.
 */
export async function connectUpstream(
  target: UpstreamTarget,
  env: Readonly<Record<string, string | undefined>>,
  clientInfo: { name: string; version: string },
  transport: Transport = upstreamTransport(target, env),
): Promise<Client> {
  const client = new Client(clientInfo, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (err) {
    await client.close().catch(() => {});
    const detail = err instanceof Error ? err.message : String(err);
    throw new UpstreamConnectError(
      `guardian-mcp: could not connect to the upstream MCP server at ${describeTarget(target)}: ` +
        `${redact(detail, secretsOf(target)).slice(0, 300)}. No tools are served.`,
    );
  }
  return client;
}

/** Page through every upstream tool. */
export async function listAllTools(client: Client): Promise<UpstreamTool[]> {
  const tools: UpstreamTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(page.tools as UpstreamTool[]));
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

/**
 * The message `guardian-mcp tools` prints when tools/list fails after a
 * successful connect: origin only, upstream text scrubbed of every secret.
 */
export function toolListFailure(target: UpstreamTarget, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return (
    `guardian-mcp: the upstream MCP server at ${describeTarget(target)} did not return its tool list: ` +
    `${redact(detail, secretsOf(target)).slice(0, 300)}.`
  );
}

/** The two operations the governed proxy needs, backed by an MCP client. */
export function clientUpstream(client: Client): Upstream {
  return {
    listTools: () => listAllTools(client),
    async callTool(name, args) {
      return (await client.callTool({
        name,
        arguments: args,
      })) as UpstreamCallResult;
    },
  };
}
