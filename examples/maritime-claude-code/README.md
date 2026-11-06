# Claude Code on Maritime, governed by Guardian

[Maritime](https://maritime.sh) gives every agent its own persistent computer.
Guardian decides what the agent is allowed to do with it.

This example is a Claude Code agent (Claude Agent SDK) that speaks Maritime's
bring-your-own-agent contract (`GET /health`, `POST /chat` on `$PORT`,
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
    PreToolUse: [guardianHookMatcher({ agentName: "Maritime agent" })],
  },
};
```

## Set up Guardian

In the Guardian console, open **Agents → Set up for Claude Code**. It creates
the agent and its two connections: "Coding agent — everyday" (Allow) and
"Coding agent — needs approval" (Ask). Copy the agent credential and both
connection ids.

## Deploy on Maritime

Zip `Dockerfile`, `package.json` and `server.mjs`, then in the Maritime
dashboard choose **New agent → Upload a ZIP** (framework: custom). Add these
environment variables, marking the keys as secrets:

| Variable                          | Value                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`               | Your Claude API key. Use a key created inside a Console workspace.           |
| `GUARDIAN_AGENT_CREDENTIAL`       | From the Guardian console                                                    |
| `GUARDIAN_CONNECTION_ID`          | The "everyday" connection (`pcn_…`)                                          |
| `GUARDIAN_HOOK_ASK_CONNECTION_ID` | The "needs approval" connection (`pcn_…`)                                    |
| `IS_SANDBOX`                      | `1` (Maritime runs agents as root; Claude Code needs this to run unattended) |

Then chat with it:

```bash
maritime chat <agent> "List the files in your workspace, then run terraform apply -auto-approve in ./infra"
```

`ls` runs straight away. `terraform apply` is held: the reply says which
request is waiting, and the approval appears in the Guardian console. Approve
it there, message the agent again, and the answer comes back.

If configuration is missing, the agent says what to set and runs nothing.

## Approvals and Maritime's 30-second reply window

Maritime gives each reply about 30 seconds; a Guardian approval can take up to
5 minutes. The agent never cancels a request. If a reply is due while an
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
