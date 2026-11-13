<img src="https://raw.githubusercontent.com/Odingard/guardian-sdk/main/assets/guardian-mark.svg" alt="Guardian" width="48" height="48" />

# @odingard/guardian-openclaw

Guardian for [OpenClaw](https://openclaw.ai) agents. A native OpenClaw plugin
sends every consequential tool call to Guardian for a deterministic
`ALLOW` / `ASK` / `DENY` decision before it runs:

- everyday commands (`ls`, `npm test`), file edits and web fetches run;
- deploys, destructive commands, pushes, outbound messages, browser actions,
  sub-agents, cron and gateway changes, and MCP tools (Composio's
  `composio__GMAIL_SEND_EMAIL` and the like) wait until a person approves that
  exact call in Guardian, on their phone or in the console;
- anything Guardian denies, or that nobody approves in time, does not run;
- every allowed call leaves a receipt you can verify offline.

**Status: proven live on hosted Guardian for shell commands.** Run on
OpenClaw 2026.7.1 with a protected install, through the Gateway agent's real
`before_tool_call` hook. On staging and production: an everyday command was
allowed and ran, and its receipt verified offline; a deploy command waited for
approval in the console and, once approved, ran once with the approved
parameters. On staging also: a denied approval, a tool set to off, and an
unreachable Guardian each blocked the call, and nothing ran. Outbound
messages, MCP tools and the other Ask-tier tools use the same hook and
decision path but have not yet been run live.

**Tamper-resistance is a deployment precondition, and the plugin enforces
it.** If the OpenClaw process user can change the plugin, the OpenClaw config,
the plugin directories, managed hooks or a start-up `.env`, every tool call is
blocked until the install is protected: see
[Required: protect the install](#required-protect-the-install). Some state
OpenClaw itself must write is not covered: see
[What is not governed](#what-is-not-governed).

The OpenClaw plugin does not pin the contents of files its tools read or patch. The path is bound; the file's bytes are not.

## How it works

The plugin registers one typed hook, `api.on("before_tool_call", handler,
{ priority: -10000, timeoutMs: 330000 })`, with no matcher, so it sees every
tool OpenClaw runs, including MCP tools and tools added by other plugins.

| Guardian says | The plugin returns                      | Result                                                                                                                 |
| ------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ALLOW`       | `{ params }` after redeeming            | The single-use capability is redeemed (receipt recorded), then the tool runs with exactly the parameters Guardian saw. |
| `ASK`         | waits, then `{ params }` or `{ block }` | The handler waits while a person decides in Guardian. Approved: redeemed, then runs. Declined or expired: blocked.     |
| `DENY`        | `{ block: true, blockReason }`          | Nothing runs. The agent is told why and not to work around it.                                                         |
| Anything else | `{ block: true, blockReason }`          | Missing config, unreachable Guardian, crash, timeout, cancelled call, failed redemption: nothing runs (fail closed).   |

**Guardian is the authority for ASK.** The plugin does not return OpenClaw's
`requireApproval`: an OpenClaw `/approve` would let the call run with no
Guardian decision and no receipt. The person approves in Guardian; OpenClaw's
log shows `held for approval (request req_…)` while it waits.

If the handler throws or OpenClaw's hook timeout expires first, OpenClaw
itself blocks the call: its hook runner treats `before_tool_call` as
fail-closed (checked in 2026.7.1's source and by running it).

### Which Guardian tool each call becomes

Shell commands use the same classifier as `@odingard/guardian-hook`, so a
command maps to the same Guardian tool under OpenClaw and Claude Code.

| OpenClaw tool                                                                                                                                                                                          | Guardian tool                                                                                                            | Tier           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------- |
| `exec` / `bash`                                                                                                                                                                                        | `shell`, `shell_deploy`, `shell_destructive`, `git_push` (by command)                                                    | by tool        |
| `process` write / send-keys / paste / submit                                                                                                                                                           | the exact bytes written, classified; `openclaw.process_input` if that is an everyday tool                                | Ask            |
| `process` kill / remove / clear                                                                                                                                                                        | `shell`                                                                                                                  | everyday       |
| `write`, `edit`, `apply_patch`                                                                                                                                                                         | `file_write` (path(s) and a SHA-256 digest; the content is not sent); `shell_destructive` on OpenClaw config/state paths | everyday / Ask |
| `exec` in Code Mode (`toolKind: code_mode_exec`)                                                                                                                                                       | `openclaw.code_mode_exec` (the script, its size and digest)                                                              | Ask            |
| `web_fetch`                                                                                                                                                                                            | `web_fetch`                                                                                                              | everyday       |
| MCP tools `server__tool`                                                                                                                                                                               | `mcp.<server>.<tool>`, e.g. `mcp.composio.gmail_send_email`                                                              | Ask            |
| Everything else (`message`, `browser`, `sessions_spawn`, `subagents`, `sessions_send`, `cron`, `gateway`, `nodes`, `canvas`, `code_execution`, `tool_call`, media generation, plugin tools, new tools) | `openclaw.<tool>`, e.g. `openclaw.message`                                                                               | Ask            |
| `read`, `web_search`, `x_search`, `session_status`, `sessions_list`, `sessions_history`, `agents_list`, `get_goal`, `tool_search`, `tool_describe`, `process` list / poll / log / status               | not sent to Guardian (read-only)                                                                                         | —              |

Commands or reads that touch a process environment (`/proc/…`, `environ`,
`GUARDIAN_AGENT_CREDENTIAL`) go to the Ask tier as `shell_destructive`. So
does a `read` of a start-up env file (`.env`, `.env.*`, `gateway.env`) in the
state directory, a control root, OpenClaw's config directory
(`~/.config/openclaw`) or above the workspace (`../.env`); the Guardian
arguments carry `touches: "openclaw-env-file"`. A `.env` inside the agent
workspace is read without asking.

`apply_patch` classifies every `*** Add/Update/Delete File:` and
`*** Move to:` header in the patch, however many there are. The Guardian
arguments list the first 50 files; `morePaths` counts the rest, and
`controlPlanePaths` names (up to 10 of) the paths that sent the call to the
Ask tier.

**OpenClaw's own control plane is Ask-tier (a backstop).** The primary
defence is the install-integrity check below; these patterns only narrow the
gap when an operator has opted out of it. OpenClaw watches
`openclaw.json` and hot-reloads it (default reload mode `hybrid`; a
`plugins.*` change reloads plugins with no restart), so an everyday call that
edits it could switch Guardian off. These go to the Ask tier as
`shell_destructive`: any `exec` that runs the `openclaw` CLI or names
`openclaw.json`, the `.openclaw` state directory (outside its `workspace`),
the legacy `.clawdbot` directory or `clawdbot.json` (which OpenClaw still
reads),
`guardian-openclaw`, `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` /
`OPENCLAW_HOME` or the locations those variables point to; and any `write`,
`edit` or `apply_patch` on such a path, or on a relative path that climbs out
of the workspace (`../…`), and any `exec` whose `workdir` is such a path.
The CLI is recognised quoted or escaped too (`"openclaw"`, `o'p'enclaw`), as
are `plugins.entries.guardian` and `plugins disable|uninstall|remove …guardian`
whatever runs them. Any `exec` that creates a symbolic or hard link (`ln`,
`link`, `cp -s` / `cp -l`, `mklink`, PowerShell `-ItemType SymbolicLink`, or
the `symlink` / `link` calls of Python, Node, Perl and Ruby, pathlib's
`symlink_to` / `hardlink_to`, Ruby's `FileUtils.ln*`, any abbreviation of
`cp --symbolic-link` / `--link` such as `cp --sym`, and any `symlink` /
`link` / `ln_s` word in inline `perl` / `ruby` / `python` / `node` code,
parentheses or not) is Ask-tier too, wherever it points: otherwise
`ln -s .. s` followed by a `write` to `s/extensions/guardian/index.js` would
be two everyday calls. An `exec` whose command has a `..` path operand
(`mv ../extensions/guardian x`, `cp -r evil/. ..`, `tar -C ..`,
`git --work-tree=..`) is Ask-tier whenever its cwd may be the agent workspace
(no `workdir`, a relative one, or one inside a state directory or control
root), because from `~/.openclaw/workspace` one `..` is the state directory. The state
directory names and the control roots are matched case-insensitively (APFS on
macOS is case-insensitive), and `apply_patch` headers are read with leading
whitespace, as OpenClaw reads them. Paths are matched after normalising them exactly as
OpenClaw 2026.7.1's file tools do: one leading `@` dropped, unicode spaces
turned into spaces, a `file://` URL decoded (percent-escapes included, so
`file:///data/%2Eopenclaw/openclaw%2Ejson` is `/data/.openclaw/openclaw.json`),
`~` expanded and `.`/`..` collapsed. A path that cannot be normalised (a
`file://` URL with a host other than `localhost`, a `file://` URL with an
encoded `/`, any other `scheme://`, a NUL byte) goes to the Ask tier whatever it names; the same holds for `read`.

**`process` input is never on the everyday tier.** Guardian is shown exactly
what OpenClaw 2026.7.1 writes: `data` for `write`, `text` for `paste`,
`literal` + `hex` bytes + `keys` for `send-keys`, a CR for `submit`. A field
the action does not write (a decoy such as `text: "ls"` next to the real
`data`) blocks the call. Because a command can be typed in pieces across
calls, every input goes to the Ask tier: a consequential chunk keeps its own
name, anything else is `openclaw.process_input`.

`exec` env overrides are shown as names plus a digest, never values, and an
`exec` that carries any override is never on the everyday tier (`bash -c
"$X"`, `BASH_ENV`, `LD_PRELOAD` and `GIT_*` can change what any command
does): an everyday command becomes `shell_destructive`. A field Guardian
decides on (`command`, `path`, `url`, the patch `input`, typed text) must be
a string, or the call is blocked.

Code Mode's `exec` runs JavaScript in OpenClaw's sandbox, and each tool it
calls goes through `before_tool_call` on its own. The script itself is
governed as `openclaw.code_mode_exec` on the Ask tier; if you rely on the
per-tool checks, add it to `allowTierTools`. Not yet proven live.

Guardian modes are per connection, so the plugin uses two record-only
connections: everyday tools go to `connectionId` (set it to Allow), Ask-tier
tools to `askConnectionId` (set it to Ask me first). `allowTierTools` moves
named Guardian tools (for example `openclaw.tool_call`) to the everyday
connection.

## Required: protect the install

The agent's default workspace, `~/.openclaw/workspace`, is inside OpenClaw's
state directory, next to `openclaw.json` (which OpenClaw hot-reloads) and
this plugin. If the user the Gateway runs as can
change those, one everyday command (`mv ../extensions/guardian x`) switches
Guardian off, and no command pattern can catch every way of writing it.
So the plugin checks the files themselves.

**What the plugin checks.** When it loads, and before every tool call
(a result is reused for at most 5 s), it asks whether the OpenClaw process
user can change any of:

- the Guardian plugin's own directory (found from the plugin's real path),
  every file and directory in it, and `<state dir>/extensions/guardian`.
  Where OpenClaw 2026.7.1 puts the plugin depends on how it was installed:
  `npm:` and `npm-pack:` installs go to
  `<state dir>/npm/projects/<name>/node_modules/@odingard/guardian-openclaw`;
  a local directory or `.tgz` (`openclaw plugins install ./dir`) is copied to
  `<state dir>/extensions/guardian`; `--link` loads it from the source
  directory itself, which then must be protected the same way;
- every package the plugin imports at runtime. There should be none: `dist`
  is bundled (the Guardian SDK and zod included) and imports only Node.js
  builtins, so the plugin directory is self-contained. As a second line, the
  check reads the plugin's entry files and `package.json` dependencies,
  resolves each non-builtin import from the plugin's real path as Node.js
  would, and checks the package it finds (every file, every parent) and
  every nearer `node_modules` where a shadowing copy could be created; an
  import it cannot find blocks;
- the OpenClaw config: `OPENCLAW_CONFIG_PATH` if set, otherwise every
  candidate OpenClaw would read up to the first one that exists
  (`<state dir>/openclaw.json`, `<state dir>/clawdbot.json`, then the same in
  `~/.openclaw` and `~/.clawdbot`), plus `openclaw.json5` beside it;
- `<state dir>/extensions/` (a new plugin could be dropped in);
- `<state dir>/npm/` (managed npm plugin installs), every file in it;
- `<state dir>/hooks/` (managed hooks: OpenClaw imports their code into the
  Gateway at start-up when internal hooks are on, and a managed hook can
  override a bundled one of the same name), every file in it;
- the start-up env files OpenClaw loads into the Gateway's environment:
  `.env` in the Gateway's working directory, `<config dir>/.env` and, unless
  `OPENCLAW_STATE_DIR` points elsewhere, `~/.config/openclaw/gateway.env`;
- the npm config files npm would read with the Gateway's environment: the
  user config (`$HOME/.npmrc`, or `npm_config_userconfig`) and the global
  config (`<node prefix>/etc/npmrc`, or `npm_config_globalconfig` /
  `npm_config_prefix`). OpenClaw runs npm with the caller's environment and
  no `--userconfig`, so an `.npmrc` the Gateway user wrote in its home would
  choose the registry for anyone who runs `openclaw plugins install` with
  that `HOME`, root included;
- `<state dir>/mpm/` and `<state dir>/plugins/`: OpenClaw reads plugin
  catalogs from `mpm/plugins.json`, `mpm/catalog.json` and
  `plugins/catalog.json`, and migrates a legacy `plugins/installs.json`;
- the active config's backups: `openclaw.json.bak` (OpenClaw restores the
  config from it when the config reads as damaged) and any
  `openclaw.json.bak.*`;
- for `npm/`, `hooks/`, `mpm/`, `plugins/`, the env files, the npm config
  files and `openclaw.json.bak`, a path that does not exist counts if the
  user could create it;
- every parent directory of those paths, as written and after resolving
  links: a writable parent lets the user rename what is inside it and put
  its own copy in place, unless the parent is sticky (`chmod +t`) and the
  entry belongs to someone else, or the entry is immutable.

"Can change" is decided from the inode: an entry the user **owns** counts as
writable even at mode 0444 (it can `chmod` it back), unless it is immutable
(`chattr +i`) or on a read-only mount; otherwise group or other write bits
(for a group the user is in) or a successful `access(W_OK)` (ACLs) count.
**A Gateway running as root (uid 0) always fails**: root can change any
file. Run the Gateway as an unprivileged user with no extra capabilities.
Any error while checking counts as writable.

**If the check fails, every tool call is blocked**, read-only tools
included, and Guardian is never asked. The block reason and the Gateway log
("the install is not protected…") list the paths and how to fix them.

**`GUARDIAN_*` settings come only from the Gateway's real environment.**
OpenClaw 2026.7.1 loads `.env` from the Gateway's working directory into its
environment at start-up and does not filter `GUARDIAN_*` keys. So any
`GUARDIAN_*` key named in that file (the opt-out, the credential, the
connection ids, the agent name, the base URL, the approval timeout) is
ignored, whatever its value, and the Gateway log says so. Set them only in
the environment the Gateway is started with: the container or service
definition (for example a systemd `Environment=`/`EnvironmentFile=` owned by
root and readable only by root, or the container's secret environment). Do
not put `GUARDIAN_AGENT_CREDENTIAL` in `<state dir>/.env` or any other file in
the state directory: the protection below makes those files read-only, not
unreadable, and the agent's `read` tool runs as the Gateway user. Keep the
`.env` files there empty (the recipe below creates them only so the agent
cannot).

### The official OpenClaw image

In `ghcr.io/openclaw/openclaw:2026.7.1` the Gateway runs as user
`node`, with `HOME=/data` and the state directory `/data/.openclaw`. Install
and configure the plugin first (steps 1-4 of [Install](#install)), then run
these as root in the container (`docker exec -u 0 -it <container> sh`, or a
root shell from your host; if you cannot get root in the container, the
install cannot be protected: see the opt-out below). Until now the Gateway
user could write everything here, so first read `openclaw.json`,
`$S/.env` and `/data/.config/openclaw/gateway.env` and check they say what
you expect. (While the check fails, every tool call is blocked, so the agent
cannot race these commands; a background process it started earlier could,
so restart the container first if in doubt.)

```bash
S=/data/.openclaw
# Refuse links: the commands below chown and chmod these paths as root, and
# the Gateway user could have replaced any of them with a link to a system file.
for p in /data/.npmrc "$S"/openclaw.json* "$S/.env" /data/.config/openclaw/gateway.env; do
  if [ -L "$p" ] || { [ -e "$p" ] && [ "$(stat -c %h "$p")" != 1 ]; }; then echo "refusing: $p is a link"; exit 1; fi
done
for p in /data/.config /data/.config/openclaw /data/.npm "$S/extensions" "$S/npm" "$S/hooks" "$S/mpm" "$S/plugins"; do
  if [ -L "$p" ]; then echo "refusing: $p is a link"; exit 1; fi
done
# npm's user config, which any npm run with HOME=/data reads (a registry, a
# script shell, ...): an empty file the Gateway user cannot replace. npm's
# cache: removed (upkeep below never uses the Gateway user's cache).
rm -f /data/.npmrc && : > /data/.npmrc
rm -rf /data/.npm
# The directories OpenClaw loads plugin code, hooks or plugin catalogs from,
# the start-up env files and the config backup (OpenClaw restores the config
# from openclaw.json.bak) must exist, so the agent cannot create them. Leave
# the env files empty: they stay readable by the Gateway user, so no secret
# (such as GUARDIAN_AGENT_CREDENTIAL) belongs in them.
mkdir -p "$S/extensions" "$S/npm" "$S/hooks" "$S/mpm" "$S/plugins" /data/.config/openclaw
touch "$S/.env" /data/.config/openclaw/gateway.env
rm -f "$S"/openclaw.json.bak* && cp "$S/openclaw.json" "$S/openclaw.json.bak"
# Plugins (npm:/npm-pack: installs live under npm/, local-path installs under
# extensions/), managed hooks, catalogs, config and env files: root-owned,
# read-only.
chown -R root:root "$S/extensions" "$S/npm" "$S/hooks" "$S/mpm" "$S/plugins" /data/.config/openclaw
chown root:root "$S/openclaw.json" "$S/openclaw.json.bak" "$S/.env" /data/.npmrc
chmod -R a-w,a+rX "$S/extensions" "$S/npm" "$S/hooks" "$S/mpm" "$S/plugins" /data/.config/openclaw
chmod 0444 "$S/openclaw.json" "$S/openclaw.json.bak" "$S/.env" /data/.npmrc
# Parents: root-owned and sticky. The Gateway can still create its own state
# (sessions, logs, the workspace) but cannot rename or replace root's entries.
for d in /data /data/.config "$S"; do chown root:node "$d"; chmod 1775 "$d"; done
```

The Gateway's working directory (`/app` in the official image) must not be
writable by `node` either, so it cannot create a `.env` there; in the
official image it is root-owned. If the Gateway is started from a directory
`node` can write (a `cd /data` in a start script, say), the check reports
`<dir> (can create the Gateway's start-up env file <dir>/.env)` and every
tool call is blocked until the Gateway is started from a root-owned
directory. If you installed with `--link`, protect the linked source
directory like `$S/npm`.

This recipe was run end to end on a real OpenClaw 2026.7.1 layout, with
`/data` replaced by a scratch directory and `node` by uid 1000: as uid 1000,
`openclaw plugins install npm-pack:…` (and, separately, a local-directory
install into `extensions/guardian`), the config written, an `.npmrc` planted
in the home directory, the check failing; then the recipe as root; then, as
uid 1000, the check passing, `openclaw plugins inspect guardian --runtime`
listing `before_tool_call` with no "not protected" warning, an everyday call
reaching a stand-in Guardian, and these refused: writing the plugin's
`dist/index.js`, renaming `npm/`, the npm project, `extensions/` or the
state directory, creating a hook in `hooks/` or a catalog in `mpm/` or
`plugins/`, writing or replacing `openclaw.json`, `openclaw.json.bak`,
`$S/.env`, `gateway.env`, `/data/.npmrc` or a `.env` in the working
directory. The upkeep below was run the same way, with a Gateway-user
`.npmrc` naming another registry in place. It has not been run on a hosted
deployment.

Then restart the agent. The Gateway log must not say "the install is not
protected", and an everyday call (`ls`) must reach Guardian. OpenClaw itself
can no longer rewrite `openclaw.json`, so Gateway features that save config
(onboarding, the `gateway` tool's config changes) fail; that is the point.

#### Upkeep: config changes and Guardian updates

From now on these need root, and two things make root's commands an attack
path if done carelessly:

- **npm reads files the Gateway user can write.** npm reads `$HOME/.npmrc`
  (which can set the registry, a script shell, ...), uses `$HOME/.npm` as
  its cache, and reads `.npmrc` in its working directory. OpenClaw 2026.7.1
  runs npm with the caller's environment and no `--userconfig`, and it drops
  any `npm_config_cache` you set, so with `HOME=/data` root's install would
  use the Gateway user's cache and (without the recipe's empty
  `/data/.npmrc`) a registry the Gateway user chose; re-running the
  `chown`/`chmod` lines would then make what it installed root-owned, and
  the check would pass with Guardian gone. So every npm or `openclaw`
  command root runs uses `HOME=/root`, a root-owned working directory, no
  npm user config (`/dev/null`), an empty root-owned global config, a
  root-owned cache and an explicit registry. (OpenClaw's CLI also loads `.env` from its working
  directory.)
- **Running the `openclaw` CLI as root runs OpenClaw, and plugin code, as
  root.** It reads `state/openclaw.sqlite`, which the Gateway user can write
  and which records where each plugin's code is (see
  [What is not governed](#what-is-not-governed)), so it can load code the
  Gateway user chose, as root. Do not run it as root against the live state
  directory: edit `openclaw.json` directly and update Guardian from a
  verified tarball, as below. Run `openclaw` commands that only read (such
  as `config validate` and `plugins inspect`) as `node`.

```bash
# As root. Nothing below reads a file the Gateway user can write.
cd /root && umask 022
# npm's user config: none; its global config: an empty root-owned file (npm
# refuses /dev/null for both); its cache: root's.
: > /root/empty.npmrc
export HOME=/root NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG=/root/empty.npmrc \
  NPM_CONFIG_CACHE=/root/.npm NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
S=/data/.openclaw
P="$S/npm/projects/odingard-guardian-openclaw-5825bd791f/node_modules/@odingard/guardian-openclaw"

# A config change: edit a copy, then put it in place (install(1) replaces the
# file; it does not write through a link). No OpenClaw code runs as root.
cp "$S/openclaw.json" /root/openclaw.json.new
vi /root/openclaw.json.new
install -o root -g root -m 0444 /root/openclaw.json.new "$S/openclaw.json"
install -o root -g root -m 0444 /root/openclaw.json.new "$S/openclaw.json.bak"
(cd /app && setpriv --reuid node --regid node --init-groups env HOME=/data openclaw config validate)

# A Guardian update: fetch the published tarball (npm checks it against the
# registry's integrity), compare that integrity with the one in the Guardian
# release notes, unpack it and swap it in. The plugin is one self-contained
# directory (dist is bundled), so nothing else changes.
V=0.1.1
mkdir -p /root/guardian && cd /root/guardian
npm pack "@odingard/guardian-openclaw@$V" --registry https://registry.npmjs.org/ --json > "pack-$V.json"
grep '"integrity"' "pack-$V.json"
rm -rf "pkg-$V" && mkdir "pkg-$V" && tar -xzf "odingard-guardian-openclaw-$V.tgz" -C "pkg-$V" --no-same-owner
rm -rf "$P.new" && cp -R "pkg-$V/package" "$P.new"
mv "$P" "$P.old" && mv "$P.new" "$P" && rm -rf "$P.old"
```

`$P` is where `npm:` / `npm-pack:` installs put Guardian in 2026.7.1
(`openclaw plugins inspect guardian --json`, as `node`, shows it as
`rootDir`); for a local-directory install it is `$S/extensions/guardian`.

**After every upkeep, verify, then re-lock.** Check that the installed
plugin is the published one, byte for byte, then run the protect recipe
above again and restart the agent:

```bash
cd /root/guardian
tar -xzOf "odingard-guardian-openclaw-$V.tgz" package/dist/index.js | sha256sum
sha256sum "$P/dist/index.js"   # must print the same digest
diff -r "pkg-$V/package" "$P" && echo "Guardian matches the published package"
```

If you must run the `openclaw` CLI as root (to install another plugin),
export the same environment first, run the integrity step for every plugin
afterwards, and treat it as running whatever code the state database names.

If the config uses `$include`, protect the included files the same way: the
plugin does not read `openclaw.json` and does not check them.

### Other hosts

- Install the plugin and write the config as root (or another admin user),
  and run the Gateway as its own unprivileged user, from a working directory
  it cannot write.
- Prefer a state directory outside a home the Gateway user can write, e.g.
  `OPENCLAW_STATE_DIR=/srv/openclaw` with `/srv/openclaw` owned by
  `root:openclaw` and mode `1775`, set in the service's environment (not in a
  file the Gateway user can write). Put `openclaw.json`, an empty `.env`,
  `extensions/`, `npm/` and `hooks/` there, root-owned and read-only, as
  above. Keep `GUARDIAN_AGENT_CREDENTIAL` in the service's environment, not in
  a file the Gateway user can read.
- If the state directory stays in the Gateway user's home (`~/.openclaw`),
  the home directory itself must be root-owned and sticky, or the user can
  rename `~/.openclaw` away.
- `chattr +i` on the files and directories is an alternative to root
  ownership (an immutable entry cannot be changed, renamed or removed).

### Opting out (not tamper-proof)

`GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL=1` in the Gateway's start-up
environment turns the check off and keeps the pattern-based behaviour. It is
read once, when the plugin loads; setting it later (the agent cannot change
the running Gateway's environment) has no effect. The plugin logs one
warning at load. **In this mode the agent can switch Guardian off** by
changing the plugin or the OpenClaw config with an everyday command the
patterns do not recognise; do not describe such a deployment as
tamper-proof or claim coverage for it. Set it only in a place the agent cannot
write: a `.env` file in the state directory that the agent can write would let
the agent turn the check off at the next restart, which is why those files
are checked. A value from `.env` in the Gateway's working directory is always
ignored (see above).

## Install

1. **Guardian console.** Create the agent first (Agents → New agent → Create
   agent) and copy its credential; it is shown once. Then, on the agent's page,
   "Set up for Claude Code" creates (or reuses) its two connections ("Coding
   agent — everyday", "Coding agent — needs approval") and allows the shell,
   file and fetch tools; it does not create the agent or the credential. A tool
   must be on a connection before it can be allowed: add the `openclaw.<tool>`,
   `openclaw.process_input` and `mcp.<server>.<tool>` names the agent will use
   to "Coding agent — needs approval" with "Add tools" on its card under
   Connections, then on the agent's page use "Allow a tool by name" for each.
   Until both are done, those calls are denied as `INVALID_REQUEST`.

2. **Gateway environment.** Set `GUARDIAN_AGENT_CREDENTIAL` as a secret
   environment variable of the process that runs the OpenClaw Gateway. Never
   put it in `openclaw.json` (the agent can read that file; the plugin's config
   schema rejects a `credential` key).

3. **Install and enable the plugin:**

   ```bash
   openclaw plugins install npm:@odingard/guardian-openclaw@0.1.0 --pin
   openclaw plugins enable guardian
   ```

   Before the package is published, install the packed tarball instead:
   `openclaw plugins install npm-pack:/path/to/odingard-guardian-openclaw-0.1.0.tgz`.

4. **Config.** Merge into `openclaw.json`:

   ```json
   {
     "plugins": {
       "entries": {
         "guardian": {
           "enabled": true,
           "hooks": { "timeouts": { "before_tool_call": 330000 } },
           "config": {
             "connectionId": "pcn_…everyday",
             "askConnectionId": "pcn_…needs-approval",
             "agentName": "My OpenClaw agent"
           }
         }
       }
     }
   }
   ```

   `hooks.timeouts.before_tool_call` must be at least the approval window
   plus redemption time: 330000 ms (5 min 30 s; OpenClaw allows up to
   600000). The plugin already asks for 330000, but an operator value
   overrides it. If you set a shorter one, the plugin shrinks its approval
   wait to fit and never redeems after OpenClaw has stopped waiting, so
   approvals simply have less time.

5. Restart the Gateway, then check the hook is live:

   ```bash
   openclaw plugins inspect guardian --runtime --json   # typedHooks: before_tool_call
   ```

   If the credential or `connectionId` is missing, the Gateway log says
   "Guardian plugin is not configured" and every governed call is blocked.

6. **Protect the install** ([Required: protect the install](#required-protect-the-install)).
   Until you do, the Gateway log says "the install is not protected" and
   every tool call is blocked.

| Config (`plugins.entries.guardian.config`) | Env fallback                      | Default                                 |
| ------------------------------------------ | --------------------------------- | --------------------------------------- |
| `connectionId` (required)                  | `GUARDIAN_CONNECTION_ID`          |                                         |
| `askConnectionId`                          | `GUARDIAN_HOOK_ASK_CONNECTION_ID` | `connectionId`                          |
| `baseUrl` (https only)                     | `GUARDIAN_BASE_URL`               | `https://guardian-api.odingard.com`     |
| `agentName`                                | `GUARDIAN_HOOK_AGENT_NAME`        | `OpenClaw` (plus the OpenClaw agent id) |
| `approvalTimeoutMs`                        |                                   | `300000` (also the maximum)             |
| `allowTierTools`                           |                                   | `[]`                                    |

Running on the official image: see [examples/openclaw](../../examples/openclaw).

## NVIDIA NemoClaw (OpenShell)

**Status: verified on Guardian staging with NVIDIA NemoClaw v0.0.143, NVIDIA
OpenShell 0.0.116, the OpenClaw that NemoClaw release ships (2026.10.5) and
plugin 0.1.0**: an allowed `shell` call ran, a destructive one waited for a
person and ran once after approval, and one on a connection set to Off was
refused with no prompt. Guardian production was not part of that run. The
step-by-step guide is
[examples/nemoclaw](../../examples/nemoclaw). The rest of this README
describes OpenClaw 2026.7.1; this section notes where NemoClaw differs. Plugin
0.1.1, including an in-place Gateway restart, was then verified on the same
setup.

In a NemoClaw sandbox the Gateway never sees the raw credential. OpenShell
gives it a placeholder, `openshell:resolve:env:v<N>_GUARDIAN_AGENT_CREDENTIAL`,
and on requests to the endpoints of the credential's provider profile,
OpenShell's proxy puts the real value in place of the placeholder wherever it
appears in the request line or headers: in any header, not only
`Authorization`, and in URL path segments and query parameters. It does not
resolve the placeholder for other hosts or paths. The raw value stays outside
the sandbox.

**Register the credential through NemoClaw, then rebuild.** Import an
OpenShell provider profile for the Guardian API on the host (endpoint: your
Guardian API host on port 443, the agent paths `POST /v1/agent/requests`,
`POST /v1/agent/claims`, `POST /v1/agent/execute` and
`GET /v1/agent/receipts/**`; credential env var `GUARDIAN_AGENT_CREDENTIAL`,
bearer; see the guide's
[`guardian-api-profile.yaml`](../../examples/nemoclaw/guardian-api-profile.yaml)),
then:

```bash
nemoclaw credentials add <name> --type <profile id> --credential GUARDIAN_AGENT_CREDENTIAL
nemoclaw <sandbox> rebuild --yes
```

so the provider is attached when the sandbox is created. Do not use
`openshell provider create` with `openshell sandbox provider attach`
instead: NemoClaw does not record that provider, so its next rebuild drops
it, and an attachment made after the Gateway started never reaches the
running Gateway. Set `plugins.entries.guardian.config.baseUrl` in
`openclaw.json` to the same Guardian API host as the profile. Do not rely on
`GUARDIAN_BASE_URL` here: NemoClaw has no general way to set a Gateway
environment variable (see the opt-out paragraph below).

**Allow the Guardian API host in the sandbox's network policy.** The
sandbox's network policy refuses the Guardian API host until a rule allows
it. Add a NemoClaw custom policy preset with one host, the same four agent
paths and one binary:

```yaml
preset:
  name: guardian-api
  description: "Guardian decision API for @odingard/guardian-openclaw"
network_policies:
  guardian_api:
    name: guardian_api
    endpoints:
      - host: guardian-api.odingard.com   # your Guardian API host
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: POST, path: "/v1/agent/requests" }
          - allow: { method: POST, path: "/v1/agent/claims" }
          - allow: { method: POST, path: "/v1/agent/execute" }
          - allow: { method: GET, path: "/v1/agent/receipts/**" }
    binaries:
      - { path: /usr/local/bin/node }
```

```bash
nemoclaw <sandbox> policy add --from-file ./guardian-api.yaml --dry-run
nemoclaw <sandbox> policy add --from-file ./guardian-api.yaml --yes
```

Check the dry-run preview (one host, four rules, one binary) before you
apply it. Leave TLS inspected (no `tls: skip`): OpenShell must see the
request to put the credential in. **The binary is `/usr/local/bin/node`:**
OpenShell sees the Gateway's requests as coming from Node.js, not from
`/usr/local/bin/openclaw`, and a rule that names only `openclaw` is refused
(`binary '/usr/local/bin/node' not allowed`). When OpenShell's
`providers_v2_enabled` setting is on (NemoClaw turns it on when it sets up
its `build` inference provider), the attached provider also adds its own policy layer
for the same host, with the profile's `binaries`; the guide's profile names
`/usr/local/bin/openclaw`, so that layer admits nothing and the preset is
the rule the Gateway uses. Without the preset, the Gateway cannot reach
Guardian and every governed call is blocked.

**Restarts.**

- **0.1.0:** the plugin removes the placeholder from the Gateway's
  environment, so after an in-place restart (`nemoclaw <sandbox> gateway
  restart`, or a config reload that restarts the Gateway) the new Gateway
  logs "Guardian plugin is not configured" and blocks every governed call.
  Use `nemoclaw <sandbox> stop` then `nemoclaw <sandbox> start`: the
  container start gives the Gateway a fresh environment from OpenShell, with
  the placeholder. Make no OpenClaw change after the last start.
- **0.1.1 and later (verified on NemoClaw v0.0.143):** when
  `GUARDIAN_AGENT_CREDENTIAL` is exactly an OpenShell placeholder (`v<N>_`
  revision or `s<64 hex>_` digest form, for this variable only), the plugin
  leaves it in the Gateway's environment and logs that it kept an OpenShell
  placeholder (it never logs the value). NemoClaw restarts the Gateway in
  place by re-executing it with a copy of that environment, so the new
  Gateway finds the placeholder again and stays configured. A raw credential
  is still removed from the environment, as before. A hand-written
  `openshell:resolve:env:GUARDIAN_AGENT_CREDENTIAL` (no revision) is treated
  as raw, and OpenShell would not resolve it anyway. Stop then start also
  works.

**Opt-out mode is required, and it is not tamper-proof.** NemoClaw runs the
Gateway as the `sandbox` user and keeps `/sandbox/.openclaw` (the OpenClaw
config included) writable by that user by design, so the install check in
[Required: protect the install](#required-protect-the-install) cannot pass
and every tool call is blocked ("the install is not protected… Nothing
ran."). A protected install is not possible in NemoClaw today. The plugin
then runs only in its opt-out mode, `GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL=1`.
NemoClaw has no general way to set a Gateway environment variable; the
route that works is a line in `/sandbox/.openclaw/.env`, which OpenClaw
2026.10.5 loads from its state directory. The flag does not show in the
Gateway's start-up environment (`/proc/<pid>/environ`); the check is the
Gateway log after the next start, which shows the plugin's one opt-out
warning ("`GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL=1`, so the
install-integrity check is off"). The plugin ignores `GUARDIAN_*` keys from
`<cwd>/.env`, so the route works only while the Gateway's working directory
is not `/sandbox/.openclaw`. It was `/sandbox` in the tested versions;
NemoClaw does not guarantee that. This departs from the advice in
[Opting out](#opting-out-not-tamper-proof) to set the flag only where the
agent cannot write: the agent can edit that `.env`. **In this mode the agent
can switch Guardian off**: do not describe a NemoClaw deployment as
tamper-proof. Never put credential material in that `.env` file; a
placeholder written there by hand would not resolve.

**Which processes can use the placeholder (`binaries`).** The binary
allowlist on the policy rules for the Guardian API host is what limits who
can use the credential; OpenShell does not check which binary is calling
when it resolves the placeholder. With `/usr/local/bin/node` allowed, `curl`
and other tools are refused (`binary '/usr/bin/curl' not allowed`), but
**any Node.js process in the sandbox can reach the Guardian API host on the
four agent paths**. The placeholder is not a secret (its form is
predictable, and on 0.1.1 every process the Gateway starts, `exec` commands
included, inherits it), so such a process can send it, get the agent
credential put in its place, and propose actions as the agent or redeem
ones that were approved. It cannot approve anything: approvals need a
person in Guardian. That is the reach the agent already has through the
Gateway.

**Paths under `/sandbox` go to Ask.** NemoClaw sets `OPENCLAW_HOME=/sandbox`,
so the plugin treats `/sandbox` as OpenClaw's control plane: a shell command
that names a path under `/sandbox` outside `/sandbox/workspace*` is
`shell_destructive` and waits for a person. That includes the agent's own
workspace, `/sandbox/.openclaw/workspace` (`ls -la /sandbox` goes to Ask;
`ls -la` with no path is everyday `shell`).

**Logs.** The Gateway log has a Guardian line for an allowed call
(`Allowed by Guardian policy (request req_…)`), a held one
(`is held for approval (request req_…)`) and an approved one
(`Approved by a human in Guardian (request req_…)`). Plugin 0.1.0 writes no
line when Guardian denies a call or a connection is Off; the console's
Activity page and the receipt are the record.

## What is not governed

Say this plainly to anyone relying on it.

- **Whoever can change `openclaw.json`, the plugin list or the plugin's
  files can remove Guardian, and OpenClaw hot-reloads that change.** If the
  plugin is disabled, uninstalled, fails to load, or is excluded by
  `plugins.allow`/`plugins.deny`, OpenClaw runs tools with no Guardian check.
  With a protected install (above) the agent cannot make these changes
  through files: the plugin blocks every call while it could. What remains:
  - **A person or process with root, or the operator,** can still change the
    install. So can anything that runs as another user with write access.
  - **The Gateway itself**, through tools that act inside it, such as the
    `gateway` tool (whether it can change the running config without writing
    the file has not been checked). It is Ask-tier (`openclaw.gateway`): a
    person must approve it.
  - **OpenClaw's state database, `<state dir>/state/openclaw.sqlite`.**
    OpenClaw 2026.7.1 keeps its installed-plugin index there (each plugin's
    install path and cached manifest, entry file and root directory), next to
    sessions, cron jobs, exec approvals and device pairings, so the Gateway
    must be able to write it and the check cannot require it read-only.
    Checked in 2026.7.1 by running it: rewriting the `guardian` entry's paths
    in the `installed_plugin_index` table to a directory the agent made made
    `openclaw plugins inspect guardian --runtime` load that copy instead
    (status `loaded`, no `before_tool_call` hook), with the real plugin
    untouched. So an agent that can write the database and get the Gateway
    restarted can swap Guardian out, and the check (running inside the
    plugin) cannot see it. **Mitigation:** do not let the agent's tools run
    as the user that owns the state directory: run `exec` and the file tools
    in OpenClaw's sandbox (a container without the state directory) or on a
    node host as another user. The control-plane patterns above put
    commands that name the state directory on the Ask tier, but an
    obfuscated command can get past them.
  - **Files the check does not cover:** OpenClaw's own installation
    (`/app` in the official image) and the Node.js runtime must not be
    writable by the Gateway user (they are root-owned in the official
    image); `$include`d config files; anything named by `OPENCLAW_INCLUDE_ROOTS`,
    `plugins.load.paths` or `hooks.internal.load.extraDirs`; and service
    files or environment outside OpenClaw (systemd units, the container's
    environment).
  - **npm and the `openclaw` CLI run by someone else.** The check covers
    the npm config files npm reads for the Gateway's `HOME` and environment,
    but not npm's cache (`$HOME/.npm`, which the Gateway user may own and
    use for its own `npm install`s), npm's builtin `npmrc` (part of the
    Node.js install), an `.npmrc` in whatever directory a command is run
    from, or another user's home. Root (or anyone) running npm or
    `openclaw plugins install` / `update` with `HOME=/data`, from a
    directory the Gateway user can write, reads those; running the
    `openclaw` CLI as root also runs OpenClaw, and the plugin code the state
    database names, as root. See
    [Upkeep](#upkeep-config-changes-and-guardian-updates) for how to do
    upkeep without either.
  - **Catalog paths set in the environment** (`OPENCLAW_PLUGIN_CATALOG_PATHS`,
    `OPENCLAW_MPM_CATALOG_PATHS`) are not checked; only the default
    `mpm/` and `plugins/` locations are.
  - **Workspace-origin plugins and hooks.** OpenClaw also discovers plugins
    and hooks inside the agent's workspace (for example `<workspace>/hooks`),
    which the agent can always write, and the check does not look at them.
    In 2026.7.1 they are disabled by default: a workspace hook loads only
    with `hooks.internal.entries.<name>.enabled: true`, a workspace plugin
    only if the config enables it, lists it in `plugins.allow` or selects it
    for the context-engine slot. A workspace plugin that calls itself
    `guardian` is outranked by the installed Guardian while its install
    record is intact (see the state database above). With the config
    protected the agent cannot enable them; do not enable any for an agent
    you govern.
  - **The check is a snapshot**, repeated at most every 5 s. A change made in
    between (by someone who can still write) is caught on the next check, not
    before it.
  - **With `GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL=1`, none of this
    holds**: only the patterns above stand between the agent and the config,
    and they are recognition by pattern. An obfuscated command (`base64 -d |
sh`, a variable holding the path), a link the plugin does not recognise
    (made by an archive tool or a script) or one that already existed, a
    relative path when the cwd is not the workspace, or a script the agent
    wrote earlier can still reach the config with no person asked.
    Check `openclaw plugins inspect guardian --runtime` after every config
    change.
- **Exfiltration through everyday tools.** `read` is not governed and
  ordinary shell commands are everyday, so `curl -X POST https://… -d @file`
  can send a file out with no person asked (the same is true under
  guardian-hook). Put network egress controls on the Gateway host if this
  matters.
- **Read-only tools are not sent to Guardian** (`read`, `web_search`, and the
  others in the table). They can still read secrets on disk; prompt-injected
  content they return is not checked.
- **Decision-gated, not effect-verified.** The receipt proves Guardian
  authorized that exact call; the tool runs after redemption. If OpenClaw
  later refuses the call anyway (its own tool policy, exec approvals, a
  sandbox rule, another plugin's block or `requireApproval` that is then
  declined), the receipt exists for a call that did not run.
- **Other plugins that change tool parameters.** The plugin registers at
  priority -10000 and returns the parameters Guardian saw. OpenClaw runs
  higher priorities first and keeps the last parameters returned, so a
  rewrite by a plugin above Guardian (keys it adds included) is replaced by
  what Guardian evaluated. Two exceptions: a plugin registered _below_
  -10000 runs after Guardian and its parameters win (check `openclaw plugins
inspect` for lower priorities), and if another plugin returned
  `requireApproval` with parameters and that approval is resolved, OpenClaw
  keeps that plugin's parameters. Do not combine Guardian with plugins that
  rewrite tool parameters.
- **The credential.** It is read from the Gateway environment at start-up and
  removed from `process.env`, so commands the agent runs do not inherit it.
  An OpenShell placeholder (NVIDIA NemoClaw) is the exception: it is kept,
  and children inherit it (see
  [NVIDIA NemoClaw (OpenShell)](#nvidia-nemoclaw-openshell)).
  The Gateway's original environment is still readable at
  `/proc/<gateway pid>/environ` by anything running as the same user;
  commands and reads that mention `/proc`, `environ` or the variable name go
  to the Ask tier, but an obfuscated command can get past that pattern. With
  the credential an agent can only make its own Guardian requests; it cannot
  approve an ASK. Inside the Gateway the credential is held on a
  process-global slot, so any other in-process plugin can read it; plugins
  are trusted code in OpenClaw. Run the Gateway as a different user from `exec` (sandboxed
  exec, or a node host) to close this.
- **Nested tool calls.** OpenClaw documents that calls made through Tool
  Search (`tool_call`, `tool_search_code`) go through `before_tool_call` as
  final calls. Until that is proven live, the wrapper is governed too, so one
  action can produce two Guardian requests.
- **The Codex app-server runtime** relays native tool calls through its own
  contract. OpenClaw documents that it rejects some parameter rewrites, so
  returning the evaluated parameters may block calls there (fail closed). Not
  tested.
- Channel replies the model writes as its normal answer are not tool calls
  and are not governed; only the `message` tool is.
- Things OpenClaw does without a tool call (cron jobs already scheduled,
  heartbeats, channel ingress) are not governed. Creating or changing a cron
  job through the `cron` tool is.

## Development

```bash
npm run build      # dist/index.js: self-contained (bundles guardian-hook's classifier and decide(), the SDK and zod); imports only node: builtins
npm test           # vitest, fake Guardian
npm run typecheck
```

License: Apache-2.0.
