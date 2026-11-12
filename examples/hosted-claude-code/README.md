# Claude Code in a hosted agent VM, governed by Guardian

Some hosts give every agent its own persistent computer. Guardian decides
what the agent is allowed to do with it.

This example is a Claude Code agent (Claude Agent SDK) that speaks a small
bring-your-own-agent HTTP contract (`GET /health`, `POST /chat` on `$PORT`,
state under `/data`). Claude Code runs unattended inside the VM with
`permissionMode: "bypassPermissions"`. Guardian's PreToolUse hook still runs on
every tool call, and its deny holds in that mode:

- everyday commands (`ls`, `npm test`, reading files) run;
- deploys, destructive commands and pushes (`terraform apply`, `rm -rf`,
  `git push`) wait until a person approves that exact action;
- anything Guardian denies, or that nobody approves in time, does not run;
- every allowed call leaves a receipt you can verify offline.

The Guardian part is one line in the Agent SDK call:

```js
const options = {
  permissionMode: "bypassPermissions",
  hooks: {
    PreToolUse: [guardianHookMatcher({ agentName: "Hosted Claude Code agent" })],
  },
};
```

## Set up Guardian

In the Guardian console, first create the agent: **Agents → New agent**, then
**Create agent**. Copy its agent credential (`gak_…`); it is shown once.

Then, on the agent's page, open **Govern Claude Code with this agent** and press
**Set up for Claude Code**. It creates (or reuses) the two connections,
"Coding agent — everyday" (Allow: `shell`, `file_write`, `web_fetch`) and
"Coding agent — needs approval" (Ask: `shell_deploy`, `shell_destructive`,
`git_push`, `shell_session`), and allows those tools for the agent. It does not
create the agent or its credential. Copy both connection ids (`pcn_…`).

A tool must be on a connection before it can be allowed. MCP tool calls
(`mcp.<server>.<tool>`) are not added by the setup, so they are refused
(`INVALID_REQUEST`) until you add each one to "Coding agent — needs approval"
with **Add tools** on its card under **Connections**, then allow it by name on
the agent's page.

## Deploy

Build the image from `Dockerfile`, `package.json` and `server.mjs` (or upload
the three files, if your host builds custom agents for you). Add these
environment variables, marking the keys as secrets:

| Variable                          | Value                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`               | Your Claude API key. Use a key created inside a Console workspace.           |
| `GUARDIAN_AGENT_CREDENTIAL`       | From the Guardian console                                                    |
| `GUARDIAN_CONNECTION_ID`          | The "everyday" connection (`pcn_…`)                                          |
| `GUARDIAN_HOOK_ASK_CONNECTION_ID` | The "needs approval" connection (`pcn_…`)                                    |
| `IS_SANDBOX`                      | `1` if the host runs agents as root (Claude Code needs it to run unattended) |

Then chat with it:

```bash
curl -s "$AGENT_URL/chat" -H 'content-type: application/json' \
  -d '{"message":"List the files in your workspace, then run terraform apply -auto-approve in ./infra","conversation_id":"me"}'
```

`ls` runs straight away. `terraform apply` is held: the reply says which
request is waiting, and the approval appears in the Guardian console. Approve
it there, message the agent again, and the answer comes back.

If configuration is missing, the agent says what to set and runs nothing.

## Approvals and a short reply window

Some hosts give each reply only about 30 seconds; a Guardian approval can take
up to 5 minutes. This agent answers within `REPLY_BUDGET_MS` (default 24000). The agent never cancels a request. If a reply is due while an
action is held, it answers with what it is waiting for, and the finished
result is delivered as the reply to your next message in that conversation.

## Run it locally

```bash
npm install
IS_SANDBOX=1 ANTHROPIC_API_KEY=... GUARDIAN_AGENT_CREDENTIAL=... \
GUARDIAN_CONNECTION_ID=pcn_... GUARDIAN_HOOK_ASK_CONNECTION_ID=pcn_... \
npm start
curl -s localhost:8080/chat -H 'content-type: application/json' \
  -d '{"message":"What files are in your workspace?","conversation_id":"me"}'
```
