# Hermes Agent, governed by Guardian

[Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research)
calls its `pre_tool_call` plugin hook once before every tool call: built-in
tools, plugin tools and MCP tools. `odingard-guardian` ships that hook as the
Hermes plugin `guardian`. It asks Guardian before the tool runs:

- everyday commands and edits (`ls`, `npm test`, `write_file`) run;
- deploys, destructive commands, pushes, `execute_code`, the browser, cron
  changes, sub-agents, MCP tools and changes to Hermes' own settings wait until
  a person approves that exact call;
- anything Guardian denies, or that nobody approves in time, does not run;
- every allowed call leaves a receipt you can verify offline.

Status: tested with a fake Guardian only (`packages/python/tests/test_hermes.py`).
**Not yet proven live** on Hermes, locally or hosted.

## Try it without Hermes (SIMULATED)

```bash
pip install odingard-guardian
python hermes_hook_demo.py
```

This calls the exact callback Hermes registers, with the payload Hermes gives
it, against a local demo policy (`[SIMULATED guardian]`). Set
`GUARDIAN_AGENT_CREDENTIAL`, `GUARDIAN_CONNECTION_ID` and
`GUARDIAN_HOOK_ASK_CONNECTION_ID` to send the same calls to real Guardian
(`[LIVE guardian]`); Hermes is still simulated.

## Set up Guardian

`python -m odingard_guardian.hermes` prints the steps. In short:

1. Connections → Register a tool server → record-only, twice:
   - "Hermes — everyday": `shell`, `file_write`, `web_fetch`;
   - "Hermes — needs approval": `shell_deploy`, `shell_destructive`,
     `git_push`, `code_exec`, `browser`, `computer_use`, `scheduled_task`,
     `delegate`, `hermes_config`, `hermes_other`, and any MCP tools as
     `mcp.<server>.<tool>`.
2. Agents → your Hermes agent: Allow on the first, Ask me first on the second,
   and allow every tool above by name on both connection cards. Without that
   step every call is denied as `INVALID_REQUEST`.

## Run it in Hermes (LIVE)

1. Install into the Python environment Hermes runs from:
   `pip install odingard-guardian`.
2. Put the Guardian settings where Hermes reads its environment (the shell, or
   `~/.hermes/.env`):

   ```bash
   GUARDIAN_AGENT_CREDENTIAL=gac1.…
   GUARDIAN_CONNECTION_ID=pcn_…            # "Hermes — everyday"
   GUARDIAN_HOOK_ASK_CONNECTION_ID=pcn_…   # "Hermes — needs approval"
   ```

3. Merge [`config.yaml`](config.yaml) into Hermes' `config.yaml`
   (`plugins.enabled: [guardian]`, `plugins.hook_callback_timeout: 130`).
   Edit `plugins.enabled` by hand. `hermes plugins enable guardian` is
   unverified: in the only real attempt it answered that the plugin was "not
   installed or bundled".
4. `hermes chat -q "List the files here, then run terraform apply -auto-approve in ./infra"`.
   `ls` runs. `terraform apply` is held: approve it in the Guardian app while
   the hook waits, and the command runs once. If nobody approves in time, the
   call is blocked. A retry of the exact same call in the same Hermes process
   picks up the open request; a new `hermes chat -q` run files a new request.

## On a hosted Hermes agent

Some hosts keep Hermes' home in `/opt/data` (`HERMES_HOME=/opt/data`) and run
one `hermes chat -q` per message. On such a host:

- edit `/opt/data/config.yaml` as above;
- add the three `GUARDIAN_*` variables as agent secrets (not in
  `/opt/data/.env`, see "What is not governed");
- `odingard-guardian` must be installed in the image's Hermes Python.

The approval has to arrive while that one message's hook is waiting. An open
request is never carried to the next message: the hook keeps open requests in
memory only, because any file Hermes can read, its tools can rewrite (and a
rewritten entry could spend one approval on a different call).

Some hosts give each reply a window of about 30 s. If the host ends a message
sooner than `hook_callback_timeout`, the hook is cut
off and the call is blocked (fail closed), so 130 s may buy nothing there; with
30 s the hook waits about 12 s for a person.

Not yet checked on a hosted agent: whether the image lets you `pip install`
into Hermes' Python and keep `/opt/data/config.yaml` edits, how long the host
lets one `hermes chat -q` run, and whether `/opt/data` is also the workspace (then
every command that names `/opt/data` is routed as `hermes_config` and needs
approval).

## Settings

| Variable                              | Default                  | Meaning                                                                                       |
| ------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| `GUARDIAN_AGENT_CREDENTIAL`           | required                 | The agent credential. Never logged. Moved out of `os.environ` on first use (see below).       |
| `GUARDIAN_CONNECTION_ID`              | required                 | Connection for the everyday tools.                                                            |
| `GUARDIAN_HOOK_ASK_CONNECTION_ID`     | `GUARDIAN_CONNECTION_ID` | Connection for the tools that need approval.                                                  |
| `GUARDIAN_BASE_URL`                   | hosted Guardian          | Must be `https://`.                                                                           |
| `GUARDIAN_HERMES_APPROVAL_TIMEOUT_MS` | `120000`                 | How long one call waits for a person. Also capped by `hook_callback_timeout` minus 17 s.      |
| `GUARDIAN_HERMES_MCP`                 | `hook`                   | `proxy` leaves `mcp__*` tools to `guardian-mcp proxy` (see `config.yaml`). Use one, not both. |
| `GUARDIAN_HERMES_AGENT_NAME`          | `Hermes`                 | Shown to the approver.                                                                        |

## What is not governed

- **Read-only tools**: `read_file`, `search_files`, `web_search`, `x_search`,
  `vision_analyze`, `video_analyze`, `skills_list`, `skill_view`, `todo_list`,
  `session_search`, `clarify`, `read_terminal`, `kanban_show`, `kanban_list`,
  `kanban_attachments`, and the read actions of `process_manage`
  (list/poll/log/wait) and `cronjob_manage` (list). Every other tool,
  including ones Hermes adds later, is governed (as `hermes_other` when the
  table does not know it).
- **Anything that does not go through Hermes' tool dispatch**: slash commands,
  gateway event hooks (`~/.hermes/hooks/`), other plugins' own code, shell
  hooks, cron jobs that run a script directly, and what a command does after
  Guardian allowed it (an allowed `python build.py` can do anything that script
  does).
- **Hermes safe mode**: `HERMES_SAFE_MODE=1` skips loading plugins, and a
  Hermes safe-worker run skips plugin hooks, so nothing is routed through
  Guardian. Do not use either for a governed agent.
- **A failure in Hermes' own hook dispatcher** (outside the plugin): Hermes'
  tool executor treats that as "no block", so it fails open. A crash, timeout
  or error in the Guardian hook itself is blocked, by the hook and by Hermes.
- If `plugins.enabled` does not list `guardian`, or `plugins.disabled` does,
  Hermes never loads the hook and nothing is governed. Check with
  `hermes plugins` that it shows as enabled.
- `plugins.isolation: host` (plugins in a separate process) has not been tested.
- **Shell commands are classified by pattern**, as in guardian-hook. Anything
  the patterns miss (`bash -c 'r''m -rf /'`, `python -c "import shutil; ..."`,
  `git -C . push`) is proposed as `shell`, which the setup above allows by
  policy. If that is too loose, put `shell` on the approval connection too.
- **Hermes' own settings are protected by pattern only.** `write_file`/`patch`
  under `$HERMES_HOME` (`config.yaml`, `.env`, `plugins/`) or into this
  package, `read_file` of `$HERMES_HOME/.env`, and commands that name
  `$HERMES_HOME`, `.hermes`, `HERMES_HOME`, `GUARDIAN_*`, `odingard`,
  `hermes plugins|config|setup|tools` or `/proc/*/environ` are routed as
  `hermes_config` (needs approval). A command that builds the path at run time
  (`cd /opt && cd data && sed -i … config.yaml`, a script) is not caught, and
  from the next run on Hermes would load without Guardian. The real protection
  is outside this plugin: make `config.yaml`, `.env` and the installed package
  read-only to the OS user Hermes runs as, or run tools in a sandboxed terminal
  backend that cannot see `$HERMES_HOME`.
- **The credential is readable by anything that can read where it is stored.**
  Hermes passes its environment to tool subprocesses and strips only names it
  knows; `GUARDIAN_*` is not one of them. The hook therefore moves
  `GUARDIAN_AGENT_CREDENTIAL` out of `os.environ` when it loads and before
  every call, so a later `echo $GUARDIAN_AGENT_CREDENTIAL` prints nothing. It
  cannot hide the credential in `$HERMES_HOME/.env`: `read_file` of it needs
  approval, but a `cat` whose path is built at run time is a plain `shell`
  call. Nor can it hide it in `/proc/<hermes pid>/environ` when it came from
  the starting shell. With the
  credential an agent can file its own Guardian requests; it still cannot
  approve them. Prefer platform secrets over `.env`, and a separate OS user or
  sandboxed terminal backend for tools.
- **Other plugins' `modify` directives** run after Guardian decided: Hermes
  merges a co-installed plugin's rewritten arguments in afterwards, so
  Guardian approves the original arguments and the rewritten ones run. Do not
  combine Guardian with a plugin that returns `{"action": "modify"}`.
- **`GUARDIAN_HERMES_MCP=proxy`** leaves every tool named `mcp__*` or `mcp_*`
  ungoverned by the hook, including MCP servers that are _not_ behind
  `guardian-mcp proxy` (an HTTP server, or one you forgot) and any non-MCP
  tool with that prefix. Wrap every server, or keep the default `hook`. The
  proxy recipe in `config.yaml` needs the credential in Hermes' environment
  under `GUARDIAN_MCP_AGENT_CREDENTIAL` for `${…}` expansion, so in proxy mode
  tools can read that copy.
- **`hook_callback_timeout` under 17 s** blocks every governed call: the hook
  only starts a Guardian call when it and the redeem after it (up to 8 s each)
  finish inside Hermes' timeout, so Guardian never records a receipt for a
  call Hermes already gave up on. httpx's timeout is per phase, so a server
  that trickles bytes can still stretch one call past 8 s.
