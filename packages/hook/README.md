# @odingard/guardian-hook

**Guardian for coding agents.** A [Claude Code](https://code.claude.com/docs/en/hooks) `PreToolUse` hook that sends every consequential tool call (shell commands, file writes, web fetches, MCP tools) to Guardian before it runs. The same hook runs under [OpenAI Codex CLI](#openai-codex-cli) (`guardian-hook codex`) and [DeepSeek Harness](#deepseek-harness-dsh) (`guardian-hook dsh`).

- `npm test` runs under **Allow**.
- `terraform apply` waits until **you approve it on your phone**.
- `rm -rf` is **denied** if that is the mode you set.

There is no model in the decision: Guardian decides ALLOW / ASK / DENY deterministically from the permissions you set, and every allowed call carries a signed receipt you can verify offline.

## How it works

| Guardian says | What happens                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ALLOW**     | The hook redeems the single-use capability (revocation and expiry are checked now, and the receipt is recorded), then tells the agent to run the call.                       |
| **ASK**       | The agent waits. You get the request on your phone or in the console. On approval the hook claims and redeems the capability, then the call runs. It is never auto-approved. |
| **DENY**      | The agent is told no, with the reason. Nothing runs.                                                                                                                         |

**Fail closed.** If Guardian can't be reached, the configuration is wrong, approval times out or redemption fails, the call is denied. Each request stays open for 5 minutes (Guardian's limit), and the hook waits that long for an approval, under Claude Code's 600-second hook timeout, because a hook that times out does not block. An ASK not approved within 5 minutes expires; the call is denied and the agent can ask again.

## Tools the hook proposes

Shell commands are routed by consequence. That routing is what lets you put deploys behind your phone while ordinary commands flow freely.

**The routing is a local pattern match, not a security boundary.** It catches the plain spellings of consequential commands. A model that obfuscates a command can move it into the Allow tier: quoting (`"git" push --force`), options before the subcommand (`git -C . push -f`), escapes (`r\m -rf ~`) and decoded payloads (`sh -c "$(echo … | base64 -d)"`) all classify as `shell`. Under prompt injection, treat the Ask tier as advisory. Where that matters, set the everyday connection to **Ask me first** as well, or deny `shell` outright.

| Guardian tool         | Suggested mode | Covers                                                                                                                                             |
| --------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell`               | Allow          | Ordinary commands (build, test, inspect)                                                                                                           |
| `shell_deploy`        | Ask me first   | terraform/tofu apply and destroy, pulumi up, kubectl apply and delete, helm install and upgrade, cloud deploy CLIs, package publish, `gh pr merge` |
| `shell_destructive`   | Ask me first   | rm -rf, git reset --hard, git clean, force push, DROP/TRUNCATE, disk tools                                                                         |
| `git_push`            | Ask me first   | Pushing commits                                                                                                                                    |
| `shell_session`       | Ask me first   | Starting an interactive shell, interpreter, database client or remote session (`bash`, `python3`, `ssh host`, `docker exec -it`, `psql app`)       |
| `file_write`          | Allow          | Write and edit (the approver sees the path, size and a SHA-256 of the content; the content itself is not sent)                                     |
| `web_fetch`           | Allow          | Fetching a URL                                                                                                                                     |
| `mcp.<server>.<tool>` | your choice    | Any MCP tool, e.g. `mcp.github.create_pull_request`                                                                                                |

Read-only tools (Read, Grep, Glob, LS, WebSearch) are not routed through Guardian.

## Setup

Guardian sets modes **per connection**, not per tool. So the hook uses two record-only tool servers, one per risk tier. That lets `ls` run straight away while `terraform apply` waits for your phone.

1. In the Guardian console, go to **Connections → Register a tool server → record-only** and create two:
   - **"Coding agent — everyday"** with `shell`, `file_write` and `web_fetch`.
   - **"Coding agent — needs approval"** with `shell_deploy`, `shell_destructive`, `git_push`, `shell_session`, and any MCP tools you use. Until `shell_session` is allowed by name on that connection, starting an interactive session is denied (`INVALID_REQUEST`), which fails closed. `npx @odingard/guardian-mcp tools -- <server>` lists them.
2. Under **Agents**, open your coding agent:
   - set **Allow** on the first connection and **Ask me first** on the second;
   - on each connection's card, type every tool name into **"Allow a tool by name"** and press **Allow tool**, once per tool.

   Without this, every call is denied as `INVALID_REQUEST`.

3. In the shell that starts Claude Code, export:
   - `GUARDIAN_AGENT_CREDENTIAL`;
   - `GUARDIAN_CONNECTION_ID`: the everyday connection;
   - `GUARDIAN_HOOK_ASK_CONNECTION_ID`: the needs-approval connection;
   - `GUARDIAN_BASE_URL`: optional, defaults to `https://guardian-api.odingard.com`.

   With only `GUARDIAN_CONNECTION_ID` set, every tool shares that one connection and its single mode.

4. Add the hook to `.claude/settings.json` (one project) or `~/.claude/settings.json` (all projects):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__.*",
        "hooks": [
          {
            "type": "command",
            "command": "npx -y @odingard/guardian-hook",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

`npx @odingard/guardian-hook setup` prints all of this. To see where a command would be routed, run `npx @odingard/guardian-hook classify "terraform apply"`, which prints `shell_deploy`.

## Claude Agent SDK agents (0.2.0)

Agents built on Anthropic's Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) can be governed by Guardian in the same way:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { guardianHookMatcher } from "@odingard/guardian-hook/agent-sdk";

for await (const message of query({
  prompt: "Run the tests, then deploy staging",
  options: { hooks: { PreToolUse: [guardianHookMatcher()] } },
})) {
  if (message.type === "result") console.log(message.subtype);
}
```

It uses the same environment variables, the same two connections (the console's "Set up for Claude Code" creates them) and the same decisions as the Claude Code hook. Approvers see the agent as "Claude agent" unless you pass `agentName`.

`guardianHookMatcher()` registers the hook with:

- `onFailure: "block"`, so a crash blocks the call instead of letting it through (Agent SDK 0.3.317 or later);
- a timeout longer than Guardian's 5-minute approval window.

A `PreToolUse` hook runs for every tool call, even calls an allow rule or `bypassPermissions` would approve, and its deny holds in every permission mode.

A runnable example is in `examples/claude-agent-sdk.mjs`. For agents hosted on [Maritime](https://maritime.sh), where Claude Code runs unattended in its own VM, see `examples/maritime-claude-code/`.

## OpenAI Codex CLI

Codex runs `PreToolUse` command hooks with the same JSON as Claude Code ([Codex hooks](https://developers.openai.com/codex/hooks)). Run the hook as `guardian-hook codex`:

```bash
npm i -g @odingard/guardian-hook       # install it; do not rely on npx at hook time
guardian-hook codex setup              # prints the tools to register and the config below
```

`~/.codex/hooks.json` (or `<repo>/.codex/hooks.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Bash|apply_patch)$|^mcp__.*",
        "hooks": [
          {
            "type": "command",
            "command": "guardian-hook codex || { s=$?; [ $s -eq 2 ] || echo \"Guardian hook failed to run. Nothing ran.\" >&2; exit 2; }",
            "timeout": 600,
            "statusMessage": "Guardian is checking this action"
          }
        ]
      }
    ]
  }
}
```

Set the same `GUARDIAN_*` variables as for Claude Code in the environment Codex starts from. Approvers see the agent as "Codex".

**Hook trust.** Codex skips a non-managed hook until its exact definition is trusted. Trust it once with `/hooks` in the TUI, or for a headless run pass `codex exec --dangerously-bypass-hook-trust …`. To enforce it for every user, deliver it as a managed hook in `requirements.toml` with `allow_managed_hooks_only = true` and `[features].hooks = true`. A hook that is not trusted does not run, and nothing is governed.

| Codex tool                                     | Guardian tool                                                             | What Guardian sees                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Bash` (shell and unified exec `exec_command`) | `shell`, `shell_deploy`, `shell_destructive`, `git_push`, `shell_session` | The command that starts the process (bounded to 2,000 characters). **Not** what is later typed into it with `write_stdin`; see below.            |
| `apply_patch` (every file edit Codex makes)    | `file_write`                                                              | The target paths and operations from the patch headers (`add`, `update`, `delete`, `move`), its size and a SHA-256 digest. Never the patch text. |
| `mcp__<server>__<tool>`                        | `mcp.<server>.<tool>`                                                     | The MCP arguments (a digest above 2,000 characters).                                                                                             |

How a decision reaches Codex: an allow prints nothing and exits 0, which Codex treats as success (Codex documents `permissionDecision: "allow"` only together with `updatedInput`). A deny prints the deny JSON, writes the reason to stderr and exits 2; Codex blocks on either. The hook never returns `"ask"`, which Codex does not support and treats as a failed hook that lets the call run: on ASK the hook waits for the approval itself (up to 5 minutes) and then answers allow or deny.

### On Maritime's Codex template

Maritime's template runs each chat message as `codex exec --dangerously-bypass-approvals-and-sandbox`, with config under `/data/.codex`. To govern it:

1. Install `@odingard/guardian-hook` in the image (a forked template with a custom image, which Maritime documents) and write the `hooks.json` above to `/data/.codex/hooks.json` at boot.
2. Add `--dangerously-bypass-hook-trust` to the template's `codex exec` command, or deliver the hook as a managed `requirements.toml` hook. **This is the one setting the template needs**; without it the hook is skipped.
3. Set `GUARDIAN_AGENT_CREDENTIAL`, `GUARDIAN_CONNECTION_ID` and `GUARDIAN_HOOK_ASK_CONNECTION_ID` as agent environment variables (the credential as a secret).

`--dangerously-bypass-approvals-and-sandbox` turns off Codex's own approvals and sandbox; Codex documents hooks separately from approvals, but that hooks still fire under that flag on Maritime is **not yet confirmed live**. See `examples/codex/`.

### Not governed under Codex

- **`write_stdin`: input typed into an open unified-exec session.** Codex runs `PreToolUse` once, for the `exec_command` that starts the process, and never for `write_stdin` (Codex's hooks docs: "`write_stdin` is transport for an existing unified-exec session. It doesn't run `PreToolUse` again"; source: `write_stdin.rs` returns no pre-hook payload). So a model can start `bash` and then type `terraform apply` or `rm -rf` into it, and Guardian never sees those commands. The hook routes the start of an interactive shell, interpreter, database client, `ssh` or `docker exec -it` session to `shell_session` (Ask tier), so a person approves opening it, but once approved, what is typed is not governed, and a process that reads stdin in a way the patterns miss (for example a custom read-eval loop) is not caught. **To close the gap, turn unified exec off** in a managed `requirements.toml`:

  ```toml
  [features]
  unified_exec = false
  ```

  With it off, Codex registers `exec_command` as one-shot (runs to completion, no `tty`, no session) and does not offer `write_stdin` (Codex `spec_plan.rs`, `add_shell_tools`; the source notes that only managed requirements can keep it off). Not yet confirmed live. `examples/codex/requirements.toml` includes it.

- **`apply_patch` deletes and moves are `file_write` (Allow tier).** A `*** Delete File:` patch runs without approval under the suggested modes; the approver sees `delete <path>` in the operations. That is a policy choice: set the everyday connection to Ask if deletes must wait for a person.
- **A missing, untrusted or unparseable `hooks.json` governs nothing.** Codex skips it and runs every call. Check with a deny (for example `rm -rf ./tmp-guardian-check` should be blocked or wait for approval) after every config change.
- Hosted tools such as `WebSearch` (they do not use Codex's hook path), and any "specialized tool path" Codex runs without hooks; Codex itself calls hooks "a useful guardrail, not a complete enforcement boundary".
- Other local tools (`update_plan`, `spawn_agent`, …) are left to Codex. Whether a subagent's own tool calls reach the hook is not yet confirmed.
- **Codex lets the call run if the hook process fails** (crash, timeout, malformed output). The hook makes every failure it can see a deny: it catches crashes, exits 2 on deny, and has its own 540-second deadline under Codex's 600-second timeout. The `|| … exit 2` in the command turns a hook that cannot start into a block. A hook killed from outside, or a `timeout` set below the hook's deadline, still fails open; keep `timeout` at 600.

## DeepSeek Harness (dsh)

DeepSeek Harness runs Claude Code `PreToolUse` command hooks through its bridge plugin [`@deepseek-ai/dsh-hooks-claude-code`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/hooks/hooks-claude-code/README.md). Run the hook as `guardian-hook dsh`: it knows dsh's own tool names.

```bash
npm i -g @odingard/guardian-hook       # install it in the image or on the volume
guardian-hook dsh setup                # prints the tools to register and the config below
```

The bridge's hooks file, e.g. `/data/.dsh/guardian-hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(bash|pwsh|terminal_send|write|edit|apply_patch|str_replace_editor|web_fetch|Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch)$|^mcp__.*",
        "hooks": [
          {
            "type": "command",
            "command": "guardian-hook dsh || { s=$?; [ $s -eq 2 ] || echo \"Guardian hook failed to run. Nothing ran.\" >&2; exit 2; }",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

Mount the bridge in `$DSH_HOME/cordis.patch.yml` (`/data/.dsh/cordis.patch.yml` on Maritime):

```yaml
- insert:
    - id: guardian-hooks
      name: "@deepseek-ai/dsh-hooks-claude-code"
      config:
        configPath: /data/.dsh/guardian-hooks.json
        defaultTimeoutMs: 600000
```

The bridge reads its config once at startup, so restart the agent after changing it. Approvers see the agent as "DeepSeek Harness".

**The matcher decides whether the hook runs at all.** The bridge matches it against dsh's own tool name, passed unchanged (checked in the bridge source, `hooks-claude-code/src/index.ts`). A tool the matcher does not name never reaches the hook and is not governed. The matcher also lists Claude Code's names (`Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `WebFetch`) in case a bridge version renames tools; it does not use a catch-all, because a tool the hook does not know would only get "no opinion".

| dsh tool                                                | Guardian tool                                            | What Guardian sees                                       |
| ------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| `bash`, `pwsh`, `terminal_send` (text typed into a PTY) | `shell`, `shell_deploy`, `shell_destructive`, `git_push` | The command or typed text.                               |
| `write`, `edit`, `str_replace_editor` (all but `view`)  | `file_write`                                             | The path, size and a SHA-256 digest; never the contents. |
| `apply_patch` (on by default in `dsh-base`)             | `file_write`                                             | Target paths and operations, size and digest.            |
| `web_fetch`                                             | `web_fetch`                                              | The URL.                                                 |
| `mcp__<server>__<tool>`                                 | `mcp.<server>.<tool>`                                    | The MCP arguments.                                       |

A deny is the Claude Code deny JSON, plus the reason on stderr and exit 2, both of which the bridge treats as a block. An allow does not pre-approve the call in dsh: dsh's own approval policy still applies after Guardian allows it. The hook never returns `"ask"`; it waits for the approval itself, so it works in Maritime's one-shot headless chats too.

### Not governed under DeepSeek Harness

- **Every dsh tool not in the table**, including ones with real effects: `run_code` itself (its tool sub-calls go through the same pre-execute pipeline, per dsh's docs; not yet confirmed live), `subagent`, `workflow`, `ralph`; `plugin_manager` and `load_workspace_dependencies` (they install packages); the experimental browser tools `stagehand_act` and `stagehand_navigate` (they can click, submit forms and navigate); `send_message`, `spawn_teammate`, `team_task_*`; `job_*` (including `job_kill`); `schedule_*`; `skill`, `lsp`, `propose_action`, `terminal_open`, `web_search`; and read-only tools. Disable the ones you do not want with your dsh profile.
- **A missing or unparseable hooks file governs nothing.** The bridge logs "could not load hook config … no hooks registered" and runs every call. Check with a deny after every config change.
- `terminal_send` is classified per message, so a command split across several sends (e.g. `terraform ap` then `ply`) is seen in pieces, and text sent to a program already running in the PTY (a REPL, `ssh`) is classified as if it were a shell command. Prefer the plain `bash` tool and turn the terminal tools off where that matters.
- **The bridge lets the call run if the hook fails to run or crashes.** Only a deny or exit 2 blocks. As with Codex, the hook catches its own crashes, exits 2 on deny, and denies at its own 540-second deadline; the `|| … exit 2` covers a hook that cannot start. A hook killed from outside still fails open.
- Not yet confirmed live: the tool names the bridge passes in Maritime's image (the source passes dsh's names unchanged; the matcher lists Claude Code's too), whether Maritime's dsh image already includes the bridge plugin, whether the hook's environment keeps `GUARDIAN_AGENT_CREDENTIAL`, and whether Maritime's headless runs allow a 5-minute wait. See `examples/deepseek-harness/`.

## Limits (read these)

- **Decision-gated.** The agent performs the effect after Guardian authorizes and redeems the call. The receipt proves Guardian's authorization of that exact call, not the command's own outcome.
- **Routing is local and evadable.** The classification patterns run on your machine and catch plain spellings only (see [Tools the hook proposes](#tools-the-hook-proposes)).
- **The agent can edit the hook's own config.** An Allow-tier file edit (`apply_patch`, dsh `write`/`edit`, Claude Code `Write`) can rewrite `.codex/hooks.json`, `/data/.dsh/guardian-hooks.json`, `cordis.patch.yml` or `.claude/settings.json` and remove the hook. On Maritime's one-shot dsh runs the harness restarts on every message, so the edit takes effect on the next one. Deliver the hook as a managed hook (Codex `requirements.toml` with `allow_managed_hooks_only`, Claude Code managed settings), or mount the config read-only (owned by another user) where that matters.
- **Starting the hook.** It answers only when run as `guardian-hook` (or `…/hook/dist/index.js`). Installed under another file name it exits 0 with no output, which every agent treats as "no objection". Use the documented commands.
- **Only calls through the hook are governed.** Commands you run yourself, or other credentials on the machine, are not.
- **Arguments are bounded.** Commands over 2,000 characters are truncated in what the approver sees; MCP inputs over that size are sent as a digest.
- **Claude Code, Codex and DeepSeek Harness.** A Cursor adapter will ship once its hook contract is verified against its documentation.
- **Claude Code itself also runs a call when a hook times out or exits with an error other than 2.** The hook's own 540-second deadline and crash handling deny before that can happen; keep the hook `timeout` at 600.

Licensed Apache-2.0.
