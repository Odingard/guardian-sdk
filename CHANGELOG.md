# Changelog

## Unreleased

### Added: Codex and DeepSeek Harness

### Not governed by the Codex and DeepSeek Harness hooks (read before relying on it)

- **Codex `write_stdin`**: Codex runs no hook for input typed into an open unified-exec session, so commands typed into a `bash` started with `exec_command` skip Guardian. Starting the session is Ask tier (`shell_session`); turn unified exec off (`[features] unified_exec = false` in a managed `requirements.toml`) to close the gap.
- The shell routing is a local pattern match: an obfuscated command (quoting, `git -C . push -f`, escapes, base64) can land in the Allow tier.
- A missing or unparseable hook config (Codex `hooks.json`, dsh `guardian-hooks.json`) governs nothing; an Allow-tier file edit can rewrite it unless it is managed or read-only.
- Codex and the dsh bridge both **let a call run when the hook process fails** (crash, timeout, cannot start). The hook turns every failure it sees into a deny, and the documented command ends in `|| … exit 2` so a hook that cannot start blocks; a hook killed from outside still fails open.
- Codex: hosted tools (`WebSearch`), other local tools, and tool paths Codex runs without hooks. dsh: every tool the matcher does not name, including `run_code` itself, `subagent`, `workflow`, `plugin_manager`, `load_workspace_dependencies`, `stagehand_act`/`stagehand_navigate`, `send_message`, `job_*`, `schedule_*`, `web_search`, read-only tools; `terminal_send` is checked per message.
- Not yet confirmed live: hooks under Codex's `--dangerously-bypass-approvals-and-sandbox`; the dsh bridge in Maritime's image and its tool names as passed to hooks.

### Added: OpenClaw

- **`@odingard/guardian-openclaw` 0.1.0** (new, unpublished): a native OpenClaw plugin. Its `before_tool_call` hook, registered with no matcher, sends every consequential tool call to Guardian before it runs.
  - Shell commands use guardian-hook's classifier (`shell`, `shell_deploy`, `shell_destructive`, `git_push`). File edits become `file_write` with a digest. `web_fetch` maps directly, MCP tools become `mcp.<server>.<tool>` (Composio included), and every other tool becomes `openclaw.<tool>` on the Ask tier. Only a short list of read-only tools is skipped.
  - ALLOW redeems the capability, then runs the call with exactly the parameters Guardian saw. ASK waits for a person in Guardian; OpenClaw's own `/approve` is never the authority. DENY and every failure return `block: true`.
  - Fails closed on missing config, an unreachable Guardian, a crash, a timeout, a cancelled call, or a non-string command, path or URL. It never claims or redeems after OpenClaw's hook timeout, and it reads the operator's `hooks.timeouts.before_tool_call` (set it to 330000 ms).
  - The credential comes only from the Gateway environment, is removed from `process.env` so `exec` children do not inherit it, and is never logged.
  - Loaded by OpenClaw 2026.7.1's plugin loader (`npm-pack:` install, `plugins inspect --runtime`) and run through its real tool-hook wrapper. **Not yet proven live on Maritime.** The README lists what is not governed.
  - Security review fixes: `process` input is classified from the exact bytes OpenClaw writes (`data`, `text`, `literal` + `hex` + `keys`), a decoy field blocks the call, and process input is never on the everyday tier (`openclaw.process_input`). Calls that drive the `openclaw` CLI or change `openclaw.json`, the OpenClaw state directory or the plugin's files go to the Ask tier as `shell_destructive`, because OpenClaw hot-reloads its config and one everyday call could otherwise switch Guardian off. An `exec` with env overrides is never everyday. Code Mode's `exec` is governed as `openclaw.code_mode_exec`. Obfuscated commands can still get past these patterns; the README says how to close that (make the config unwritable by the user exec runs as).
  - Path fixes: `write`, `edit`, `apply_patch`, `read` paths and the `exec` `workdir` are matched both raw and normalised as OpenClaw 2026.7.1's file tools resolve them (leading `@` dropped, unicode spaces, `file://` URLs decoded with percent-escapes, `~` expanded, `.`/`..` collapsed), with a segment-wise, case-insensitive state-directory match. A path that cannot be normalised (a bad `file://` URL, a `file://` URL with a host other than `localhost` or an encoded `/`, any other `scheme://`, a NUL byte) fails closed to the Ask tier and is flagged `pathUnresolved`, for `read` too. An `exec` whose `workdir` is in the state directory or a control root is Ask tier. The `openclaw` CLI is recognised quoted or escaped (`"openclaw"`, `o'p'enclaw`), and `plugins.entries.guardian` and `plugins disable|uninstall|remove …guardian` are Ask tier whatever runs them. Control roots from the environment expand `~`, are normalised and are matched case-insensitively (macOS APFS). The legacy `~/.clawdbot` state directory and `clawdbot.json` are control plane too. `apply_patch` headers with leading whitespace are read, as OpenClaw trims header lines. Any `exec` that creates a symbolic or hard link (`ln`, `link`, `cp -s`/`-l`, `mklink`, `-ItemType SymbolicLink`, `symlink`/`link` calls in Python, Node, Perl, Ruby) is Ask tier, so `ln -s .. s` then `write s/extensions/guardian/index.js` is no longer two everyday calls.
  - **Install integrity (new primary defence, fail closed).** Security review kept finding everyday ways for the agent to disable Guardian by changing OpenClaw's state directory, because its default workspace is inside it (`mv ../extensions/guardian x`, `cp -r evil/. ..`, `tar -C ..`, `git --work-tree=..`, pathlib `symlink_to`, `cp --sym`, `FileUtils.ln_s`, `perl -e 'symlink …'`). Pattern matching cannot close that class, so tamper-resistance is now a deployment precondition the plugin enforces: on load and before every tool call (cached at most 5 s) it checks whether the OpenClaw process user can change the plugin's own directory (real path, every file), `<state>/extensions/guardian`, the OpenClaw config OpenClaw would load (`OPENCLAW_CONFIG_PATH`, or the candidates up to the first existing one, `openclaw.json5` beside it), `<state>/extensions/`, the start-up dotenv files (`<config dir>/.env`, `~/.config/openclaw/gateway.env`), and every parent directory that would let it rename them. Owned entries count as writable (the owner can `chmod`) unless immutable or on a read-only mount; a Gateway running as root always fails; errors count as writable. While any is writable, every tool call is blocked and Guardian is never asked; the message says how to fix it. The README has a "Required: protect the install" section with the commands for Maritime's container.
  - Opt-out: `GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL=1`, read once from the Gateway's environment at load, keeps the pattern-based behaviour and logs one warning. In that mode the agent can switch Guardian off; the README says not to claim it as tamper-proof.
  - Pattern backstops added for the misses above: pathlib `symlink_to` / `hardlink_to`, `cp --s…` / `--l…` abbreviations, `FileUtils.ln*`, any `symlink` / `link` / `ln_s` word in inline interpreter code, and `..` path operands in `exec` commands whose cwd may be the workspace (Ask tier).
  - Install integrity, second pass. **The plugin is now self-contained:** `dist/index.js` bundles the Guardian SDK and zod (no `--external`; the SDK moved to `devDependencies`) and imports only Node.js builtins, so nothing it loads sits outside the checked plugin directory (an `npm:` install used to put the SDK in a sibling `node_modules/@odingard/guardian-sdk` the agent could rewrite). A test builds with the real build command and fails if the output imports anything else. As a second line, the check resolves every non-builtin import in the plugin's entry files and `package.json` dependencies from the plugin's real path as Node.js would, and checks the package found, its parents, and every nearer `node_modules` where a shadowing copy could be created; an import it cannot find blocks. **The real install locations are covered:** OpenClaw 2026.7.1 puts `npm:` / `npm-pack:` installs in `<state>/npm/projects/<name>/node_modules/@odingard/guardian-openclaw` and local-path installs in `<state>/extensions/guardian`; the check now requires the whole `<state>/npm` tree and `<state>/hooks` (managed hooks, imported into the Gateway) to be unwritable, or impossible to create. The README's Maritime recipe now protects `npm/` and `hooks/` too, and was run end to end on a real 2026.7.1 layout as uid 1000 (install, check failing, recipe as root, check passing, `plugins inspect --runtime` loading the hook, tamper attempts refused); not on Maritime itself. **The Gateway's working-directory `.env`** (which OpenClaw loads, without filtering `GUARDIAN_*`) is now checked like the other start-up env files, and any `GUARDIAN_*` key named in it (the opt-out, the credential, the connection ids and the other settings) is ignored with a warning: Guardian settings are honoured only from the Gateway's real start-up environment or the protected `<state>/.env`. **Not governed, now documented:** OpenClaw's state database `<state>/state/openclaw.sqlite`, which the Gateway must write, holds the installed-plugin index; rewriting the `guardian` entry there made OpenClaw 2026.7.1 load a different directory as `guardian` (checked by running it), so an agent that can write it and get the Gateway restarted can swap Guardian out. The mitigation is to run the agent's tools as a different user or in OpenClaw's sandbox. Workspace-origin plugins and hooks (disabled by default) are listed as not checked.
  - Install integrity, third pass (root upkeep and npm). The Maritime recipe left `$HOME` (`/data`) group-writable for `node`, so the Gateway user could create `/data/.npmrc` and owned `/data/.npm`; the documented upkeep ran `HOME=/data openclaw plugins install/update` as root, and OpenClaw 2026.7.1 runs npm with the caller's environment and no `--userconfig` (and drops any `npm_config_cache` it is given), so root would install from a registry `node` chose and the re-lock would make the result root-owned. The check now also covers the npm user config (`$HOME/.npmrc` or `npm_config_userconfig`) and global config (`<node prefix>/etc/npmrc`, `npm_config_globalconfig`, `npm_config_prefix`), `<state>/mpm/` and `<state>/plugins/` (plugin catalogs, the legacy `plugins/installs.json`), and `openclaw.json.bak` / `.bak.*` (OpenClaw restores the config from `.bak`): each must exist read-only or be impossible to create. The recipe refuses linked paths before it `chown`s anything, writes an empty root-owned `/data/.npmrc`, removes `/data/.npm`, creates `mpm/`, `plugins/` and `openclaw.json.bak` root-owned. A new Upkeep section: as root, `HOME=/root` from `/root` with `NPM_CONFIG_USERCONFIG=/dev/null`, an empty root-owned global config (npm refuses `/dev/null` for both), `NPM_CONFIG_CACHE=/root/.npm` and an explicit registry; edit `openclaw.json` directly instead of running the `openclaw` CLI as root (it would run OpenClaw, and the plugin code the Gateway-writable state database names, as root); update Guardian by unpacking the published tarball into the plugin directory; after every upkeep compare the installed `dist/index.js` sha256 (and `diff -r`) with the tarball, then re-lock. The README says a Gateway started from a writable working directory is blocked, and lists what stays unchecked (npm's cache, builtin `npmrc`, `.npmrc` in another command's cwd, catalog paths from the environment, running the CLI as root). Recipe and upkeep re-run end to end as uid 1000 on a real 2026.7.1 layout, with a planted `.npmrc` naming another registry.
- `examples/openclaw/`: a SIMULATED run inside OpenClaw's real hook runtime (step 0 now shows a writable install blocked; the rest uses the opt-out), and the LIVE Maritime recipe (`/data/.openclaw/openclaw.json`, with the new "protect the install" step).

### Added: Hermes Agent

- **Python `odingard_guardian.hermes`**: a Hermes Agent (Nous Research) plugin. `pip install odingard-guardian` registers it with Hermes as `guardian` (entry point `hermes_agent.plugins`); it stays off until listed in Hermes' `plugins.enabled`.
  - It is Hermes' `pre_tool_call` hook, which runs before every tool call. Terminal commands are split like `@odingard/guardian-hook` (`shell`, `shell_deploy`, `shell_destructive`, `git_push`); `write_file`/`patch`, `web_extract`, `execute_code`, browser tools, `computer_use`, cron changes, `delegate_task` and `mcp__<server>__<tool>` each map to a Guardian tool; any tool it does not know is governed as `hermes_other`. Read-only tools are not routed.
  - ALLOW redeems the capability, then Hermes runs the tool. ASK waits for a person, with the same final check before the window closes as guardian-hook. Every Guardian call, the redeem included, is started only if it can finish inside Hermes' `plugins.hook_callback_timeout`, so no receipt is recorded for a call Hermes already gave up on. A retry of the same call in the same Hermes process claims the open request; open requests are kept in memory only, never in a file the agent could rewrite to spend one approval on a different call.
  - Writes to Hermes' own home (`config.yaml`, `.env`, `plugins/`) or to the plugin, reading `$HERMES_HOME/.env`, and commands naming them or `GUARDIAN_*` are routed as `hermes_config` (needs approval), so the agent cannot switch Guardian off through an everyday edit. This is pattern-based; the README says what it misses.
  - The credential is moved out of `os.environ` when the plugin loads and before each call, so Hermes' tool subprocesses do not inherit it. Arguments Hermes coerces after the hook (a non-string `command`, a bare-string `urls`) are governed as their raw value, and every terminal argument (`timeout`, `pty`, …) is part of the proposal.
  - It fails closed: missing settings, a non-https URL, Guardian unreachable, a crash, a timeout or an unapproved ASK all block. Messages never include the credential or the error text.
  - Not governed: read-only tools, anything outside Hermes' tool dispatch, `HERMES_SAFE_MODE`, a failure in Hermes' own dispatcher (which Hermes treats as no block), other plugins' `modify` directives, shell commands the patterns miss (they run as `shell`), config edits through a path built at run time, a credential read from `.env` or `/proc`, and in `GUARDIAN_HERMES_MCP=proxy` mode every `mcp__*`/`mcp_*` tool not behind guardian-mcp. Not yet proven live.
- `examples/hermes/`: setup for Hermes and Maritime's hermes template, a `config.yaml` (plugin plus the `guardian-mcp proxy` recipe for MCP servers), and `hermes_hook_demo.py` (SIMULATED unless Guardian settings are set; Hermes itself is simulated).

- **guardian-hook: OpenAI Codex CLI** (`guardian-hook codex`). Governs Codex's `Bash` (shell and unified exec), every `apply_patch` file edit and MCP tools. A patch is decided on its target paths and operations (`add`, `update`, `delete`, `move`) plus a size and SHA-256 digest; the patch text is never sent. Allow prints nothing; deny prints the deny JSON, writes the reason to stderr and exits 2. `guardian-hook codex setup` prints the `hooks.json`. Maritime's Codex template needs `--dangerously-bypass-hook-trust` on its `codex exec` (or a managed `requirements.toml` hook), or Codex skips the hook.
- **guardian-hook: DeepSeek Harness** (`guardian-hook dsh`), through dsh's `@deepseek-ai/dsh-hooks-claude-code` bridge. Knows dsh's tool names: `bash`, `pwsh`, `terminal_send`, `write`, `edit`, `apply_patch`, `str_replace_editor` (all but `view`), `web_fetch`, `mcp__*`; the shipped matcher names all of them plus Claude Code's names. A deny also exits 2.
- New Ask-tier tool **`shell_session`**: starting an interactive shell, interpreter, database client, `ssh` or `docker exec -it` session (what is typed into it later is not seen). Register it on the needs-approval connection; until then such calls are denied.
- The hook's deadline now also covers reading stdin, and the hook answers as soon as a complete JSON object arrives, so an agent that leaves stdin open gets an answer rather than a hang. Patch headers that are indented or CRLF-terminated are read.
- The hook has its own hard deadline (`GUARDIAN_HOOK_DEADLINE_MS`, default and maximum 540 s): past it, it denies, so it never reaches the agent's 600 s hook timeout. Crashes, uncaught errors and unparseable input deny in the agent's format. Applies to Claude Code too; Claude Code's output is otherwise unchanged.
- `examples/agent-hooks.mjs` (SIMULATED), `examples/codex/` and `examples/deepseek-harness/` (LIVE recipes, including Maritime).

### Added: remote MCP upstreams

- **guardian-mcp:** `guardian-mcp proxy --url <https-url> [--transport streamable-http|sse] [--header "Name: ${ENV_VAR}"]` fronts a remote MCP server, such as Composio or Maritime Computers, over Streamable HTTP (default) or SSE. Not yet proven live: tested against local MCP servers and a fake Guardian only. The agent still talks stdio. Every `tools/call` is decided by Guardian exactly as for a stdio server; `tools/list` passes through with `guardian_claim` and `guardian_receipt` added. Stdio proxying is unchanged.
  - Header and URL values are expanded from `${ENV_VAR}` by guardian-mcp itself, are never printed, and stay in the proxy. Expanding a missing variable or any `GUARDIAN_*` variable is refused, so the agent credential cannot reach the remote server.
  - `https://` only (plain `http://` for localhost), no user name or password in the URL, and no redirects to another origin.
  - Fails closed: an unreachable server or a rejected key at startup exits with a scrubbed one-line message and serves no tools. A remote failure after ALLOW is reported as "may or may not have run", and the capability is not redeemed.
  - `guardian-mcp tools --url …` lists a remote server's tools with suggested modes.
  - An upstream result is never read as a Guardian decision, so a remote server cannot hold, swap or hide a call by returning a `guardian` field. A `tools/list` failure shows the agent a generic message, never the upstream's error text. Two concurrent `guardian_claim` calls for one request forward it once. Error messages also scrub identifier-like URL path segments.
  - Not governed: a call that may have run after ALLOW but whose result was lost (timeout, dropped session) has no receipt; code in the same container can read the upstream key from its own environment.
  - Not supported: OAuth sign-in flows (use an API key or bearer header).
- **guardian-mcp:** a tool call made while the upstream's tool list cannot be fetched now returns a "nothing was forwarded" error instead of an MCP protocol error.
- `examples/remote-mcp.mjs`: the real CLI in front of a local Streamable HTTP server. SIMULATED by default (fail closed); LIVE with Guardian settings.
- `examples/zeroclaw/`: recipe that wraps ZeroClaw's MCP servers in guardian-mcp and switches off its built-in tools. ZeroClaw's built-ins (shell, file writes, HTTP, browser, cron, delegation) cannot be governed from outside; its images ship no Node.js.
- `examples/byo/`: CrewAI, LangGraph and AutoGen recipes. Each must keep one MCP session open (`MCPServerAdapter`, `client.session(...)`, `McpWorkbench`), because their default per-call sessions drop a held ASK.
- `packages/mcp` has a `typecheck` script.

### Fixed

- **guardian-hook:** an approval made in the last seconds of the 5-minute window was missed, because checks backed off to every 10 s on the hook's own clock (seen in a live run). The hook now times the window from when the request was created and always checks once more 1.5 s before it closes.

## guardian-hook 0.2.0, released 2026-11-06

### Added

- **`@odingard/guardian-hook/agent-sdk`**: Guardian for agents built on the Claude Agent SDK.
  - `guardianHookMatcher()` and `guardianPreToolUse()` give a `PreToolUse` hook with the same decisions as the Claude Code hook: everyday commands run, and deploys, destructive commands and pushes wait for a person.
  - It fails closed.
  - The matcher sets `onFailure: "block"` and a timeout longer than the 5-minute approval window.
  - It type-checks against `@anthropic-ai/claude-agent-sdk` 0.3.318.
- `examples/claude-agent-sdk.mjs`: a Claude agent governed by Guardian. It is LIVE: it needs a real Claude key and Guardian agent.
- The Claude Code command line is unchanged. Its logic moved to `src/run.ts` so the new entry point can reuse it without running the CLI.

## sdk 0.3.7 / Python 0.1.4, released 2026-11-06

### Added

- `verifyBeforeActing(..., { amountField })`, and in Python `amount_field`, read the amount from the signed request body (e.g. Stripe's `amount`) when the receipt declares no value. With no declared value the amount is accepted only when a person approved the request; Python matches TypeScript on the new golden cases.
- `fetchReceiptVerificationKeys(baseUrl, { forReceipt })` (or `{ kid }`), and in Python `fetch_receipt_verification_keys(base_url, for_receipt=...)`. Guardian publishes at most 8 keys, its newest. This option returns a set that contains an older receipt's own signing key, so receipts signed by long-retired keys still verify offline.

### Fixed

- `verifyBeforeActing` and Python `verify_before_acting` read the request body only for a known JSON or form content type; anything else (missing, repeated, unknown) is refused. Before, a JSON body sent as `text/json` or `application/merge-patch+json` was read as a form, so a smuggled `amount=` could pass. Python also refuses `NaN` and `Infinity` in a JSON body, reads deeply nested JSON as JavaScript does, drops one leading `?` from a form body, and now needs Python 3.9.2+ so `;` never splits a form.
- The body is read only as UTF-8: a `charset` other than `utf-8`, or any other content-type parameter, is refused, because a receiver honouring it could decode different keys. A form key that is the field with spaces around it (`& amount=`, which Rack reads as a second `amount`) is refused as ambiguous. TypeScript no longer reads inherited names such as `constructor` as fields, and Python trims the currency exactly as JavaScript does.

### Added, Python 0.1.4: "verify, don't trust"

- `verify_before_acting(receipt, keys, expected, ...)` and `fetch_receipt_status(base_url, receipt)`, the Python port of the TypeScript helpers.
- `fetch_receipt_verification_keys(..., for_receipt=receipt)` for receipts signed by older keys.
- Its verdicts match the TypeScript SDK on 35 golden cases: genuinely signed receipts covering every refusal and success, generated by `scripts/gen-vba-fixtures.ts`.

## sdk 0.3.6, released 2026-11-05

### Added: "verify, don't trust"

- **`verifyBeforeActing(receipt, keys, expected, options)`**, for the side that receives an agent's request (a bank, a merchant, another agent). It returns OK only if all of these hold:
  - the receipt is valid offline;
  - the received request equals the authorized action field for field;
  - Guardian allowed it, or a person approved it;
  - it is not revoked, expired or already used;
  - amount, destination and currency match;
  - it is fresh;
  - it was not already acted on (optional);
  - Guardian still reports it active (optional).
- **`fetchReceiptStatus(baseUrl, receipt)`** calls the public `POST /v1/receipts/status`. The reply is only a status.
- A receipt with no issued capability is refused (`NOT_ISSUED`), and so is one whose capability expired (`EXPIRED`), even while the action's window is still open.
- 15 tests on genuinely signed receipts.

## sdk 0.3.5 / guardian-hook 0.1.1, released 2026-11-05

### Fixed

- **An ASK expired after 2 minutes while the hook waited 9.** The SDK always asked Guardian to keep a request open for 120 s, so an approval that came later found the request already expired.
  - SDK: new `ttlMs` on `request()`, a whole number from 1 to `GUARDIAN_MAX_REQUEST_TTL_MS` (300000, Guardian's limit). The default is still 120000. Invalid values are refused before anything is sent.
  - guardian-hook: asks for the full 5 minutes and waits up to that long (`GUARDIAN_HOOK_APPROVAL_TIMEOUT_MS`, default and maximum 300000). It needs sdk ^0.3.5.

## sdk 0.3.4 / Python 0.1.3, released 2026-11-05

### Added

- **Money fields on governed actions:**
  - TypeScript: `valueCents`, `merchantId`, `merchantCategory`, `recurring` on `api.request` and other governed invocations.
  - Python: `value_cents`, `merchant_id`, `merchant_category`, `recurring`.
  - The amount is bound into the action, so grant caps, "ask above" and approvals apply to it. Guardian's executor refuses a request that moves more money than this.
  - Money-moving endpoints (for example Stripe refunds) **require** it. Without it the request is refused.
  - Invalid values are rejected before any network call.

## sdk 0.3.3, released 2026-11-05

### Security

- `@odingard/guardian-sdk` no longer pins `zod` to 4.6.5, which is
  affected by GHSA-mrhx-c7xc-m3w5 (memory exhaustion while validating
  oversized constrained collections, high). It now depends on `^4.6.7`.
  No API change.
- Dev-only: updates Vitest 3.x to `^5.1.0` across all workspaces, clearing
  the critical Vitest and `tinypool` advisories and the moderate
  `@vitest/mocker` advisory. These testing dependencies are never shipped
  to users.

## guardian-hook 0.1.0 (new package), released 2026-11-05

A Claude Code `PreToolUse` hook that routes shell
commands, file writes, web fetches and MCP tool calls through Guardian.

- Shell commands are routed by consequence: `shell`, `shell_deploy`,
  `shell_destructive` and `git_push`. That routing is what lets deploys
  wait for a phone approval while ordinary commands run under Allow.
- ALLOW redeems the capability before the agent runs the call.
- ASK waits for a human (never auto-approved).
- DENY, timeouts and an unreachable Guardian all fail closed.
- `guardian-hook setup` prints the console steps and the `settings.json`
  snippet; `guardian-hook classify <cmd>` shows the routing.
- Claude Code only. Cursor and Codex follow once their hook contracts are
  verified.
- **Two connections, one per risk tier.** Guardian modes are per
  connection, so Allow-tier tools go to `GUARDIAN_CONNECTION_ID` and
  Ask-tier tools go to `GUARDIAN_HOOK_ASK_CONNECTION_ID`. Found in a live
  run, where a read-only `ls` waited for approval.

## 0.3.2 (TypeScript: sdk, mcp) / 0.1.2 (Python), released 2026-11-05

### Fixed

- **`verifyReceiptOffline` / `verify_receipt_offline`** now accept the
  result of `fetchReceiptVerificationKeys()` /
  `fetch_receipt_verification_keys()` as returned (`{ ok: true, keys }`),
  as well as the key set itself. Before, passing the fetch result
  straight in returned `MALFORMED_RECEIPT`. A failed fetch result never
  verifies.

## guardian-mcp: `tools` command, released in 0.3.2 on 2026-11-05

- `guardian-mcp tools [--json] -- <server command>` lists an MCP server's
  real tools with a suggested Guardian mode for each. It uses the
  server's `readOnlyHint` and `destructiveHint` annotations first, then
  the tool's verb, and anything unclear is Ask.
- It flags tool names Guardian would reject. No credential is needed.

## guardian-langchain / guardian-vercel-ai 0.3.1, released 2026-11-05

sdk 0.3.1, guardian-mcp 0.3.1 and Python 0.1.1 were never published; these changes first shipped in sdk and guardian-mcp 0.3.2 and Python 0.1.2.

First-run fixes found in a production run.

### Changed

- **`createGuard` (TypeScript) and `Guard` (Python)** no longer propose a
  first-use `mcp.install` registration by default
  (`installRecordTransport` / `install_record_transport` default to
  `false`).
  - Production denies that registration unless the agent's grant pins
    `mcp.install`, so the default made the first call fail.
  - Register the tool once in the console as "My own code (record-only)".
- **`guardian-mcp proxy`** does the same: auto-registration is now opt-in
  with `GUARDIAN_AUTO_REGISTER=true`.

### Added

- **`GuardianDenied.hint`** (Python: `GuardianDenied.hint`) and
  **`denialHint()`** / **`denial_hint()`** give the developer's next step
  for:
  - a denied registration;
  - an `INVALID_REQUEST` tool denial (the tool is not registered or not
    allowed for the agent);
  - `PLAN_LIMIT_EXCEEDED`.

  In `onDeny: "result"` mode the hint is included in the message returned
  to the model. Decisions and reason codes are unchanged.

### Fixed

- Structured denials that carry `code` instead of `reasonCode` (for
  example `PLAN_LIMIT_EXCEEDED`) are reported with their real code, not
  `HTTP_403`.

The LangChain and Vercel AI adapters keep their auto-registration default
and gain the same hints.

## 0.3.0 (TypeScript) / 0.1.0 (Python), released 2026-11-04

- `createGuard` / `guard`: govern your own action code from any framework.
- `guardian-mcp proxy`: put Guardian in front of any stdio MCP server.
- LangChain and Vercel AI adapters share the core triad.
- Python SDK `odingard-guardian`: sync and async client, `Guard` decorator,
  offline receipt verification.
