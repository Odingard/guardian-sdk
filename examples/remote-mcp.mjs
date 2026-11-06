/**
 * remote-mcp.mjs — guardian-mcp in front of a REMOTE MCP server.
 *
 * Starts a small MCP server over Streamable HTTP on 127.0.0.1 that demands an
 * `x-api-key` (standing in for Composio or Maritime Computers), then runs the
 * real `guardian-mcp proxy --url … --header 'x-api-key: ${KEY}'` CLI and talks
 * to it over stdio, the way an agent's MCP client would.
 *
 *   SIMULATED (default, zero setup): Guardian is pointed at an unreachable
 *     address, so you see the remote tools pass through and every call fail
 *     closed. Nothing reaches the remote server and the key is never printed.
 *   LIVE: set GUARDIAN_BASE_URL, GUARDIAN_AGENT_CREDENTIAL and
 *     GUARDIAN_CONNECTION_ID (with the two tools below registered on that
 *     connection: list_threads Allow, send_email Ask). The read runs, the send
 *     waits for you to approve it in the Guardian console, then runs once.
 *     Set REMOTE_MCP_URL (+ REMOTE_MCP_API_KEY) to front a real remote server
 *     instead of the local one.
 *
 * Run:  npm run build && node examples/remote-mcp.mjs
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const require = createRequire(import.meta.url);
const CLI = join(
  dirname(require.resolve("@odingard/guardian-mcp/package.json")),
  "dist/index.js",
);

const live = Boolean(
  process.env.GUARDIAN_BASE_URL &&
  process.env.GUARDIAN_AGENT_CREDENTIAL &&
  process.env.GUARDIAN_CONNECTION_ID,
);

// ---- the "remote" MCP server (skipped when REMOTE_MCP_URL is set) --------
const apiKey =
  process.env.REMOTE_MCP_API_KEY ?? `demo_${randomBytes(12).toString("hex")}`;
const ran = [];
let http;
let url = process.env.REMOTE_MCP_URL;
if (!url) {
  http = createServer((req, res) => {
    if (req.headers["x-api-key"] !== apiKey) return res.writeHead(401).end();
    const server = new Server(
      { name: "demo-remote", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "list_threads",
          description: "List email threads",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        {
          name: "send_email",
          description: "Send an email",
          inputSchema: { type: "object" },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      ran.push(request.params.name);
      return {
        content: [
          {
            type: "text",
            text: `${request.params.name} ran on the remote server`,
          },
        ],
      };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    void server
      .connect(transport)
      .then(() => transport.handleRequest(req, res));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${http.address().port}/mcp`;
}

// ---- the agent side: an MCP client that launches guardian-mcp ------------
const env = {
  PATH: process.env.PATH ?? "",
  REMOTE_MCP_API_KEY: apiKey,
  GUARDIAN_BASE_URL: live
    ? process.env.GUARDIAN_BASE_URL
    : "http://127.0.0.1:9",
  GUARDIAN_AGENT_CREDENTIAL: live
    ? process.env.GUARDIAN_AGENT_CREDENTIAL
    : "gac1.simulated",
  GUARDIAN_CONNECTION_ID: live
    ? process.env.GUARDIAN_CONNECTION_ID
    : "pcn_00000000000000000000000000000000",
};
const transport = new StdioClientTransport({
  command: process.execPath,
  // The header is a ${VAR} reference: guardian-mcp expands it itself, so
  // the key never appears on a command line or in the agent's config.
  args: [
    CLI,
    "proxy",
    "--url",
    url,
    "--header",
    "x-api-key: ${REMOTE_MCP_API_KEY}",
  ],
  env,
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (d) => (stderr += d));
const agent = new Client(
  { name: "remote-mcp-example", version: "0" },
  { capabilities: {} },
);
await agent.connect(transport);

console.log(
  `${live ? "LIVE" : "SIMULATED"}: guardian-mcp proxy → ${new URL(url).origin}`,
);
const tools = (await agent.listTools()).tools.map((t) => t.name);
console.log("tools the agent sees:", tools.join(", "));

const show = (r) => {
  const text = r.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

for (const name of ["list_threads", "send_email"]) {
  let out = show(
    await agent.callTool({ name, arguments: { to: "cfo@example.com" } }),
  );
  console.log(`\n→ ${name}:`, out);
  if (live && out?.decision === "ASK") {
    console.log(
      "  waiting up to 5 minutes for a person to approve it in the Guardian console…",
    );
    const deadline = Date.now() + 5 * 60_000;
    while (out?.decision === "ASK" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      out = show(
        await agent.callTool({
          name: "guardian_claim",
          arguments: { requestId: out.requestId },
        }),
      );
    }
    console.log("  after claim:", out);
  }
}

await agent.close();
http?.closeAllConnections();
http?.close();

if (!process.env.REMOTE_MCP_URL) {
  console.log(
    "\nran on the remote server:",
    ran.length ? ran.join(", ") : "nothing",
  );
}
const leaked =
  stderr.includes(apiKey) || JSON.stringify(tools).includes(apiKey);
console.log(
  "API key printed anywhere the agent or logs can see:",
  leaked ? "YES (bug)" : "no",
);
if (!live && ran.length > 0) process.exitCode = 1;
if (leaked) process.exitCode = 1;
