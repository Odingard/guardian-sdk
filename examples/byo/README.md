# Your own container (CrewAI, LangGraph, AutoGen), governed by Guardian

**Status: LIVE recipes, tested locally against a real Guardian, not yet proven
with a framework.** A scripted container (serving `/health` and `/chat`, one
`guardian-mcp proxy` session kept open) ran allow, ask then approve or deny and
deny calls against the real Guardian server code, with receipts verified
offline; with Guardian unreachable or no credential nothing was forwarded,
and a claim sent to a fresh MCP process ran nothing. Each recipe
below still needs a real Guardian agent, a real model key and the framework
installed; none has run end to end with a framework yet. The framework
APIs below were checked against the released source: `crewai` /
`crewai-tools` 1.15.36, `langchain-mcp-adapters` 0.3.2 and `autogen-ext` 0.7.5
(PyPI, 2026-11-06).

A bring-your-own agent container often only has to serve `GET /health` and
`POST /chat` on `$PORT`. All tool calling happens inside the framework you
ship, so Guardian goes where that framework calls tools. There are two ways in:

1. **MCP tools: `guardian-mcp proxy`.** Change the MCP server's command to
   `guardian-mcp proxy -- <original command>`, or for a remote server
   (such as Composio) to `guardian-mcp proxy --url <url> --header
'Authorization: Bearer ${KEY}'`. Every `tools/call` is decided by Guardian
   first.
2. **Your own Python functions: `odingard-guardian`'s `Guard`.** Wrap the
   function that performs the action with `@guard("tool_name")` and register it
   with the framework as usual. See the
   [Python SDK framework recipes](../../packages/python/README.md#framework-recipes).
   In TypeScript use `createGuard` from `@odingard/guardian-sdk`, or
   [`@odingard/guardian-langchain`](../../packages/langchain) for LangChain.js
   and LangGraph.js.

guardian-mcp needs Node.js 22 or later in the container (`npm i -g
@odingard/guardian-mcp`). `--url` (remote MCP servers) ships in guardian-mcp
0.3.3 and later.

## Keep one MCP session open

When Guardian answers ASK, guardian-mcp holds the exact call in its own
process and returns a `requestId`. After a person approves, the model calls
`guardian_claim` with that id **on the same guardian-mcp process**, and the
held call runs once. If the framework starts a new MCP server process for every
tool call, the claim reaches a fresh process that holds nothing. Nothing runs
(fail closed), but the approved call cannot complete either. Allow and deny
still work. So keep one session open:

| Framework | Starts a new process per tool call                                                                                             | Keeps one session (use this)                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| CrewAI    | `Agent(mcps=[MCPServerStdio(...)])`: "A fresh `MCPClient` is created for every invocation" (`crewai/tools/mcp_native_tool.py`) | `crewai_tools.MCPServerAdapter(...)` as a context manager                  |
| LangGraph | `MultiServerMCPClient(...).get_tools()`: a new `ClientSession` per tool call (the library's README says so)                    | `async with client.session("name") as s: tools = await load_mcp_tools(s)`  |
| AutoGen   | `mcp_server_tools(params)` with no `session=` (each adapter opens its own session per call, `autogen_ext/tools/mcp/_base.py`)  | `async with McpWorkbench(params) as wb: AssistantAgent(..., workbench=wb)` |

ASK returns at once, so a host's short `/chat` reply limit (often about 30
seconds) is not hit. The
model, or your `/chat` handler on the next message, calls `guardian_claim`
later.

## Settings

Every recipe hands these to guardian-mcp's MCP entry and not to the agent's
MCP view. They are still in the agent process's own environment, so any
ungoverned code or tool in that container can read them, and with the
upstream key call the remote server directly. Keep the container to the
governed MCP tools only, or start guardian-mcp from a separate user or
container that holds the keys.

```text
GUARDIAN_BASE_URL=https://guardian-api.odingard.com
GUARDIAN_AGENT_CREDENTIAL=gak_…      # from the Guardian console, per agent
GUARDIAN_CONNECTION_ID=pcn_…
```

guardian-mcp never passes `GUARDIAN_*` to the upstream server and refuses to
expand one into a `--header`. Give the stdio entry `PATH` too, or use absolute
paths: some MCP clients start the server with a reduced environment.

## CrewAI

```python
import os
from mcp import StdioServerParameters
from crewai import Agent
from crewai_tools import MCPServerAdapter

guardian_env = {k: os.environ[k] for k in (
    "PATH", "GUARDIAN_BASE_URL", "GUARDIAN_AGENT_CREDENTIAL", "GUARDIAN_CONNECTION_ID",
    "REMOTE_MCP_API_KEY",
)}
remote = StdioServerParameters(
    command="guardian-mcp",
    args=["proxy", "--url", os.environ["REMOTE_MCP_URL"],
          "--header", "Authorization: Bearer ${REMOTE_MCP_API_KEY}"],
    env=guardian_env,
)

with MCPServerAdapter(remote) as tools:   # one guardian-mcp process for the crew
    agent = Agent(role="Operator", goal="…", backstory="…", tools=tools)
    ...  # build the crew and kickoff() inside the with-block
```

CrewAI's MCP adapter mostly passes on the text part of a tool result, so
screenshots that a computer-use tool returns may not reach the model. That is CrewAI's behaviour with or without Guardian.

## LangGraph (LangChain v1)

```python
import os
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain.agents import create_agent

client = MultiServerMCPClient({
    "composio": {
        "transport": "stdio",
        "command": "guardian-mcp",
        "args": ["proxy", "--url", os.environ["COMPOSIO_MCP_URL"],
                 "--header", "x-api-key: ${COMPOSIO_API_KEY}"],
        "env": {k: os.environ[k] for k in (
            "PATH", "GUARDIAN_BASE_URL", "GUARDIAN_AGENT_CREDENTIAL",
            "GUARDIAN_CONNECTION_ID", "COMPOSIO_API_KEY",
        )},
    },
})

async with client.session("composio") as session:   # one guardian-mcp process
    tools = await load_mcp_tools(session)
    agent = create_agent(os.environ["MODEL"], tools)   # "provider:model"
    ...
```

The adapters package says MCP support is moving into `langchain.mcp`; the
recipe above uses the released `langchain-mcp-adapters` 0.3.2 API.

## AutoGen

```python
import os
from autogen_agentchat.agents import AssistantAgent
from autogen_ext.tools.mcp import McpWorkbench, StdioServerParams

params = StdioServerParams(
    command="guardian-mcp",
    args=["proxy", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/data"],
    env={k: os.environ[k] for k in (
        "PATH", "GUARDIAN_BASE_URL", "GUARDIAN_AGENT_CREDENTIAL", "GUARDIAN_CONNECTION_ID",
    )},
    read_timeout_seconds=30,
)

async with McpWorkbench(params) as workbench:   # one guardian-mcp process
    agent = AssistantAgent("operator", model_client=model_client, workbench=workbench)
    ...
```

## What is governed and what is not

- **Governed:** every call to an MCP tool that reaches the framework through
  guardian-mcp, and every function you wrapped with `Guard` / `createGuard`.
- **Not governed:** anything else the container can do. That includes tools
  you registered without a guard, MCP servers connected directly (including a
  framework's own HTTP or SSE MCP client pointed straight at a remote
  server), plain code in your `/chat` handler, and hosted MCP
  connectors where the model provider calls the server for you (OpenAI
  Responses `mcp` tool, Anthropic's MCP connector). Those never pass through
  your container, so Guardian cannot see them.
- guardian-mcp is **decision-gated**: an allowed call runs upstream before the
  capability is redeemed. A refusal at redemption is reported as an incident,
  never as success.
- Held calls live in the guardian-mcp process. A container restart, or a
  host snapshot/resume that restarts it, drops them, and nothing runs.
- Hosted Guardian decides per tool today; it does not yet apply rules to
  argument values such as amounts.

Claude Agent SDK containers are covered separately by
[`@odingard/guardian-hook/agent-sdk`](../hosted-claude-code).
