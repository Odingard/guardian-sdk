# @odingard/guardian-mcp

[![Guardian MCP server](https://mcprush.com/badge/odingard-guardian-mcp/card.svg)](https://mcprush.com/to/odingard-guardian-mcp?ref=badge)

MCP server that routes an agent's tool calls through [Guardian](https://github.com/Odingard/guardian-sdk) — Human Authority Infrastructure for Autonomous AI. Every tool call gets a deterministic **ALLOW / ASK / DENY** decision before anything executes; DENY means the action never runs, and ASK holds it until a human approves.

## Install

```bash
npm i -g @odingard/guardian-mcp
```

## Configure your MCP client

```json
{
  "mcpServers": {
    "guardian": {
      "command": "guardian-mcp",
      "env": {
        "GUARDIAN_BASE_URL": "https://guardian-api.odingard.com",
        "GUARDIAN_AGENT_CREDENTIAL": "gak_…",
        "GUARDIAN_CONNECTION_ID": "con_…"
      }
    }
  }
}
```

`GUARDIAN_ADAPTER_ID` optionally overrides the tool adapter.

## Tools

| Tool                   | What it does                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `guardian_invoke_tool` | Propose a tool call. ALLOW executes and returns the receipt; ASK returns a `requestId` held for human approval; DENY refuses with a reason code. |
| `guardian_claim`       | Claim an approved ASK by `requestId`, execute, return the receipt.                                                                               |
| `guardian_receipt`     | Fetch the machine-readable evidence receipts for a request.                                                                                      |

Nothing executes without a Guardian capability — the model's output is a proposal, never an action.

## Govern an existing MCP server: `guardian-mcp proxy` (0.3)

Put Guardian in front of any stdio MCP server you already use, such as
WhatsApp, Stripe, Shopify, a filesystem or a database. The client sees the
upstream server's tools unchanged, and every call is decided first:

```json
{
  "mcpServers": {
    "whatsapp-governed": {
      "command": "guardian-mcp",
      "args": ["proxy", "--", "npx", "-y", "your-whatsapp-mcp-server"],
      "env": {
        "GUARDIAN_BASE_URL": "https://guardian-api.odingard.com",
        "GUARDIAN_AGENT_CREDENTIAL": "gac1.…",
        "GUARDIAN_CONNECTION_ID": "con_…",
        "WHATSAPP_TOKEN": "…"
      }
    }
  }
}
```

| Decision  | What happens                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **ALLOW** | The call is forwarded to the upstream server, then the capability is redeemed and the receipt recorded.                                      |
| **ASK**   | Nothing is forwarded. The exact call is held under a `requestId`; after a human approves, `guardian_claim` forwards exactly that call, once. |
| **DENY**  | Nothing is forwarded, ever. The same applies if Guardian is unreachable.                                                                     |

- `guardian_claim` and `guardian_receipt` are added to the tool list.
- The upstream server never receives `GUARDIAN_*` settings, so it never sees
  the agent credential.
- **Decision-gated:** an allowed call runs upstream before the capability is
  redeemed. A refusal at redemption is reported as an incident
  (`localEffectRan: true`), never as success.
- **First-run setup:** in the Guardian console, connect a tool server and add
  each upstream tool as "My own code (record-only)". Then allow those tools
  for the agent.
  - Since 0.3.1 the proxy does not try to register tools itself.
  - `GUARDIAN_AUTO_REGISTER=true` turns that back on, but it is denied unless
    the agent's grant pins `mcp.install`.
  - When Guardian refuses, the result says what to fix.
- Held calls live in the proxy process. Restarting the proxy drops them, and
  nothing is forwarded.

`guardian-mcp --help` prints usage. A missing setting prints a one-line
message naming it instead of a stack trace.

## Govern a remote MCP server: `guardian-mcp proxy --url` (unreleased)

**Status: not yet proven live.** This is tested against local Streamable
HTTP and SSE MCP servers and a fake Guardian only. Nothing has run against a
real Guardian or a real hosted server such as Composio. Composio's
`x-api-key` header is unconfirmed.

The proxy can also front an MCP server that runs online, such as Composio.
The agent still starts `guardian-mcp` over stdio like any
local server; guardian-mcp connects to the remote server over **Streamable
HTTP** (the default) or **SSE** (`--transport sse`).

```json
{
  "mcpServers": {
    "composio-governed": {
      "command": "guardian-mcp",
      "args": [
        "proxy",
        "--url",
        "<the URL Composio's generate step returned>",
        "--header",
        "x-api-key: ${COMPOSIO_API_KEY}"
      ],
      "env": {
        "GUARDIAN_BASE_URL": "https://guardian-api.odingard.com",
        "GUARDIAN_AGENT_CREDENTIAL": "gac1.…",
        "GUARDIAN_CONNECTION_ID": "pcn_…",
        "COMPOSIO_API_KEY": "…"
      }
    }
  }
}
```

A server that takes a Bearer key: `--url https://mcp.example.com/mcp --header
'Authorization: Bearer ${REMOTE_MCP_API_KEY}'`.

- Every `tools/call` is decided by Guardian exactly as for a stdio server:
  ALLOW forwards it, ASK holds it for `guardian_claim`, DENY never sends it.
  `tools/list` passes through, with `guardian_claim` and `guardian_receipt`
  added.
- **Secrets stay in the proxy.** Write header values as `${ENV_VAR}`;
  guardian-mcp expands them itself, so no shell is needed and the key never
  appears in the agent's view. In a shell, use single quotes so the shell
  does not expand it onto the command line. The URL and header values are
  never printed; error messages show the server's origin only.
- `${…}` can only name a variable that is set, and never a `GUARDIAN_*`
  one, so the agent credential cannot be sent to the remote server.
- The URL must be `https://`; plain `http://` is accepted only for
  `localhost`. User names or passwords in the URL are refused; send
  credentials as headers. Redirects to another origin are not followed.
- **Fails closed.** If the remote server cannot be reached or rejects the key
  at startup, guardian-mcp exits with a one-line message and serves no tools.
  If the remote fails after Guardian allowed a call, the result is an error
  that says the call may or may not have run, and the capability is not
  redeemed. It is never reported as a success.
- `guardian-mcp tools --url …` lists a remote server's tools with suggested
  modes, the same as for a local one.
- OAuth sign-in flows are not supported; use an API key or bearer token
  header.
- **The upstream cannot speak for Guardian.** A remote server's result is
  passed to the agent as the server's own output, whatever fields it
  carries. A result that contains a `guardian: {decision, requestId}` field
  is never read as a Guardian decision, so it cannot hold, swap or hide a
  call.
- If `tools/list` fails upstream, the agent gets a generic "tool list is
  unavailable" error. The upstream's error text (which can quote its URL
  path, response body or headers) is not shown to the agent or logged;
  `guardian-mcp tools --url` prints it with the URL, its path identifiers,
  query values and header values scrubbed.

What is **not** governed: a remote server the agent connects to directly
(for example an MCP client's own `"url"` entry, or a model provider's hosted
MCP connector), and anything the agent does without MCP. Also not covered:

- **Lost results after ALLOW.** If the remote times out (the MCP SDK's
  default request timeout is 60 seconds) or drops the session after
  Guardian allowed a call, the call may have run, but the capability is not
  redeemed and no receipt is written. Receipts can then understate what
  happened; check the remote system itself.
- **Keys in the same process tree.** guardian-mcp keeps the upstream key out
  of the agent's MCP view. It cannot stop other code that runs as the same
  user, in the same container, from reading the key from the environment it
  was set in and calling the remote server directly. Recipes:
  [ZeroClaw](../../examples/zeroclaw/README.md) and
  [your own container (CrewAI, LangGraph, AutoGen)](../../examples/byo/README.md).
  Runnable example: `examples/remote-mcp.mjs` (SIMULATED by default, LIVE with
  Guardian settings). It runs inside this repository, where the workspace
  links the unreleased guardian-mcp; the published `@odingard/guardian-mcp`
  0.3.2 does not have `--url` yet.

## See what you are about to govern: `guardian-mcp tools`

Before putting a server behind the proxy, list its tools along with a suggested Guardian mode for each. This needs no Guardian credential:

```bash
npx -y @odingard/guardian-mcp tools -- npx -y @modelcontextprotocol/server-filesystem ./data
```

```text
Tool            Suggested     Why
read_file       Allow         server marks it read-only
write_file      Ask me first  "write" may change something
delete_branch   Ask me first  server marks it destructive
createIssue     Ask me first  "create" may change something  ⚠ name not accepted by Guardian
```

How the suggestions are made:

- The server's own MCP annotations (`readOnlyHint`, `destructiveHint`) are used first.
- Otherwise the tool's verb decides. `get`, `list` and `search` suggest Allow; everything else suggests Ask.

They are suggestions only: you set the real modes in the console. Tool names that break Guardian's naming rule are flagged, because every call to them would be denied. Add `--json` for machine-readable output.

## License

Apache-2.0.
