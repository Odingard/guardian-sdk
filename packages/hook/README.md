<img src="https://raw.githubusercontent.com/Odingard/guardian-sdk/main/assets/guardian-mark.svg" alt="Guardian" width="48" height="48" />

# @odingard/guardian-hook

**Guardian is the trust layer for agent commerce.** Human Authority Infrastructure for Autonomous AI: the agent proposes; the human decides.

**Guardian for coding agents.** A [Claude Code](https://code.claude.com/docs/en/hooks) `PreToolUse` hook that sends every consequential tool call (shell commands, file writes, web fetches and searches, MCP tools, reads of sensitive files) to Guardian before it runs. The same hook runs under [OpenAI Codex CLI](#openai-codex-cli) (`guardian-hook codex`) and [DeepSeek Harness](#deepseek-harness-dsh) (`guardian-hook dsh`).

- `npm test` runs under **Allow**.
- `terraform apply` waits until **you approve it**.
- `rm -rf` is **denied** if that is the mode you set.

There is no model in the decision: Guardian decides ALLOW / ASK / DENY deterministically from the permissions you set, and every allowed call carries a signed decision record you can verify offline.

## How it works

| Guardian says | What happens                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ALLOW**     | The hook redeems the single-use capability (revocation and expiry are checked now, and the decision is recorded), then tells the agent to run the call.              |
| **ASK**       | The agent waits. You get the request in the Guardian console. On approval the hook claims and redeems the capability, then the call runs. It is never auto-approved. |
| **DENY**      | The agent is told no, with the reason. Nothing runs.                                                                                                                 |

**Fail closed.** If Guardian can't be reached, the configuration is wrong, approval times out or redemption fails, the call is denied. Each request stays open for 5 minutes (Guardian's limit), and the hook waits that long for an approval, under Claude Code's 600-second hook timeout, because a hook that times out does not block. An ASK not approved within 5 minutes expires; the call is denied and the agent can ask again. If the hook itself fails to start or crashes (a missing or unbuilt `@odingard/guardian-sdk`, a broken install, an uncaught error), the call is blocked too: the hook writes the reason to stderr and exits 2, which blocks in Claude Code, Codex and DeepSeek Harness. A denial tells the agent Guardian's request id (`Request req_…`), so the developer can find the request in the console. If Guardian's answer to the redemption is lost (no answer, a 5xx, an unreadable answer), the hook looks the request up in Guardian: when Guardian recorded the redemption as verified, the call runs; otherwise it is denied with `EXECUTION_OUTCOME_UNKNOWN` (or `EXECUTION_NOT_SENT` when Guardian aborted it), nothing runs, and the agent is told not to retry and to have the request checked.

## Tools the hook proposes

Shell commands are routed by consequence. That routing is what lets you put deploys behind your approval while ordinary commands flow freely.

**How a command is routed.** The hook parses the command line and routes it by the riskiest command inside it. It removes quotes and escapes, splits on `;`, `&&`, `||`, `|`, newlines and subshells, and looks inside `$( )`, backticks, `<( )`, `sh -c` / `bash -c` strings, `eval`, `su -c`, `env -S` and `find -exec`. It looks past wrappers (`sudo`, `doas`, `env`, `xargs`, `nice`, `nohup`, `time`, `timeout`, `stdbuf`, `exec`, `command`, `watch`, `npx`), git global options (`-C`, `-c`, `--git-dir`, `--work-tree`) and git aliases set with `-c alias.*`. So `find . | xargs rm -rf`, `git -C repo push -f`, `"git" push --force` and `r\m -rf ~` are all `shell_destructive`. When the hook cannot follow a command, it sends it to the Ask tier: an unterminated quote, a command name known only at run time (`$CMD -rf x`), `eval` or `sh -c` of run-time text (`sh -c "$(echo … | base64 -d)"`, `eval "$(tool init)"`), or a `case` statement.

**It is still not a security boundary.** The hook cannot see inside scripts (`bash deploy.sh`, `make clean`), code run by other interpreters (`python -c`, `node -e`, PowerShell), shell functions and aliases, or git aliases and hooks already in the git config. Under prompt injection, treat the Ask tier as advisory. Where that matters, set the everyday connection to **Ask me first** as well, or deny `shell` outright.

| Guardian tool         | Suggested mode | Covers                                                                                                                                             |
| --------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell`               | Allow          | Ordinary commands (build, test, inspect)                                                                                                           |
| `shell_deploy`        | Ask me first   | terraform/tofu apply and destroy, pulumi up, kubectl apply and delete, helm install and upgrade, cloud deploy CLIs, package publish, `gh pr merge` |
| `shell_destructive`   | Ask me first   | See the list below, [sensitive files](#sensitive-files) (`.env`, keys, cloud credentials) and [the agent's environment](#the-agents-environment)   |
| `git_push`            | Ask me first   | Pushing commits                                                                                                                                    |
| `shell_session`       | Ask me first   | Starting an interactive shell, interpreter, database client or remote session (`bash`, `python3`, `ssh host`, `docker exec -it`, `psql app`)       |
| `file_write`          | Allow          | Write and edit (the approver sees the path, size and a SHA-256 of the content; the content itself is not sent)                                     |
| `web_fetch`           | Allow          | Fetching a URL, and web searches (`WebSearch`; the approver sees the query)                                                                        |
| `mcp.<server>.<tool>` | your choice    | Any MCP tool, e.g. `mcp.github.create_pull_request`                                                                                                |

`shell_destructive` covers:

- `rm -r` / `rm -rf` (also with no operands, and through `xargs`), and any `rm` run by `find -exec`, `find -ok` or `xargs`; `find -delete`; `shred`, `mkfs`, `dd if=`, `wipefs`.
- `git reset --hard` or `--merge`, `git clean -f`, `git branch -D` (or `-d -f`), `git checkout -f` or `checkout -- <path>`, `git switch --discard-changes`, `git restore --source`, `git stash drop` / `clear`, `git update-ref -d`, `git reflog expire`, `git filter-branch`.
- Force pushes and remote ref deletes: `git push --force`, `-f`, `--force-with-lease`, `--force-if-includes`, `+refspec`, `--mirror`, `--prune`, `--delete`, `-d`, `origin :branch`, with or without git global options (`git -C dir push -f`).
- `DROP` / `TRUNCATE` / unqualified `DELETE FROM`, `chmod -R` to a world-writable mode, and downloaded code run by a shell or interpreter (`curl … | sh`, `bash <(curl …)`, `sh -c "$(curl …)"`).
- Changes to the agent's own MCP servers, hooks or permissions: `claude mcp add`, `add-json`, `add-from-claude-desktop`, `remove` and the other non-read `mcp`, `plugin` and `config` subcommands of `claude`, `codex` and `gemini`; a nested `claude` or `codex` given `--mcp-config`, `--settings`, `--dangerously-skip-permissions` or a wider `--permission-mode`; and writes to `.mcp.json`, `mcp.json`, `~/.claude.json`, `settings.local.json`, `.claude/settings*.json`, `.claude/hooks`, `agents`, `commands`, `skills` or `plugins`, `.codex/`, `.cursor/`, `.gemini/`, `.dsh/` or `guardian-hooks.json`. That includes writes by redirection (`> .mcp.json`), by commands such as `cp`, `mv`, `tee`, `sed -i` and `ln`, and by the file tools (`Write`, `Edit`, `MultiEdit`, `write`, `edit`, `str_replace_editor`, `apply_patch`), which then carry `touches: "agent-config"`. Reading those files stays `shell`.
- Commands the hook cannot parse (see above).

## Sensitive files

Read, NotebookRead, Grep, Glob and LS go through the hook too. A read of an ordinary file gets no opinion: nothing is sent to Guardian and Claude Code's own permissions apply. A read of a sensitive file goes to `shell_destructive` (Ask tier) with `touches: "sensitive-file"`, the path and the pattern it matched, so the needs-approval connection decides and Guardian records the request. The same holds for a shell command that names a sensitive file (`cat .env`, `cp ~/.ssh/id_rsa /tmp`, `base64 .env`, `curl -F f=@.env …`, `python3 -c "open('.env')"`), under Claude Code, Codex and DeepSeek Harness.

The patterns are checked on your machine, deterministically. The defaults:

`.env*` (except `.env.example`, `.env.sample` and `.env.template`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `.ssh/**`, `.aws/credentials`, `.aws/sso/cache/**`, `.config/gcloud/**`, `.azure/**`, `.kube/config`, `.docker/config.json`, `.config/gh/hosts.yml`, `*secret*`, `secrets/**`, `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`, `.git-credentials`, `proc/*/environ`.

- A pattern without `/` matches the last part of the path (the file name); write `name/**` to cover a folder and everything in it. A pattern with `/` matches the end of the path. `*` and `?` match within a name, `[abc]` one character, `**` any number of folders. Case is ignored.
- A path is checked as written, as an absolute path (`./`, `..` and `~` resolved against the working directory) and, when it exists, with symlinks followed. A path that exists but cannot be resolved counts as sensitive.
- In a shell command the hook checks every word after quotes and escapes are removed (a bare name such as `.env` counts when that file exists in the working directory, or when the command changes folder or user, runs elsewhere, searches or reads git history: `cd`, `git -C`, `su -`, `sudo -i`, `ssh`, `docker`, `find`, `grep -r`, `rg`, `tar`, `xargs`, `git show HEAD~1:.env`, `git log -p`; in code given to Python, Node and similar interpreters (`python3 -c`, `node -e`, a here-document), a dot-file name always counts, and every bare name counts when the code changes folder), brace and glob expansion as the shell would do it (`.en?`, `.{e,x}nv`, `*` with `dotglob`), code given to `sh -c`, interpreters and here-documents, and redirections (`< .env`).
- For Grep and Glob, the path and the file filter (`glob`, `pattern`) are checked as written. A Grep filter (`glob: ".en?"`, `glob: "credentials"`, each piece of `"*.md .env"` or `"*.md,.env"`) is also matched against the files under the searched folder, the way ripgrep matches it, and a Grep with no filter checks every file under the folder, hidden files included. Folders named `.git`, `node_modules`, `.venv` and `__pycache__` are not walked, and a folder too large to check goes to the Ask tier. So a Grep over a folder that holds a sensitive file (a repository with a `.env`) goes to the Ask tier; exempt the file with `!` if you want those searches to run.

You set:

- `GUARDIAN_HOOK_SENSITIVE_PATHS`: more patterns, comma separated, checked after the defaults. `!pattern` exempts what it matches, and the last matching pattern wins: `*.tfstate,!.env.test` adds Terraform state and exempts `.env.test`. Start the list with `!*` to drop the defaults.
- `GUARDIAN_HOOK_SENSITIVE_MODE`: `ask` (default) sends sensitive reads to Guardian as above; `deny` makes the hook refuse them itself, without sending anything to Guardian.

Fail closed: invalid settings, a read without a path, or an error while checking a call deny the call. An exemption covers the name it matches, not the file a symlink points to.

What this does not see: a shell search over a folder (`grep -r TOKEN .`, `rg TOKEN`) can read a sensitive file inside it; for shell commands the hook checks the names in the command, not every file the search opens. A path built at run time (`cat "$(…)"`, `cat $F`) and files read by scripts are not seen either. WebSearch is `web_fetch`: the query leaves your machine, so it is governed like a fetched URL.

**Speed.** An ordinary read is decided locally (checking the patterns takes well under a millisecond; walking a folder for a Grep took about 45 ms for this repository), but every read now starts the hook process. On our test machine that took about 0.15 s with the package installed globally and about 0.75 s through `npx -y` with a warm cache. To keep reads fast, install it (`npm i -g @odingard/guardian-hook`) and use `"command": "guardian-hook"`.

## The agent's environment

The agent's environment holds `GUARDIAN_AGENT_CREDENTIAL` and often other secrets. A shell command that can print it goes to `shell_destructive` (Ask tier) with `touches: "sensitive-env"` and what it reads, under Claude Code, Codex and DeepSeek Harness. `GUARDIAN_HOOK_SENSITIVE_MODE=deny` makes the hook refuse these commands itself.

- Commands that print the environment: `env` and `printenv` with nothing to run, `export` / `export -p`, `set` with no arguments, `declare` / `declare -x` / `declare -p` and `typeset`, `ps e`, `/proc/<pid>/environ` (also after `cd /proc/self`), and the PowerShell `env:` drive. Also through wrappers, `sh -c`, `eval`, `$( )` and `find -exec`.
- Any expansion of a `GUARDIAN_*` variable (`$GUARDIAN_AGENT_CREDENTIAL`, `${GUARDIAN_…}`, `$env:GUARDIAN_…`), in any command, and an indirect expansion (`${!name}`).
- A secret variable (`*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`, `AWS_*`) expanded in `echo`, `printf`, `cat`, a here-document or here-string, `sh -c`, `eval` or interpreter code, named to `printenv`, or run as the command itself.
- Interpreter code that reads the whole environment (`python -c 'import os;print(os.environ)'`, `node -e 'console.log(process.env)'`, Ruby `ENV`, Perl `%ENV`, PHP `getenv()`, awk `ENVIRON`, `jq -n env`) or a secret variable by name (`os.environ["GITHUB_TOKEN"]`, `process.env.GITHUB_TOKEN`).

Setting a variable to run a command (`env FOO=bar make`), `printenv PATH` and a secret passed to another command (`curl -H "Authorization: Bearer $GITHUB_TOKEN" …`) stay where they were. Not seen: a variable name built at run time, and scripts that print the environment.

This check catches common ways an agent can print secrets from its environment. It is not a complete barrier: don't keep long-lived secrets in an agent's environment.

## Setup

Guardian sets modes **per connection**, not per tool. So the hook uses two record-only tool servers, one per risk tier. That lets `ls` run straight away while `terraform apply` waits for your approval.

1. In the Guardian console, go to **Connections → Register a tool server → record-only** and create two:
   - **"Coding agent — everyday"** with `shell`, `file_write` and `web_fetch`.
   - **"Coding agent — needs approval"** with `shell_deploy`, `shell_destructive`, `git_push`, `shell_session`, and any MCP tools you use. List `shell_session` and each MCP tool (`mcp.<server>.<tool>`) on this connection, when you register it or later with **Add tools** on its card. A name that is not on the connection, or not allowed by name, is refused (`INVALID_REQUEST`), which fails closed. `npx @odingard/guardian-mcp tools -- <server>` lists them.
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
        "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|Read|NotebookRead|Grep|Glob|LS|mcp__.*",
        "hooks": [
          {
            "type": "command",
            "command": "npx -y @odingard/guardian-hook@0.4.4",
            "timeout": 600,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

Setups from guardian-hook 0.4.3 and earlier use `"matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__.*"`, which does not send reads or web searches to the hook; replace it with the matcher above.

`"onFailure": "block"` (Claude Code v2.1.295 or later) makes Claude Code block the call when the hook cannot start at all (no Node, or npx cannot fetch the package) or times out; without it Claude Code runs the call in those cases. A hook that starts but fails to load or crashes blocks the call either way.

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

A runnable example is in `examples/agents/claude-agent-sdk.mjs`. For a hosted agent where Claude Code runs unattended in its own VM, see `examples/agents/hosted-claude-code/`.

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

Codex reads files through `Bash`, so a command that names a [sensitive file](#sensitive-files) goes to `shell_destructive`.

How a decision reaches Codex: an allow prints nothing and exits 0, which Codex treats as success (Codex documents `permissionDecision: "allow"` only together with `updatedInput`). A deny prints the deny JSON, writes the reason to stderr and exits 2; Codex blocks on either. The hook never returns `"ask"`, which Codex does not support and treats as a failed hook that lets the call run: on ASK the hook waits for the approval itself (up to 5 minutes) and then answers allow or deny.

### Hosted Codex agents (`codex exec`)

Some hosts run each chat message as `codex exec --dangerously-bypass-approvals-and-sandbox`, with config under `/data/.codex`. To govern it:

1. Install `@odingard/guardian-hook` in the image (a custom image) and write the `hooks.json` above to `/data/.codex/hooks.json` at boot.
2. Add `--dangerously-bypass-hook-trust` to the host's `codex exec` command, or deliver the hook as a managed `requirements.toml` hook. **This is the one setting a headless host needs**; without it the hook is skipped.
3. Set `GUARDIAN_AGENT_CREDENTIAL`, `GUARDIAN_CONNECTION_ID` and `GUARDIAN_HOOK_ASK_CONNECTION_ID` as agent environment variables (the credential as a secret).

`--dangerously-bypass-approvals-and-sandbox` turns off Codex's own approvals and sandbox; Codex documents hooks separately from approvals; check that hooks still fire before you use that flag. See `examples/agents/codex/`.

### Not governed under Codex

- **`write_stdin`: input typed into an open unified-exec session.** Codex runs `PreToolUse` once, for the `exec_command` that starts the process, and never for `write_stdin` (Codex's hooks docs: "`write_stdin` is transport for an existing unified-exec session. It doesn't run `PreToolUse` again"; source: `write_stdin.rs` returns no pre-hook payload). So a model can start `bash` and then type `terraform apply` or `rm -rf` into it, and Guardian never sees those commands. The hook routes the start of an interactive shell, interpreter, database client, `ssh` or `docker exec -it` session to `shell_session` (Ask tier), so a person approves opening it, but once approved, what is typed is not governed, and a process that reads stdin in a way the patterns miss (for example a custom read-eval loop) is not caught. **To close the gap, turn unified exec off** in a managed `requirements.toml`:

  ```toml
  [features]
  unified_exec = false
  ```

  With it off, Codex registers `exec_command` as one-shot (runs to completion, no `tty`, no session) and does not offer `write_stdin` (Codex `spec_plan.rs`, `add_shell_tools`; the source notes that only managed requirements can keep it off). Check that `write_stdin` is no longer offered before you rely on it. `examples/agents/codex/requirements.toml` includes it.

- **`apply_patch` deletes and moves are `file_write` (Allow tier).** A `*** Delete File:` patch runs without approval under the suggested modes; the approver sees `delete <path>` in the operations. That is a policy choice: set the everyday connection to Ask if deletes must wait for a person.
- **A missing, untrusted or unparseable `hooks.json` governs nothing.** Codex skips it and runs every call. Check with a deny (for example `rm -rf ./tmp-guardian-check` should be blocked or wait for approval) after every config change.
- Hosted tools such as `WebSearch` (they do not use Codex's hook path), and any "specialized tool path" Codex runs without hooks; Codex itself calls hooks "a useful guardrail, not a complete enforcement boundary".
- Other local tools (`update_plan`, `spawn_agent`, …) are left to Codex. Check whether a subagent's own tool calls reach the hook before you rely on it.
- **Codex lets the call run if the hook process fails** (crash, timeout, malformed output). The hook makes every failure it can see a deny: it catches crashes and load failures, exits 2 on deny, and has its own 540-second deadline under Codex's 600-second timeout. The `|| … exit 2` in the command turns a hook that cannot start into a block. A hook killed from outside, or a `timeout` set below the hook's deadline, still fails open; keep `timeout` at 600.

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
        "matcher": "^(bash|pwsh|terminal_send|write|edit|apply_patch|str_replace_editor|web_fetch|web_search|read|read_image|grep|glob|Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|Read|NotebookRead|Grep|Glob|LS)$|^mcp__.*",
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

Mount the bridge in `$DSH_HOME/cordis.patch.yml` (for example `/data/.dsh/cordis.patch.yml`):

```yaml
- insert:
    - id: guardian-hooks
      name: "@deepseek-ai/dsh-hooks-claude-code"
      config:
        configPath: /data/.dsh/guardian-hooks.json
        defaultTimeoutMs: 600000
```

The bridge reads its config once at startup, so restart the agent after changing it. Approvers see the agent as "DeepSeek Harness".

**The matcher decides whether the hook runs at all.** The bridge matches it against dsh's own tool name, passed unchanged (checked in the bridge source, `hooks-claude-code/src/index.ts`). A tool the matcher does not name never reaches the hook and is not governed. The matcher also lists Claude Code's names (`Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch` and the read tools) in case a bridge version renames tools; it does not use a catch-all, because a tool the hook does not know would get "no opinion" anyway.

| dsh tool                                                              | Guardian tool                                                                      | What Guardian sees                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `bash`, `pwsh`, `terminal_send` (text typed into a PTY)               | `shell`, `shell_deploy`, `shell_destructive`, `git_push`                           | The command or typed text.                               |
| `write`, `edit`, `str_replace_editor` (all but `view`)                | `file_write`                                                                       | The path, size and a SHA-256 digest; never the contents. |
| `apply_patch` (on by default in `dsh-base`)                           | `file_write`                                                                       | Target paths and operations, size and digest.            |
| `web_fetch`                                                           | `web_fetch`                                                                        | The URL.                                                 |
| `web_search`                                                          | `web_fetch`                                                                        | The queries.                                             |
| `read`, `read_image`, `grep`, `glob`, and `str_replace_editor` `view` | `shell_destructive` for a [sensitive file](#sensitive-files); no opinion otherwise | The path, the filter and the pattern matched.            |
| `mcp__<server>__<tool>`                                               | `mcp.<server>.<tool>`                                                              | The MCP arguments.                                       |

A deny is the Claude Code deny JSON, plus the reason on stderr and exit 2, both of which the bridge treats as a block. An allow does not pre-approve the call in dsh: dsh's own approval policy still applies after Guardian allows it. The hook never returns `"ask"`; it waits for the approval itself, so it works in one-shot headless chats too.

### Not governed under DeepSeek Harness

- **Every dsh tool not in the table**, including ones with real effects: `run_code` itself (its tool sub-calls go through the same pre-execute pipeline, per dsh's docs; check with a denied sub-call before you rely on it), `subagent`, `workflow`, `ralph`; `plugin_manager` and `load_workspace_dependencies` (they install packages); the experimental browser tools `stagehand_act` and `stagehand_navigate` (they can click, submit forms and navigate); `send_message`, `spawn_teammate`, `team_task_*`; `job_*` (including `job_kill`); `schedule_*`; `skill`, `lsp`, `propose_action` and `terminal_open`. Disable the ones you do not want with your dsh profile.
- **A missing or unparseable hooks file governs nothing.** The bridge logs "could not load hook config … no hooks registered" and runs every call. Check with a deny after every config change.
- For `terminal_send` the hook cannot know the terminal's folder, so every bare name that matches a pattern counts. `terminal_send` is classified per message, so a command split across several sends (e.g. `terraform ap` then `ply`) is seen in pieces, and text sent to a program already running in the PTY (a REPL, `ssh`) is classified as if it were a shell command. Prefer the plain `bash` tool and turn the terminal tools off where that matters.
- **The bridge lets the call run if the hook fails to run or crashes.** Only a deny or exit 2 blocks. As with Codex, the hook catches its own crashes and load failures, exits 2 on deny, and denies at its own 540-second deadline; the `|| … exit 2` covers a hook that cannot start. A hook killed from outside still fails open.
- Check on your host: the tool names the bridge passes in your dsh image (the source passes dsh's names unchanged; the matcher lists Claude Code's too), whether your dsh image includes the bridge plugin, whether the hook's environment keeps `GUARDIAN_AGENT_CREDENTIAL`, and whether headless runs allow a 5-minute wait. See `examples/agents/deepseek-harness/`.

## Edit-type tools: the target file is pinned (0.4)

Approval binds the exact arguments. A file path is an argument; for most tools the file's contents are not. For Edit, MultiEdit, NotebookEdit and DeepSeek Harness `edit`, whose result depends on the file being edited, the hook reads the target file when the call is proposed and puts its SHA-256 in the approved arguments (`guardianContentPins`, or `absent: true` for a file that does not exist yet). Just before it releases the approved call it checks the file again. If the file changed, appeared or disappeared, the call is denied with `CONTENT_CHANGED_SINCE_APPROVAL`, nothing runs and the capability is not redeemed. Guardian's servers never see the file.

- What this checks is that the file matched when the approved call was released. The agent's own Edit tool then reads the file again after the hook returns, so a short window remains.
- The target path must be absolute; the hook does not resolve it against the working directory. An Edit-type call with a relative path is denied (`CONTENT_PIN_INVALID_ARGUMENT`). Claude Code always sends absolute paths.
- Write and DeepSeek `write` are not pinned: they replace the whole file, so its current contents do not change what runs. Their arguments and tiers are unchanged.
- The mode is always `recheck`, and there is nothing to declare. Elsewhere in the SDK `bytes` is the default when no mode is named; the hook cannot hand the agent's own Edit tool bytes, so it does not use that default.
- Shell commands are not pinned. The command text is bound; files it names (`bash deploy.sh`, `curl -F file=@x`, globs, `$VAR`) are not.
- Pinning is supported on Linux and macOS. On Windows an Edit-type call is denied (`CONTENT_PIN_UNSUPPORTED_PLATFORM`).
- **Digest privacy:** the SHA-256 of the target is sent to Guardian, shown to the approver and kept in the signed decision record. For a small or low-entropy file, anyone who sees the digest can guess the contents offline by hashing candidates.

## Limits (read these)

- **Decision-gated.** The agent performs the effect after Guardian authorizes and redeems the call. The signed decision record proves Guardian's authorization of that exact call, not the command's own outcome.
- **Routing is local and evadable.** The parser and patterns run on your machine. They do not see inside scripts, other interpreters' code, shell functions or configured git aliases (see [Tools the hook proposes](#tools-the-hook-proposes)).
- **The agent can still edit the hook's own config in ways the hook does not recognise.** Writes to the known config files (`.codex/hooks.json`, `guardian-hooks.json`, `cordis.patch.yml`, `.claude/settings.json` and the others listed above) go to the Ask tier, but a script, an interpreter (`python script.py`) or a path built at run time can still rewrite them and remove the hook. On one-shot dsh runs the harness restarts on every message, so the edit takes effect on the next one. Deliver the hook as a managed hook (Codex `requirements.toml` with `allow_managed_hooks_only`, Claude Code managed settings), or mount the config read-only (owned by another user) where that matters.
- **Starting the hook.** Run it as `guardian-hook` (`dist/cli.js`), as the documented commands do. That entry has no dependencies of its own, so a hook that cannot load still blocks the call. Running `node …/hook/dist/index.js` directly still works and blocks on a crash, but if that file itself cannot load (for example a missing `@odingard/guardian-sdk`), Node exits 1 and the agent runs the call.
- **Only calls through the hook are governed.** Commands you run yourself, or other credentials on the machine, are not.
- **Arguments are bounded.** Commands over 2,000 characters are truncated in what the approver sees; MCP inputs over that size are sent as a digest.
- **Claude Code, Codex and DeepSeek Harness.** There is no Cursor hook adapter; use the MCP proxy for Cursor.
- **Claude Code itself also runs a call when a hook times out, cannot start or exits with an error other than 2,** unless the hook is registered with `"onFailure": "block"` (Claude Code v2.1.295 or later). The hook's own 540-second deadline and crash handling deny before that can happen; keep the hook `timeout` at 600 and set `onFailure`.

Licensed Apache-2.0.
