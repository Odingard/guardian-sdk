# ZeroClaw, governed by Guardian (recipe)

**Status: LIVE recipe, not yet proven.** It needs a real Guardian agent and a
real ZeroClaw. Nothing here has run against ZeroClaw yet. The ZeroClaw settings are taken from
ZeroClaw's own docs (`docs/book/src/tools/mcp.md`, `tools/overview.md`,
`security/autonomy.md`, read at zeroclaw-labs/zeroclaw master `a66cc98`,
2026-11-06). Maritime runs `v0.8.5`, and field names can differ between
versions, so check them against `zeroclaw config list` on your build.

ZeroClaw is one Rust binary. Guardian can sit in front of the **MCP servers**
it uses. It cannot sit in front of ZeroClaw's **built-in tools**, so the
recipe switches the risky built-ins off.

## What is governed and what is not

| ZeroClaw tool                                                                                                                                        | Governed by Guardian?                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP tools from a server wrapped in `guardian-mcp proxy` (local stdio, or remote with `--url`)                                                        | **Yes.** Every call is decided first. ALLOW runs it, ASK holds it until a person approves, DENY never runs it.                                                                                                                                                                                                                                  |
| MCP servers configured with ZeroClaw's own `transport = "http"` or `"sse"`                                                                           | **No.** ZeroClaw reaches the server directly. Use a stdio entry that runs `guardian-mcp proxy --url …` instead.                                                                                                                                                                                                                                 |
| Built-ins: `shell`, `file_write`, `file_edit`, `http_request`, `web_fetch`, `browser`, `cron_*`, `schedule`, delegation, `memory_store`, skill tools | **No.** They run inside the ZeroClaw binary with no hook Guardian can use from outside. ZeroClaw's `before_tool_call` hooks are compiled in; its `webhook_audit` hook only reports after the fact; WASM plugins cannot gate other tools. Governing them needs a change to ZeroClaw itself, which is out of scope. **Switch them off** (step 2). |

On Maritime the ZeroClaw daemon runs at full autonomy with approvals off,
so today every built-in runs without anyone deciding. Step 2 is not optional.

## 1. Wrap every MCP server

See [`config.toml`](config.toml). Each `[[mcp.servers]]` entry runs
guardian-mcp over stdio:

- **Remote server** (Composio, Maritime Computers):
  `guardian-mcp proxy --url <url> --header 'x-api-key: ${COMPOSIO_API_KEY}'`.
  guardian-mcp expands `${…}` itself from the entry's `env`, which ZeroClaw
  stores encrypted. The key stays in the guardian-mcp process and is sent only
  to that server; it is never shown to the model or written to logs.
- **Local server**: `guardian-mcp proxy -- <original command>`.

Then grant **only** the wrapped servers through `mcp_bundles`. ZeroClaw
connects an agent to nothing it was not granted.

Tools appear as `<server>__<tool>`, plus `<server>__guardian_claim` and
`<server>__guardian_receipt`. When Guardian answers ASK, the result carries a
`requestId`. After a person approves it in the Guardian console, the model
calls `<server>__guardian_claim` with that id, and exactly the held call runs
once. Held calls live in the guardian-mcp process; if ZeroClaw restarts the
server, they are dropped and nothing runs.

In the Guardian console, add each upstream tool to the agent's tool connection
as "My own code (record-only)" and set its mode. `guardian-mcp tools --url …`
(or `-- <command>`) suggests a mode per tool.

## 2. Switch off the built-ins Guardian cannot see

```toml
[risk_profiles.assistant_risk]
allowed_tools = ["file_read", "glob_search", "content_search", "memory_recall"]
always_ask = ["shell", "file_write", "file_edit", "http_request", "web_fetch", "browser", "cron_add", "schedule"]
```

- A non-empty `allowed_tools` is a closed set for built-ins. MCP tools whose
  names contain `__` are still let in, which is why every granted server must
  be wrapped.
- An empty `allowed_tools` means **no restriction** in ZeroClaw, not deny-all.
  `always_ask` is the backstop. On a surface with no approver, such as
  Maritime's headless gateway, an `always_ask` prompt fails closed.
- `excluded_tools` only applies to non-CLI channels; do not rely on it alone.
- `deny_all_tools = true` is not used because it also denies MCP tools.
- Unconfirmed, check on your build: whether `file_read`, `glob_search` and
  `content_search` are confined to the workspace. If they are not, the agent
  could read the config or `/proc/<guardian-mcp pid>/environ` (same user 65534) and expose the upstream key and the Guardian credential to the
  model; remove them from `allowed_tools` in that case. `always_ask` above
  does not list `delegate`, `spawn_subagent`, `memory_store`, skill tools or
  `cron_*` other than `cron_add`; they are kept out by `allowed_tools`, not by
  `always_ask`. Whether a skill tool whose name contains `__` gets past
  `allowed_tools` like an MCP tool is also unconfirmed.

## Node in the ZeroClaw image

guardian-mcp is a Node.js program (Node 22 or later). ZeroClaw's images do
not ship Node:

- `:latest` is distroless (no shell).
- `:debian` / `v0.8.5-debian` is `debian:bookworm-slim` plus `bash`,
  `ca-certificates`, `curl`, `git` and `vim-tiny`, running as user 65534 with
  `HOME=/zeroclaw-data` (from `Dockerfile.debian` at master `a66cc98`; the
  `v0.8.5-debian` layer sizes match that, but the image itself was not run
  here).

The workaround that follows ZeroClaw's own Dockerfiles, which copy the Node
binary out of `node:24-bookworm-slim` the same way, is a derived image:

```dockerfile
FROM node:22-bookworm-slim AS guardian
RUN npm install --prefix /opt/guardian-mcp @odingard/guardian-mcp@<version with --url>

FROM ghcr.io/zeroclaw-labs/zeroclaw:v0.8.5-debian
COPY --from=guardian /usr/local/bin/node /usr/local/bin/node
COPY --from=guardian /opt/guardian-mcp /opt/guardian-mcp
```

This image has **not been built or run** in this work (no Docker daemon was
available). The Node binary needs glibc and `libstdc++`, which
`bookworm-slim` provides. If your host (for example Maritime's ZeroClaw
template) does not let you change the image, this recipe cannot run there
yet: use the bring-your-own-container path ([../byo](../byo/README.md))
instead. Copying a Node binary onto `/data` at runtime has not been verified
and is not documented here.

`--url` support ships in the next `@odingard/guardian-mcp` release (see the
CHANGELOG); until it is published, build it from this repository.

## Maritime: env-only configuration

Maritime configures ZeroClaw through `ZEROCLAW_*` environment variables.
ZeroClaw maps `ZEROCLAW_<path with __ separators>` onto the same paths as
`zeroclaw config set`, for example
`zeroclaw config set mcp.servers.files.command /usr/local/bin/node`. Whether
list values (`args`, `allowed_tools`) and `[[mcp.servers]]` entries can be set
that way is **not confirmed**; check it on your build before relying on it.
