<img src="https://raw.githubusercontent.com/Odingard/guardian-sdk/main/assets/guardian-mark.svg" alt="Guardian" width="48" height="48" />

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
        "GUARDIAN_CONNECTION_ID": "pcn_…"
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

Only a call whose receipt status is `sent-verified` is returned as a plain
result. Every other outcome is an MCP tool error (`isError: true`) that says
what happened:

- DENY, or Guardian could not be reached: nothing was done. A denial says not
  to retry the same call; an outage says to try again later.
- Receipt status `not-sent`: `outcome: "not-done"`, the call was not done.
- Receipt status `outcome-pending` or `outcome-unconfirmed`, or an execute
  answer that was refused or lost: `outcome: "unknown"`. The call may have
  been done, so check (`guardian_receipt`, or the target system) before
  retrying.

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
        "GUARDIAN_AGENT_CREDENTIAL": "gak_…",
        "GUARDIAN_CONNECTION_ID": "pcn_…",
        "WHATSAPP_TOKEN": "…"
      }
    }
  }
}
```

| Decision                 | What happens                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ALLOW**                | The call is forwarded to the upstream server, then the capability is redeemed and the receipt recorded. The upstream result is returned unchanged, with Guardian's `requestId` under `_meta["com.odingard/guardian"]`, so the client can fetch the receipt with `guardian_receipt`.                    |
| **ASK**                  | Nothing is forwarded. The exact call is held under a `requestId`; after a human approves, `guardian_claim` forwards exactly that call, once.                                                                                                                                                           |
| **DENY**                 | Nothing is forwarded, ever. The result is an MCP tool error (`isError: true`) with the reason code and, when Guardian made a record of it, the `requestId`.                                                                                                                                            |
| **Guardian unreachable** | Nothing is forwarded. The result is a tool error (`isError: true`) whose JSON keeps `decision: "DENY"` with `reasonCode: "SERVICE_UNAVAILABLE"`, and its message says Guardian could not be reached and the call can be tried again later. A held call stays held, so `guardian_claim` can be retried. |

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
    the agent's grant pins `mcp.install`, and it only works for a tool that
    has no entry yet. An "already registered" answer is refused
    (`RECORD_TRANSPORT_UNVERIFIED`) and nothing is forwarded, including after
    a proxy restart for an entry the proxy created itself. Once the entries
    exist, run the proxy without it.
  - When Guardian refuses, the result says what to fix.
- Held calls live in the proxy process. Restarting the proxy drops them, and
  nothing is forwarded.
- **Cancelled requests are not forwarded.** If the client cancels a
  `tools/call` (or it times out) before the call is sent upstream, for
  example while Guardian is still deciding, the call is not forwarded and the
  capability is not redeemed. A `guardian_claim` cancelled that way keeps the
  call held with its approval, so the next `guardian_claim` forwards it
  without asking the person again. Once a call has been sent upstream it runs
  to its real outcome, which is recorded.
- **A second `guardian_claim` of the same `requestId`** says the call was
  already forwarded and must not be proposed again. If the first claim has
  finished, its result is returned again after that notice; if it is still
  running, the answer says to check `guardian_receipt`. The proxy remembers
  the last 1000 claimed requests. A `requestId` it does not hold is answered
  with "this claim forwarded nothing", and a reminder to check
  `guardian_receipt` if it was claimed before.
- An unexpected proxy error after a call was forwarded says the call may
  have run, never that it was not forwarded.

`guardian-mcp --help` prints usage. A missing setting prints a one-line
message naming it instead of a stack trace.

### Pin the contents of file arguments: `--pin-file` (0.4)

Approval binds the exact arguments. A file path is an argument; the file's contents are not, unless you declare the argument with `--pin-file`.

```bash
guardian-mcp proxy --pin-file upload_file:path --pin-file send_email:attachment -- npx -y my-mcp-server
```

For each declared `<tool>:<argument>` the proxy (the SDK on your machine) reads the file the path names, puts its SHA-256 in the approved arguments, and checks it again just before the call is forwarded. Guardian's servers never see the file. If the file changed, nothing is forwarded, the capability is not redeemed, and the result says `CONTENT_CHANGED_SINCE_APPROVAL`; propose the call again for a new approval. A call held for approval keeps the arguments that were proposed, pins included, and `guardian_claim` checks the file against them. After a proxy restart a claim finds nothing; call the tool again, which pins the file again. The upstream server receives the approved arguments without the reserved key `guardianContentPins`. In code: `createGovernedProxy({ ..., pinFiles: { upload_file: ["path"] } })`.

- The mode is always `recheck`: the upstream server opens the path itself, so a short window remains between the check and its open. Elsewhere in the SDK `bytes` is the default when no mode is named; the proxy cannot hand an upstream server bytes, so `--pin-file` and `pinFiles` take no mode and always mean `recheck`.
- Stdio upstreams only. With `--url` (HTTP or SSE) the path names a file on another machine, so `--pin-file` is refused at start (`CONTENT_PIN_REMOTE_UPSTREAM`). Paths on a remote MCP server are not pinned.
- File paths must be absolute. The proxy does not resolve relative paths or `~`.
- Content pinning is supported on Linux and macOS. On Windows a declared file argument is refused (`CONTENT_PIN_UNSUPPORTED_PLATFORM`).
- **Digest privacy:** the SHA-256 of each pinned file is sent to Guardian, shown to the approver and kept in receipts. For a small or low-entropy file (a token, a PIN, a short config value), anyone who sees the digest can guess the contents offline by hashing candidates. Do not pin files like that, or treat the digest as sensitive as the file.
- This stops a changed file from running under an approval given for different contents. It does not protect against code that bypasses the proxy, and files a tool opens without naming them in a declared argument are not pinned.

### Dollar amounts on tools: `--amount-arg` (0.5)

If the owner set a dollar amount on a tool in the Guardian console (which argument holds the amount, cents or dollars), give the proxy the same declaration:

```bash
guardian-mcp proxy --amount-arg purchase=amount:minor -- npx -y my-shop-mcp-server
```

`<argument>:minor` means cents (`2000` is $20.00), `<argument>:major` dollars (`20` or `"19.99"`); the currency is US dollars. For a currency argument or an "allowed arguments" list, give the declaration as JSON, exactly as in the console:

```bash
guardian-mcp proxy \
  --amount-arg 'purchase={"argument":"amount","unit":"minor","currency":"usd","allowedArguments":["amount","sku"]}' \
  -- npx -y my-shop-mcp-server
```

Each call of that tool carries the declaration and the amount the proxy reads, and Guardian decides on the amount: allow up to the limit, hold for a person above it (`guardian_claim` forwards the call once after approval), block above the maximum. A call whose amount cannot be read, or whose declaration is not the owner's, is refused and nothing is forwarded. In code: `createGovernedProxy({ ..., amountArgs: { purchase: { argument: "amount", unit: "minor", currency: "usd" } } })`.

- The upstream MCP server runs the tool, so the limit applies to Guardian's decision. The proxy forwards the arguments Guardian decided on.
- Guardian reads one argument. By setting it, the owner states that this argument sets the charge; other arguments that change it (a quantity, a tip) are not seen. An allowed-arguments list blocks calls with any other argument.
- A malformed `--amount-arg`, an invalid declaration or two declarations for one tool are refused at start, with a message that says what to fix.
- Works with stdio and remote (`--url`) upstreams.

## Govern a remote MCP server: `guardian-mcp proxy --url` (0.3.3 and later)

**Status: tested against a real Guardian; production proof pending.** It ran
end to end over Streamable HTTP against the real Guardian server code (allow,
ask then approve, deny, outage), not yet on hosted production. SSE is tested
against local servers and a stand-in Guardian only, and no real hosted server
such as Composio has been tried. Composio's `x-api-key` header is
unconfirmed.

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
        "GUARDIAN_AGENT_CREDENTIAL": "gak_…",
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
  query values and header values scrubbed. Each query value is scrubbed as
  typed (a `+` stays a `+`), percent-decoded, and with `+` read as a space.

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
  Guardian settings). `--url` is in the published `@odingard/guardian-mcp`
  from 0.3.3.

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

- A tool the server marks destructive (`destructiveHint`) suggests Ask.
- So does a tool whose name contains a verb that changes something or sends data out, anywhere in the name (`create`, `update`, `delete`, `replace`, `send`, `run`, `write` and similar), even when the server marks it read-only. `get_or_create_customer`, `find_and_replace` and `list_and_delete_old_files` suggest Ask.
- Otherwise a tool the server marks read-only (`readOnlyHint`) suggests Allow, and so does a name that starts with a read verb (`get`, `list`, `search`, `read`, `describe`, `show`, `view`, `find`, `lookup`, `count`, `inspect`).
- Everything else suggests Ask, including `fetch` (it can send data to any URL) and `status`.

They are suggestions only: you set the real modes in the console. Tool names that break Guardian's naming rule are flagged, because every call to them would be denied. Add `--json` for machine-readable output.

## License

Apache-2.0.
