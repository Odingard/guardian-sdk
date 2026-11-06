# DeepSeek Harness (dsh), governed by Guardian

DeepSeek Harness runs Claude Code `PreToolUse` hooks through its bridge
plugin `@deepseek-ai/dsh-hooks-claude-code`. Guardian's hook runs there as
`guardian-hook dsh` and knows dsh's own tool names (`bash`, `pwsh`,
`terminal_send`, `write`, `edit`, `apply_patch`, `str_replace_editor`,
`web_fetch`, `mcp__<server>__<tool>`). The bridge runs the hook only for
tools the matcher in `guardian-hooks.json` names, so keep it as shipped:

- everyday commands and file edits run under **Allow**;
- deploys, destructive commands and pushes wait until a person approves;
- anything denied, or not approved within 5 minutes, does not run;
- every allowed call leaves a receipt you can verify offline.

## SIMULATED: see what dsh would receive (no account needed)

```bash
cd examples && npm install
node agent-hooks.mjs dsh
```

## LIVE: Maritime's dsh template, real Guardian

1. In the Guardian console, create the agent and its two connections and
   allow each tool by name (`guardian-hook dsh setup` lists them).
2. Install the hook on the agent: in the Terminal tab,
   `npm i -g @odingard/guardian-hook` (or bake it into a custom image). Do
   not use `npx -y` at hook time: a failed download is a failed hook.
3. Copy [`guardian-hooks.json`](guardian-hooks.json) and
   [`cordis.patch.yml`](cordis.patch.yml) to `/data/.dsh/` (dsh's
   `DSH_HOME` on Maritime). If a `cordis.patch.yml` is already there, add the
   `insert` row to it.
4. Set `GUARDIAN_AGENT_CREDENTIAL` (secret), `GUARDIAN_CONNECTION_ID` and
   `GUARDIAN_HOOK_ASK_CONNECTION_ID` in the agent's environment, then restart
   the agent (the bridge reads its config once at startup).
5. Chat:

   ```bash
   maritime chat my-agent "List the files in the workspace, then run terraform apply -auto-approve in ./infra"
   ```

   `ls` runs; `terraform apply` waits for your approval. The hook waits for
   the approval itself, so this works in Maritime's one-shot headless chats.

Not yet confirmed live: that the bridge plugin is in Maritime's
`dsh-agent:0.1.0-rc.7` image (if not, install it with `dsh plugin` or the
Console), the tool names the bridge passes there (its source passes dsh's
names unchanged; the matcher also lists Claude Code's), that the hook's environment keeps
`GUARDIAN_AGENT_CREDENTIAL`, and that a headless run may wait 5 minutes.

## What is not governed

- Every dsh tool other than those above, including `run_code` itself (dsh
  documents that its tool sub-calls pass the same pre-execute pipeline; not
  confirmed live), `subagent`, `workflow`, `ralph`, `plugin_manager` and
  `load_workspace_dependencies` (package installs), `stagehand_act` and
  `stagehand_navigate` (browser actions), `send_message`, `spawn_teammate`,
  `team_task_*`, `job_*`, `schedule_*`, `skill`, `lsp`, `propose_action`,
  `terminal_open`, `web_search`, read-only tools. Turn off the ones you do not
  want in your dsh profile.
- A missing or unparseable `guardian-hooks.json`: the bridge registers no
  hooks and nothing is governed. Check with a deny after every change.
- An Allow-tier `write`/`edit`/`apply_patch` can rewrite
  `/data/.dsh/guardian-hooks.json`; the next message's run picks it up. Mount
  it read-only where that matters.
- `terminal_send` is checked per message: a command split across sends is
  seen in pieces. Prefer `bash`, and disable terminal tools where it matters.
- A Guardian allow does not pre-approve the call: dsh's own approval policy
  still applies after it.
- **If the hook fails to run or crashes, the bridge runs the call.** The hook
  turns every failure it can see into a deny (exit 2) and denies at its own
  540-second deadline; the `|| … exit 2` blocks when the hook cannot start.
  A hook killed from outside still fails open.
