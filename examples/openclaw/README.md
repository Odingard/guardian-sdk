# OpenClaw, governed by Guardian

Two ways to see `@odingard/guardian-openclaw` work:

| What                             | Label         | Needs                                                              |
| -------------------------------- | ------------- | ------------------------------------------------------------------ |
| `simulated-openclaw-runtime.mjs` | **SIMULATED** | Node 22. Nothing else: Guardian is a stand-in.                     |
| The official-image recipe below  | **LIVE**      | An OpenClaw agent on the official image and a real Guardian agent. |

**Not yet proven live.** The LIVE recipe has not been run end to end yet.

## SIMULATED: the plugin inside OpenClaw's real tool-hook runtime

```bash
npm run build -w packages/openclaw     # from the repo root
cd examples/openclaw && npm install && npm run simulated
```

It installs OpenClaw 2026.7.1, registers the
plugin's handler with OpenClaw's own hook runner, and calls tools through
OpenClaw's own `before_tool_call` wrapper. Guardian is an in-memory stand-in
(no signing, no receipts). Step 0 runs the plugin's real install-integrity check against this checkout,
which you can write (or which runs as root), so every call is blocked and
Guardian is never asked. Steps 1-5 then use
`GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL=1` (the opt-out) to show the
decision flow; a real Gateway must protect its install instead. Expected
output:

```
0. everyday command, writable install    → blocked: the install is not protected
1. everyday command (allowed)            → capability redeemed, exec RAN
2. read-only tool                        → read RAN, Guardian not asked
3. deploy (a person approves)            → held, approved, redeemed, exec RAN
4. destructive command (nobody approves) → held, blocked: nothing ran
5. Composio email via MCP                → blocked: NOT_AUTHORIZED
```

## LIVE: the official OpenClaw image

This recipe is for an agent on the official image
`ghcr.io/openclaw/openclaw:2026.7.1`, where the agent's config is
`/data/.openclaw/openclaw.json`. Run the `openclaw` commands in a shell in
the container with `HOME=/data`, or they write config the Gateway never reads.

1. **Guardian console.** Agents → New agent → Create agent, and copy the agent
   credential (shown once). Then on the agent's page, Set up for Claude Code.
   It creates (or reuses) two connections, "Coding agent — everyday" (Allow)
   and "Coding agent — needs approval" (Ask), and allows `shell`, `file_write`,
   `web_fetch`, `shell_deploy`, `shell_destructive`, `git_push` and
   `shell_session`; it does not create the agent. Copy both `pcn_…` ids. A tool
   must be on a connection before it can be allowed: on "Coding agent — needs
   approval", use "Add tools" (under Connections) for `openclaw.message`,
   `openclaw.browser` and `mcp.composio.<tool>` for each Composio tool you
   expose, then "Allow a tool by name" for each on the agent's page.

2. **Agent environment.** Add `GUARDIAN_AGENT_CREDENTIAL` to the agent as a
   **secret** environment variable, the same way you pass its model API key.
   (The connection ids may go
   here too, as `GUARDIAN_CONNECTION_ID` and
   `GUARDIAN_HOOK_ASK_CONNECTION_ID`, instead of in `openclaw.json`.)

3. **Container shell.** Install and enable the plugin:

   ```bash
   HOME=/data openclaw plugins install npm:@odingard/guardian-openclaw@0.1.0 --pin
   HOME=/data openclaw plugins enable guardian
   ```

   Before the package is published, upload the packed tarball to the agent
   and use `HOME=/data openclaw plugins install npm-pack:/data/odingard-guardian-openclaw-0.1.0.tgz`.

4. Merge [`openclaw.json`](openclaw.json) from this folder into
   `/data/.openclaw/openclaw.json`, replacing the two `pcn_REPLACE_…` ids. It
   enables the plugin, sets `hooks.timeouts.before_tool_call` to 330000 ms
   (the 5-minute approval window plus time to redeem), and sets the
   connections. `HOME=/data openclaw config validate` must say "Config valid".

5. **Protect the install** (required: until you do, every tool call is
   blocked). As root in the container, run the commands in the package
   README, [Required: protect the install](../../packages/openclaw#the-official-openclaw-image):
   `extensions/`, `npm/` (where `npm:` / `npm-pack:` installs put the
   plugin), `hooks/`, `mpm/`, `plugins/`, `openclaw.json`,
   `openclaw.json.bak`, the `.env` files and an empty `/data/.npmrc`
   root-owned and read-only, `/data`, `/data/.config` and `/data/.openclaw`
   root-owned and sticky. Later config changes and Guardian updates follow
   the package README's
   [Upkeep](../../packages/openclaw#upkeep-config-changes-and-guardian-updates):
   never `HOME=/data openclaw …` as root, and verify the installed plugin
   against the published tarball before re-locking.

6. **Restart the agent**, then check the hook:

   ```bash
   HOME=/data openclaw plugins inspect guardian --runtime --json
   ```

   `typedHooks` must list `before_tool_call`. If the Gateway log says
   "Guardian plugin is not configured", governed calls are being blocked
   until you fix the environment; if it says "the install is not
   protected", every call is blocked until you redo step 5.

7. **Prove it** (keep the receipt digests):

   ```bash
   # Send the agent each of these as a chat message:
   #   "List the files in your workspace"       runs: shell, allowed
   #   "Run: rm -rf /data/scratch"              held; approve in Guardian; then runs
   #   "Run: terraform destroy -auto-approve"   held; do not approve: never runs
   ```

   With Composio connected (`HOME=/data openclaw mcp set composio …`, then
   restart), `composio__GMAIL_SEND_EMAIL` waits for a
   person in the same way. Verify the receipts offline with
   `examples/verify-receipt.mjs`.

The approval is made in Guardian, not with OpenClaw's `/approve`. Guardian's
decision is the only one that lets a governed call run.

## What is not governed

See the package README: [packages/openclaw](../../packages/openclaw#what-is-not-governed).
In short: the plugin refuses to run while the agent could change its files
or the config (protect the install, step 5); whoever can still change them
(root, the operator) can remove Guardian; read-only tools
are not checked; the Gateway's start-up environment
(`/proc/<pid>/environ`) still holds the credential for anything running as the
same user; a host's own built-in integrations (such as a "Connect Gmail"
button) have not been checked and may not reach the agent as a tool call.
