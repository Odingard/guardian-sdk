# Guardian with NVIDIA NemoClaw (guide)

> **Verified on Guardian staging with NVIDIA NemoClaw `v0.0.143`, NVIDIA OpenShell `0.0.116` and OpenClaw `2026.10.5`, with `@odingard/guardian-openclaw` 0.1.0.** An allowed shell command ran, a destructive one waited for a person and ran once after approval, and one on a connection set to Off was refused with no prompt. Each left a receipt that verifies with staging's keys.
>
> **The verified run used Guardian staging** (`guardian-api-staging.odingard.com`), with these files changed only in the host name. The commands and files below name the production host, `guardian-api.odingard.com`. That host, and verifying receipts with production's keys, were not part of the run.
>
> **This setup is not tamper-proof.** In NemoClaw the plugin can only run in its opt-out mode, in which the agent can switch Guardian off. Read [Before you start](#before-you-start-this-setup-is-not-tamper-proof).

[NVIDIA NemoClaw](https://github.com/NVIDIA/NemoClaw) runs agents such as OpenClaw inside [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandboxes. This guide adds Guardian to an OpenClaw agent running in NemoClaw, with the published OpenClaw plugin and no code changes to Guardian, NemoClaw or OpenShell.

## What each one does

**NemoClaw contains the agent. Guardian decides each action.**

| NemoClaw and OpenShell                                                                                                        | Guardian                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Run the agent in a sandbox, with filesystem and process limits.                                                               | Sees each consequential tool call the OpenClaw plugin is shown (shell commands, file writes, messages, MCP tools…) before it runs.              |
| Deny network access by default: the sandbox reaches only the hosts its policy lists, and only from the binaries it names.     | Decides it: allow, ask a person, or deny. A person approves on their phone or in the console.                                                   |
| Keep provider credentials outside the sandbox: the agent sees a placeholder, and the proxy swaps in the real value at egress. | Binds the decision to the exact arguments. While the plugin is in place, an allowed call runs once, with the parameters Guardian saw. Each decision leaves a receipt anyone can verify. |

The sandbox decides **where** the agent can connect. Guardian decides **whether** a given action should happen, and leaves a record of who allowed it.

## Before you start: this setup is not tamper-proof

Read this before relying on Guardian inside NemoClaw.

`@odingard/guardian-openclaw` normally refuses to run unless its install is protected: the user the OpenClaw Gateway runs as must not be able to change the plugin, `openclaw.json`, the plugin directories or the start-up `.env` files ([Required: protect the install](../../packages/openclaw#required-protect-the-install)). NemoClaw is designed the other way. It runs the Gateway as the `sandbox` user and keeps `/sandbox/.openclaw`, including `openclaw.json`, writable by that user so the agent can manage its own config. Its docs say it "does not provide post-provisioning immutability for the OpenClaw config or state tree". **A protected install is not possible in NemoClaw today.** Without the opt-out mode, the plugin blocks every tool call ("the install is not protected… Nothing ran.").

So inside NemoClaw the plugin runs in its opt-out mode, `GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL=1` (step 7). **In that mode the agent can switch Guardian off** by changing the plugin or the OpenClaw config with an ordinary command the plugin's patterns do not recognise, and the plugin says so in the Gateway log at every start. Do not describe this setup as tamper-proof, and check `openclaw plugins inspect guardian --runtime` after every config change.

What the sandbox still gives you: the agent cannot reach any host the policy does not list, and never sees the Guardian credential.

## Prerequisites

- **A machine NemoClaw supports.** NemoClaw's primary tested path is Linux with Docker (Ubuntu 24.04). It needs at least 4 vCPU, 8 GB RAM (16 GB recommended) and 20 GB free disk (40 GB recommended). See NemoClaw's [prerequisites](https://github.com/NVIDIA/NemoClaw/blob/v0.0.143/docs/get-started/prerequisites.mdx). NemoClaw is alpha software.
- **Node.js 22.19 or later and npm 10 or later** on the host.
- **Inference.** A GPU is not needed if you use a hosted model. This guide uses NemoClaw's `build` provider (`NVIDIA_INFERENCE_API_KEY`); NemoClaw also supports other providers.
- **A Guardian account** and a phone signed in to the Guardian console, for approvals.

Versions this guide was verified with:

| Component                 | Version                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host                      | Ubuntu 24.04.5 LTS, 4 vCPU, 15 GiB RAM; Docker 29.9.3; Node.js 22.23.5, npm 10.9.9                                                                   |
| NemoClaw                  | `v0.0.143`, policy tier Restricted                                                                                                                   |
| OpenShell                 | `0.0.116` (NemoClaw `v0.0.143` requires exactly this version)                                                                                        |
| OpenClaw (in the sandbox) | `2026.10.5`; the Gateway runs on Node.js 24.22.1                                                                                                     |
| Sandbox image             | `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:435934d9928e953f2ac8dd2da963eaca9312c9b61501bdd428ec42494bc4def8` (NemoClaw picks it itself)        |
| Guardian plugin           | `@odingard/guardian-openclaw@0.1.0`, npm integrity `sha512-XM5fHYKJ0Q8sS4F5tpHFWWDmVLdzZJzatSf6GjEf8O/BBvq+QYE/F1I3fF1qQhQkqR7GNbajfCAY7u6Kz1IoiA==` |
| Guardian API              | Staging, `guardian-api-staging.odingard.com`. The files here name production, `guardian-api.odingard.com`, which was not part of the run.                |

This guide was verified with plugin 0.1.0, and its commands name 0.1.0. Plugin 0.1.1 has not been verified with it. 0.1.1 differs in three ways that matter here: it keeps the credential placeholder in the Gateway's environment, so every process the Gateway starts inherits it ([step 4](#4-add-the-one-egress-rule)); it logs one more line at start ([step 9](#9-check)); and it is meant to survive an in-place Gateway restart ([step 8](#8-stop-and-start-the-sandbox)).

Files in this folder:

- [`guardian-api-profile.yaml`](guardian-api-profile.yaml): an OpenShell provider profile that holds the Guardian credential outside the sandbox;
- [`guardian-api.yaml`](guardian-api.yaml): the one egress rule, as a NemoClaw custom policy preset;
- [`openclaw.json`](openclaw.json): the plugin's OpenClaw config, with placeholder connection ids.

## 1. Install NemoClaw

Pinned to a release, with OpenClaw as the agent and the **Restricted** policy tier, so the sandbox starts with NemoClaw's baseline network only. First save the installer and print its hash:

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh -o nemoclaw.sh && sha256sum nemoclaw.sh
```

The hosted installer is not versioned, so its hash can change. The copy used for this guide had SHA-256 `662dfc66b84c4507a6c1a3cc5429ab9ace6034c26a44ed84d446451e32db57d4`. Compare yours with it and read the script before you run it; if the hash differs, read what changed.

Then enter the inference key. Run this line on its own, then type or paste the key at the prompt and press Enter (it is not echoed):

```bash
read -rs NVIDIA_INFERENCE_API_KEY; export NVIDIA_INFERENCE_API_KEY
```

Then run the installer:

```bash
export NEMOCLAW_DISABLE_TELEMETRY=1                        # NemoClaw sends telemetry unless this is set
NEMOCLAW_INSTALL_REF= NEMOCLAW_INSTALL_TAG=v0.0.143 \
  NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_AGENT=openclaw NEMOCLAW_PROVIDER=build \
  NEMOCLAW_POLICY_TIER=restricted NEMOCLAW_SANDBOX_NAME=my-agent \
  bash nemoclaw.sh
```

The installer puts `openshell` in `~/.local/bin` and prints the `export PATH=…` line to add to your shell profile. With the Restricted tier it also prints "Restricted tier suppresses agent-required preset(s): openclaw-pricing, openclaw-diagnostics-otel-local"; that is expected.

`NEMOCLAW_DISABLE_TELEMETRY=1` turns off NemoClaw's telemetry only. The OpenShell gateway has its own telemetry, on by default, which OpenShell turns off with `OPENSHELL_TELEMETRY_ENABLED=false` on the gateway deployment. This guide has no verified way to set that on the gateway NemoClaw starts.

Check the versions: `nemoclaw --version`, `openshell --version` and `nemoclaw my-agent exec -- openclaw --version`. Save the current policy so you can compare later: `nemoclaw my-agent policy get > policy-before.yaml`.

## 2. Create the agent and connections in Guardian

In the Guardian console:

1. **Agents → New agent → Create agent.** Copy its credential (`gak_…`). It is shown once. Keep it out of chat, files and shell history.
2. On the agent's page, **Set up for Claude Code.** It creates (or reuses) two connections and allows `shell`, `file_write`, `web_fetch`, `shell_deploy`, `shell_destructive`, `git_push` and `shell_session`:
   - "Coding agent — everyday", set to **Allow**;
   - "Coding agent — needs approval", set to **Ask**.
3. Copy both `pcn_…` ids.

Everyday tools (such as `ls`) go to the everyday connection; risky ones (deploys, destructive commands, pushes, messages, MCP tools) go to the needs-approval connection. If the agent uses `openclaw.<tool>` or `mcp.<server>.<tool>` names, add them to "Coding agent — needs approval" with **Add tools** and allow each with **Allow a tool by name**; until then those calls are denied. The full mapping is in the [plugin README](../../packages/openclaw#which-guardian-tool-each-call-becomes).

## 3. Give OpenShell the credential (not the sandbox)

On the host, import the provider profile:

```bash
openshell provider profile lint   -f guardian-api-profile.yaml     # "Provider profile lint passed."
openshell provider profile import -f guardian-api-profile.yaml     # "Imported 1 provider profile."
```

Then enter the agent credential. Run this line on its own, then paste the `gak_…` credential at the prompt and press Enter (it is not echoed):

```bash
read -rs GUARDIAN_AGENT_CREDENTIAL; export GUARDIAN_AGENT_CREDENTIAL
```

Then register it with NemoClaw and rebuild the sandbox, so the provider is attached when the sandbox is created:

```bash
nemoclaw credentials add guardian --type guardian-api --credential GUARDIAN_AGENT_CREDENTIAL
unset GUARDIAN_AGENT_CREDENTIAL
nemoclaw my-agent rebuild --yes
openshell sandbox provider list my-agent                           # must list: guardian  guardian-api
```

`--credential NAME` reads the value from your environment, so it never appears in the command line. `credentials add` prints "Registered provider 'guardian' with the OpenShell gateway… Rebuild each sandbox that should use 'guardian'".

The rebuild is slow: about 15 minutes on a 4 vCPU machine, about half of it at "OpenClaw restored-state Doctor … waiting for the exact maintenance receipt". It may also print "Obsolete sandbox image retirement skipped: authority-unproven". Do the rebuild before anything else in the sandbox.

Use `nemoclaw credentials add`, not `openshell provider create` with `openshell sandbox provider attach`: NemoClaw does not record a provider made that way, so its next rebuild drops it, and an attachment made after the Gateway started never reaches the running Gateway.

Inside the sandbox, the Gateway's `GUARDIAN_AGENT_CREDENTIAL` holds only a placeholder, `openshell:resolve:env:v<N>_GUARDIAN_AGENT_CREDENTIAL`. On requests to the Guardian host and paths in the profile, OpenShell's proxy puts the real value in place of the placeholder wherever it appears in the request line or headers: in any header, not only `Authorization` (the profile's `header_name` does not limit this), and in URL path segments and query parameters. It does not resolve the placeholder for any other host or path. Never put the credential in `openclaw.json`, a plugin directory, a `.env` file or an image.

## 4. Add the one egress rule

[`guardian-api.yaml`](guardian-api.yaml) allows one host (`guardian-api.odingard.com:443`; the verified run used `guardian-api-staging.odingard.com:443`), the four Guardian agent API calls the plugin makes (`POST /v1/agent/requests`, `POST /v1/agent/claims`, `POST /v1/agent/execute`, `GET /v1/agent/receipts/**`), and one binary, `/usr/local/bin/node`. Preview, then apply:

```bash
nemoclaw my-agent policy add --from-file ./guardian-api.yaml --dry-run   # 1 host, 4 rules, 1 binary
nemoclaw my-agent policy add --from-file ./guardian-api.yaml --yes
```

Both print "Warning: custom preset targets are not vetted."; that is NemoClaw's notice for any custom preset. The rule takes effect in the running sandbox. That is the only change to the sandbox's network; everything else stays denied. Remove it with `nemoclaw my-agent policy remove guardian-api --yes`.

**Why `node`, and what it allows.** OpenShell sees the OpenClaw Gateway's requests as coming from `/usr/local/bin/node`, not `/usr/local/bin/openclaw`; a rule that names only `openclaw` is refused (`binary '/usr/local/bin/node' not allowed`). So:

- `curl` and other tools are refused, even for the Guardian host;
- **any Node.js process in the sandbox can reach the Guardian host on those four paths.** The credential placeholder is not a secret (its form is predictable, and processes the Gateway starts can inherit it), so such a process can send it, have OpenShell put the agent credential in its place, and propose actions as the agent or redeem approved ones;
- it **cannot approve anything**: approvals need a person in Guardian. That is the reach the agent already has through the Gateway.

When OpenShell's `providers_v2_enabled` setting is on (NemoClaw turns it on when it sets up the `build` provider), the provider also adds its own policy layer for the same host, from the profile. The profile names `/usr/local/bin/openclaw`, so that layer admits nothing on its own; the preset is the rule the Gateway uses.

## 5. Install the plugin

Fetch and check the package on the host, then copy it in. This needs no extra network access from the sandbox:

```bash
npm pack @odingard/guardian-openclaw@0.1.0 --json > pack.json
grep '"integrity"' pack.json     # must equal the integrity in the table above
nemoclaw my-agent upload ./odingard-guardian-openclaw-0.1.0.tgz /sandbox/guardian/
```

Install it from an interactive shell in the sandbox. OpenClaw asks you to confirm the source, and it only asks on a real terminal, so use `connect`, not `exec`:

```bash
nemoclaw my-agent connect
# inside the sandbox:
openclaw plugins install "npm-pack:/sandbox/guardian/odingard-guardian-openclaw-0.1.0.tgz"
```

OpenClaw prints `WARNING - Installing plugin from local npm-pack archive: …` and "This source is outside ClawHub review and trust metadata…", then asks `Install this non-ClawHub plugin source? [y/N]`. You checked the integrity above, so answer `y`. If OpenClaw also asks you to review the plugin's capabilities, read them and accept; the tested versions did not ask. Never pass `--force` or any other bypass flag: without a terminal OpenClaw cancels and suggests `--force`, and the fix is to run it inside `connect`.

**The first attempt asks for a device scope upgrade.** `plugins install` needs the `operator.admin` scope, which NemoClaw never approves automatically, so it stops with `gateway connect failed: GatewayClientRequestError: scope upgrade pending approval (requestId: …)`. Still inside `connect`:

```bash
openclaw devices list                    # find the pending request
openclaw devices approve <requestId>     # the id the install printed
openclaw plugins install "npm-pack:/sandbox/guardian/odingard-guardian-openclaw-0.1.0.tgz"
openclaw plugins enable guardian
```

Before approving, check that the pending entry is the one the install printed: a scope upgrade for the sandbox's own OpenClaw CLI device, adding only `operator.admin`. Anything else (another client, a node role, a second unexpected request): do not approve it. Approve by id, never with `--latest`. `approve` prints "Direct scope access failed; using local fallback." and then `Approved <deviceId> (<requestId>)`. The rerun prints `Installed plugin: guardian` and `Applied in Gateway generation …`, and `enable` prints `Enabled plugin "guardian".`

## 6. Configure it, then narrow the device

Set the keys from [`openclaw.json`](openclaw.json) with your two `pcn_…` ids:

```bash
nemoclaw my-agent exec -- openclaw config set plugins.entries.guardian.hooks.timeouts.before_tool_call 330000
nemoclaw my-agent exec -- openclaw config set plugins.entries.guardian.config.connectionId pcn_…everyday
nemoclaw my-agent exec -- openclaw config set plugins.entries.guardian.config.askConnectionId pcn_…needs-approval
nemoclaw my-agent exec -- openclaw config set plugins.entries.guardian.config.baseUrl https://guardian-api.odingard.com
nemoclaw my-agent exec -- openclaw config set plugins.entries.guardian.config.agentName my-nemoclaw-agent
nemoclaw my-agent exec -- openclaw config validate     # "Config valid: $OPENCLAW_HOME/.openclaw/openclaw.json"
```

Each `config set` prints "Change will apply without restarting the gateway." `hooks.timeouts.before_tool_call` must be 330000 ms: the 5-minute approval window plus time to redeem. Set `baseUrl` to the same host as the profile and the preset.

Then take the admin scope back from the CLI device, inside `nemoclaw my-agent connect`:

```bash
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write > /dev/null
openclaw devices list
```

The output goes to `/dev/null` because the reply can carry the replacement device token. Afterwards the Gateway log may show `[ws] unauthorized … reason=device_token_mismatch` (twice in the tested run). **Check `devices list`:** in the tested versions `rotate` succeeded but the list still showed `operator.admin` on the device. If yours does too, treat the CLI in the sandbox as still holding admin scope. That changes little here, because in opt-out mode the agent can switch Guardian off anyway (see [Before you start](#before-you-start-this-setup-is-not-tamper-proof)).

## 7. Turn on the plugin's opt-out mode

Read [Before you start](#before-you-start-this-setup-is-not-tamper-proof) first. Without this step, every tool call is blocked with "the install is not protected".

```bash
nemoclaw my-agent exec -- sh -c 'printf "GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL=1\n" >> /sandbox/.openclaw/.env'
```

OpenClaw loads `/sandbox/.openclaw/.env` from its state directory when the Gateway starts. The flag does not show in the Gateway's start-up environment; the check is the Gateway log after the next start (step 9).

**This departs from the plugin README's advice.** That README says to set the flag "only in a place the agent cannot write" ([Opting out](../../packages/openclaw#opting-out-not-tamper-proof)). `/sandbox/.openclaw/.env` is a place the agent can write, and NemoClaw offers no other place to set a Gateway environment variable. So the agent can edit this file, and whatever it leaves there is the Gateway's start-up environment at the next restart. And because the flag turns the install check off, the agent can switch Guardian off by changing the plugin or the OpenClaw config.

The plugin ignores `GUARDIAN_*` keys from a `.env` in the Gateway's working directory, so this works only while that directory is not `/sandbox/.openclaw`. In the tested versions it was `/sandbox`. Put nothing else in that file, and never the credential: a placeholder written there by hand would not resolve.

## 8. Stop and start the sandbox

```bash
nemoclaw my-agent stop && nemoclaw my-agent start
```

The start prints "Native agent gateway is still starting" for about 40 seconds, then "Probe complete…". A container start gives the Gateway a fresh environment from OpenShell, with the credential placeholder.

- **Plugin 0.1.0:** use stop then start, **not** `nemoclaw my-agent gateway restart`. NemoClaw restarts the Gateway in place with a copy of its environment, and 0.1.0 has removed the placeholder from it by then, so after an in-place restart the Gateway logs "Guardian plugin is not configured" and blocks every governed call. Make no OpenClaw change (`config set`, `plugins …`, `devices …`, `.env`) after the last start; if you must, stop and start again.
- **Plugin 0.1.1 (not verified with this guide):** it keeps the OpenShell placeholder in the Gateway's environment, so that the Gateway stays configured after an in-place restart. That has not been verified on NemoClaw; use stop then start with 0.1.1 too.

## 9. Check

```bash
nemoclaw my-agent exec -- openclaw plugins inspect guardian --runtime --json   # typedHooks includes before_tool_call; diagnostics []
nemoclaw my-agent exec -- tail -n 100 /sandbox/.openclaw/logs/gateway-persistent.log
```

With plugin 0.1.0, the log since the start should show exactly one line from the plugin:

> Guardian: GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL=1, so the install-integrity check is off. The agent can switch Guardian off by changing the plugin or the OpenClaw config; do not rely on this deployment as tamper-proof.

and no "Guardian plugin is not configured" or "the install is not protected". Plugin 0.1.1 also logs `Guardian: GUARDIAN_AGENT_CREDENTIAL is an OpenShell placeholder; kept in the Gateway environment so in-place restarts keep it.`, so with 0.1.1 expect two lines from the plugin.

## Try it

Create two scratch directories first. `exec` runs outside the agent, so this is not a governed call:

```bash
nemoclaw my-agent exec -- mkdir -p /sandbox/scratch/demo /sandbox/scratch/demo2
```

Then send the agent these messages, with `nemoclaw my-agent exec -- openclaw agent --agent main -m "…"` or in the TUI (`nemoclaw my-agent connect`, then `openclaw tui`):

| Message                                                                                                  | What you see                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Run exactly this shell command in your workspace, with no path argument: ls -la"                       | **Allowed; it runs.** `ls -la` is a `shell` call on the everyday connection. The Gateway log shows `Guardian: Run: ls -la — Allowed by Guardian policy (request req_…)`, the listing comes back, and the console's Activity page shows "Allowed by your permission", Completed.                                                                                                         |
| "Run: rm -rf /sandbox/scratch/demo"                                                                      | **Asks a person; runs once.** `shell_destructive` on the needs-approval connection. The Gateway log shows `"Run: rm -rf /sandbox/scratch/demo" is held for approval (request req_…). Approve it on your phone or in the console.` Approve it within 5 minutes. The log then shows `— Approved by a human in Guardian (request req_…)`; the command runs once and the directory is gone. |
| Set "Coding agent — needs approval" to **Off** in the console, then "Run: rm -rf /sandbox/scratch/demo2" | **Refused; no prompt.** The call is refused at once. Nothing appears on your phone, the directory is still there, and the Activity page shows "Denied by your permission". Plugin 0.1.0 writes no Gateway log line for a refusal. Set the connection back to Ask afterwards.                                                                                                            |

If a call waits for approval for about 2 minutes or more, the Gateway log shows `[diagnostic] stalled session: … classification=stalled_agent_run`, then again every 30 seconds. That is OpenClaw noticing the turn is waiting; it is not an error.

Approve in Guardian, not with OpenClaw's `/approve`. Guardian's decision is the only one that lets a governed call run.

### Tips

- **Paths under `/sandbox` go to Ask.** NemoClaw sets `OPENCLAW_HOME=/sandbox`, so the plugin treats that tree as OpenClaw's control plane: a shell command that names a path under `/sandbox` (outside `/sandbox/workspace*`) is `shell_destructive` and waits for a person. That includes the agent's own workspace, `/sandbox/.openclaw/workspace`, so `ls -la /sandbox` asks while `ls -la` with no path is allowed. In testing, other wordings of the Allow message (such as "List the files in your workspace") made the agent add a path under `/sandbox`, so the call went to Ask; the wording in the table is the one that gave a bare `ls -la`.
- **Ask for shell commands by name.** OpenClaw's own tools, such as its `ls` tool, reach Guardian as `openclaw.<tool>` names and are denied (`INVALID_REQUEST`) until you add them with **Add tools** and **Allow a tool by name**.
- **Each new request is decided on its own.** After an approved command runs, the agent may retry or check its own work with another command. That is a new request: it can go to your phone again, and you approve or deny it separately.
- **The agent's summary can be wrong.** For example, after a follow-up check is denied, the agent may report that the approved command was blocked, even though it ran. It may also call Guardian by another name. The Activity page and the receipt are the record.

### Watch the network and verify receipts

Watch the network side with `openshell logs my-agent --source sandbox`. A Guardian call shows lines like these (each line starts with a timestamp and `[sandbox] [OCSF ] [ocsf]`; the tested run showed the staging host):

```
NET:OPEN [INFO] ALLOWED /usr/local/bin/node(…) -> guardian-api.odingard.com:443 [policy:nemoclaw_custom__guardian-api__guardian_api engine:opa]
HTTP:POST [INFO] ALLOWED POST http://guardian-api.odingard.com:443/v1/agent/requests [policy:nemoclaw_custom__guardian-api__guardian_api engine:l7]
```

then a `POST …/v1/agent/claims` line every few seconds while a call waits for approval, and one `POST …/v1/agent/execute` line when an allowed or approved call is redeemed. A refused call shows only the `requests` line.

To check the sandbox is still closed:

```bash
nemoclaw my-agent exec -- curl -sS -m 10 https://example.com                              # CONNECT tunnel failed, response 403
nemoclaw my-agent exec -- curl -sS -m 10 https://guardian-api.odingard.com/v1/agent/requests  # 403: curl is not an allowed binary
nemoclaw my-agent exec -- node -e 'fetch("https://example.com").then(r=>console.log(r.status),()=>console.log("blocked"))'   # blocked
```

Each shows as a `DENIED` line in the OpenShell log.

Download a receipt from the console's Activity page and verify it with [`examples/verify-receipt.mjs`](../verify-receipt.mjs), from a checkout of this repository after `npm ci && npm run build`:

```bash
node examples/verify-receipt.mjs ./receipt.greceipt.json https://guardian-api.odingard.com
```

It fetches Guardian's published verification keys from that host, then checks the receipt's signature locally (`"valid":true`) and shows that a copy with one field changed fails (`SIGNATURE_INVALID`). Use the host your receipts came from: the verified run's receipts came from staging and were checked with `https://guardian-api-staging.odingard.com`. A refused call has a receipt too, with decision `DENY` and no execution.

## Messages you can ignore

- `(node:N) ExperimentalWarning: SQLite is an experimental feature…` on every `nemoclaw` command.
- `[proxy] routing process HTTP traffic through external proxy http://10.200.0.1:3128` inside the sandbox.
- "Blocked requests fail with 'CONNECT tunnel failed, response 403'" in the `connect` banner.
- "NemoClaw is attempting to enable OpenShell OCSF JSON audit logs … Set NEMOCLAW_NO_AUTO_AUDIT_LOGS=1 to opt out."
- "nemoclaw: recent network policy denial detected for <host>…" (turn off with `NEMOCLAW_NO_POLICY_HINT`).
- Repeated `DENIED /usr/local/bin/node -> telemetry.openclaw.ai:443` in the OpenShell log: the Restricted tier blocks OpenClaw's telemetry. Denial lines may carry a "SYMLINK HINT".
- A `/proc/self/oom_score_adj` permission warning in the sandbox shell.

## Troubleshooting

| You see                                                               | Likely cause and fix                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every call blocked: "the install is not protected"                    | The opt-out flag did not reach the plugin. Check the line in `/sandbox/.openclaw/.env` (step 7), then stop and start (step 8). If it is still blocked, the Gateway's working directory may be `/sandbox/.openclaw`, where the flag is ignored.                                    |
| "Guardian plugin is not configured"                                   | With 0.1.0, usually an in-place Gateway restart (`gateway restart`, or a config change that restarted it): stop and start. Otherwise the provider is missing: check `openshell sandbox provider list my-agent`; register it with `nemoclaw credentials add` and rebuild (step 3). |
| Calls blocked because Guardian is unreachable (`SERVICE_UNAVAILABLE`) | The sandbox cannot reach Guardian. Check `openshell logs my-agent --source sandbox` for a `DENIED` line for the Guardian host: a missing preset, or a binary the preset does not list (`binary '/usr/local/bin/node' not allowed` means the preset names a different binary).     |
| `credential_endpoint_mismatch` (HTTP 403) from the proxy              | The request went to a host or path the provider profile does not list. Use the same host in the profile, the preset and `baseUrl`.                                                                                                                                                |
| Calls denied as `INVALID_REQUEST`                                     | The tool is not on the connection or not allowed for the agent. Add it with **Add tools** and **Allow a tool by name** (step 2).                                                                                                                                                  |
| `scope upgrade pending approval (requestId: …)`                       | Expected on the first `plugins install`: approve that request by id (step 5).                                                                                                                                                                                                     |
| "Install cancelled; rerun with --force after reviewing the source"    | The install ran without a terminal. Run it inside `nemoclaw my-agent connect` and answer the prompt. Do not use `--force`.                                                                                                                                                        |
| An everyday command went to your phone                                | It names a path under `/sandbox` ([Tips](#tips)).                                                                                                                                                                                                                                 |
| An approval on the phone, but the call had already failed             | Something gave up before the 5-minute window: an OpenClaw turn or session timeout. Approve sooner, or check `hooks.timeouts.before_tool_call` is 330000.                                                                                                                          |

## Not covered yet

- Guardian production (`guardian-api.odingard.com`): the verified run used Guardian staging. The production host in these files, and verifying receipts with production's keys, were not run.
- Plugin 0.1.1, including an in-place Gateway restart with it (use stop then start).
- Narrowing the CLI device's scope (step 6): not shown to take effect.
- An approval held for most of the 5-minute window: approvals were given within seconds, so a long wait cut short by an OpenClaw or NemoClaw timeout has not been ruled out.
- Turning off the OpenShell gateway's own telemetry.
- Agents other than OpenClaw. NemoClaw's LangChain agent is LangChain Deep Agents Code, which `@odingard/guardian-langchain` and the Python SDK do not plug into. Hermes in NemoClaw has not been tried.

## What is not governed

Everything in the plugin's [What is not governed](../../packages/openclaw#what-is-not-governed) applies, plus, because of the opt-out mode, the agent can remove Guardian (see [Before you start](#before-you-start-this-setup-is-not-tamper-proof)). In short:

- **Read-only tools** (`read`, `web_search` and the others in the plugin README) are not sent to Guardian.
- **Things OpenClaw does without a tool call**, such as scheduled jobs and channel replies, are not seen.
- **Anything outside OpenClaw's tool calls**: other processes in the sandbox (including Node.js processes that use the agent credential, step 4), and NemoClaw or OpenShell themselves.
- **Exfiltration through everyday tools**: everyday commands run without a person. NemoClaw's network policy still limits outbound traffic to the hosts it lists (its baseline plus the Guardian rule), from the binaries it names.

NVIDIA NemoClaw and NVIDIA OpenShell are open-source projects. This is an independent guide from Odingard.
