# OpenAI Codex CLI, governed by Guardian

Guardian's hook runs as a Codex `PreToolUse` command hook. Every shell
command Codex starts, every `apply_patch` file edit and every MCP call goes to
Guardian before it runs (input typed into an already open session with
`write_stdin` does not; see [What is not governed](#what-is-not-governed)):

- everyday commands (`ls`, `npm test`) and file edits run under **Allow**;
- deploys, destructive commands and pushes (`terraform apply`, `rm -rf`,
  `git push`) wait until a person approves that exact action;
- anything Guardian denies, or that nobody approves within 5 minutes, does
  not run;
- every allowed call leaves a receipt you can verify offline.

Guardian sees the command, or for a patch only its target paths and
operations plus a size and SHA-256 digest. It never sees file contents.

Status: tested with simulated Codex payloads and a stand-in Guardian (the Codex tests in `packages/hook`, and `node agent-hooks.mjs codex`). **Not yet proven live:** no real Codex run against a real Guardian yet, locally or hosted.

## SIMULATED: see what Codex would receive (no account needed)

```bash
cd examples && npm install
node agent-hooks.mjs codex
```

It feeds Codex-shaped `PreToolUse` payloads to the hook with a local
stand-in Guardian, and prints the exit code and output Codex gets: nothing
and exit 0 to allow, deny JSON plus stderr and exit 2 to block.

## LIVE: real Codex, real Guardian

1. In the Guardian console, create the agent and its two connections
   (**Agents → Set up for Claude Code**; the same setup serves Codex), and
   allow each tool by name: `guardian-hook codex setup` lists them.
2. Install the hook where Codex runs: `npm i -g @odingard/guardian-hook`.
3. Copy [`hooks.json`](hooks.json) to `~/.codex/hooks.json` (or your repo's
   `.codex/hooks.json`). Keep `timeout` at 600.
4. Export `GUARDIAN_AGENT_CREDENTIAL`, `GUARDIAN_CONNECTION_ID` and
   `GUARDIAN_HOOK_ASK_CONNECTION_ID` in the shell that starts Codex.
5. Trust the hook: `/hooks` in the Codex TUI, or headless:

   ```bash
   codex exec --dangerously-bypass-hook-trust \
     "List the files here, then run terraform apply -auto-approve in ./infra"
   ```

   `ls` runs; `terraform apply` waits for your approval on your phone. An
   untrusted hook is skipped by Codex, and then nothing is governed.

For a fleet, deliver the hook as a managed hook instead; see
[`requirements.toml`](requirements.toml).

## Hosted Codex agents (`codex exec`)

Some hosts run each chat message as
`codex exec --dangerously-bypass-approvals-and-sandbox`, with Codex's config
under `/data/.codex`. Such a host's Codex image needs a custom build to:

1. install `@odingard/guardian-hook` in the image;
2. write `hooks.json` to `/data/.codex/hooks.json` at boot;
3. **add `--dangerously-bypass-hook-trust` to its `codex exec` command**
   (or ship the managed `requirements.toml`). This is the setting a headless
   host needs; without it Codex skips the hook.

Then set the three `GUARDIAN_*` variables in the agent's settings (the
credential as a secret). Not yet confirmed live: that hooks fire under
`--dangerously-bypass-approvals-and-sandbox`, and which Codex version a host runs.

## What is not governed

- **`write_stdin`.** Codex runs no hook when it types into an open
  `exec_command` session, so a model can start `bash` (Guardian sees only
  that, routed to `shell_session`, Ask tier) and then type any command into
  it unseen. Turn unified exec off with `unified_exec = false` under
  `[features]` in the managed [`requirements.toml`](requirements.toml); then
  `exec_command` is one-shot and `write_stdin` is not offered (per Codex's
  source; not yet confirmed live).
- `apply_patch` deletes are `file_write` (Allow tier) under the suggested
  modes.
- A missing, untrusted or unparseable `hooks.json` governs nothing: check
  with a deny after every change.
- Hosted tools such as `WebSearch`, other local tools (`update_plan`,
  `spawn_agent`), and tool paths Codex runs without hooks.
- **If the hook process fails, Codex runs the call.** The hook turns every
  failure it can see into a deny (exit 2) and denies at its own 540-second
  deadline; the `|| … exit 2` in the command blocks when the hook cannot
  start. A hook killed from outside still fails open.
