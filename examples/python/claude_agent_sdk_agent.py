"""claude_agent_sdk_agent.py: Guardian deciding the tool calls of a Claude Agent SDK agent.

The agent's own tools go through the PreToolUse hook:

    Bash: npm test                         → ALLOW: the CLI runs it, receipt recorded
    Bash: terraform apply                  → ASK:   held until a person approves, then run
    Bash: rm -rf ~/project                 → DENY:  the CLI never runs it
    Read                                   → not routed (read-only)

A tool written in Python (@tool + create_sdk_mcp_server) goes through GuardianTools:

    refund_order $48                       → ALLOW: the handler runs, receipt recorded
    refund_order $12,400                   → ASK:   held; the same call runs after approval

From the repo root: pip install -e "./packages/python[claude-agent-sdk]"
                    python examples/python/claude_agent_sdk_agent.py

No account, no API key and no Claude Code CLI are needed, and labels say what is real:

* The SDK is real: ClaudeSDKClient, its control protocol, the hook registration
  and the SDK MCP server are claude-agent-sdk's own code.
* [SCRIPTED cli] stands in for the Claude Code CLI and the model. It is a custom
  Transport that asks for a fixed list of tool calls and treats each hook answer
  the way the CLI does. A LIVE RUN NEEDS THE CLAUDE CODE CLI (bundled with
  claude-agent-sdk) and an Anthropic login or API key: drop `transport=` below.
* [SIMULATED guardian] is a local demo policy, not Guardian. Set
  GUARDIAN_AGENT_CREDENTIAL, GUARDIAN_CONNECTION_ID and
  GUARDIAN_HOOK_ASK_CONNECTION_ID to send the same calls to hosted Guardian:
  then [LIVE guardian] is printed, your console decides, and an ASK waits for
  a real person (about 2 minutes at most). For the tool route, register
  `refund_order` as record-only on GUARDIAN_CONNECTION_ID first.
"""

import asyncio
import contextvars
import json
import os
import re
import secrets

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient, Transport, create_sdk_mcp_server, tool

from odingard_guardian import AsyncGuardianClient, DEFAULT_BASE_URL, ExecuteResult, RequestResult
from odingard_guardian.claude_agent_sdk import GuardianTools, guardian_hook_matcher


class DemoGuardian:
    """LOCAL demo policy, NOT Guardian: everyday calls run, deploys and big refunds ask, destructive denies."""

    def request(self, invocation):
        rid = f"req_{secrets.token_hex(6)}"
        name, args = invocation["tool_name"], invocation["arguments"]
        if name == "shell_destructive":
            return RequestResult(ok=True, request_id=rid, decision="DENY", reason_code="POLICY_DENY")
        if name in ("shell_deploy", "git_push") or args.get("amount_cents", 0) > 500_000:
            return RequestResult(ok=False, request_id=rid, reason_code="APPROVAL_REQUIRED")
        return RequestResult(ok=True, request_id=rid, decision="ALLOW", capability_token=f"gcap.demo.{rid}")

    def claim(self, request_id):  # demo: the person's approval is simulated
        print("    [SIMULATED guardian] a person approves the exact call…")
        return RequestResult(ok=True, request_id=request_id, decision="ALLOW", capability_token="gcap.demo")

    def execute(self, *, request_id, capability_token):
        return ExecuteResult(ok=True, receipt={"schemaVersion": 1, "requestId": request_id, "demo": True})


class AsyncDemoGuardian(AsyncGuardianClient):
    """The same demo policy for async callers (GuardianTools)."""

    def __init__(self, policy):
        self.policy = policy

    async def request(self, invocation):
        return self.policy.request(invocation)

    async def claim(self, request_id):
        return self.policy.claim(request_id)

    async def execute(self, *, request_id, capability_token):
        return self.policy.execute(request_id=request_id, capability_token=capability_token)


class ScriptedCLI(Transport):
    """[SCRIPTED cli] Stands in for the Claude Code CLI and the model. Not the CLI.

    It speaks the SDK's control protocol: for each scripted tool call it sends
    the registered PreToolUse hooks a `hook_callback` request, runs the tool
    only on "allow" (or, with no decision, under its own permissions), and
    calls an SDK MCP tool over `mcp_message`.
    """

    def __init__(self, calls, sdk_servers):
        self.calls, self.sdk_servers = calls, sdk_servers
        self.inbox, self.answers, self.closed, self.ids = asyncio.Queue(), {}, asyncio.Event(), 0

    async def connect(self):
        pass

    def is_ready(self):
        return True

    async def end_input(self):
        self.closed.set()

    async def close(self):
        self.closed.set()

    async def write(self, data):
        for line in filter(str.strip, data.splitlines()):
            message = json.loads(line)
            if message.get("type") == "control_response":
                self.answers.pop(message["response"]["request_id"]).set_result(message["response"])
            else:
                await self.inbox.put(message)

    def ask_sdk(self, body):
        self.ids += 1
        self.answers[f"cli_{self.ids}"] = answer = asyncio.get_running_loop().create_future()
        return {"type": "control_request", "request_id": f"cli_{self.ids}", "request": body}, answer

    async def read_messages(self):
        init = await self.inbox.get()  # the SDK's initialize request, with the hooks it registered
        yield {"type": "control_response", "response": {
            "subtype": "success", "request_id": init["request_id"],
            "response": {"commands": [], "hook_on_failure_supported": True}}}
        await self.inbox.get()  # the user's prompt
        matchers = (init["request"].get("hooks") or {}).get("PreToolUse", [])
        for index, (name, tool_input) in enumerate(self.calls):
            print(f"\n→ {name} {json.dumps(tool_input)}")
            decision, reason = None, ""
            for callback_id in [cb for m in matchers for cb in m["hookCallbackIds"]]:
                frame, answer = self.ask_sdk({
                    "subtype": "hook_callback", "callback_id": callback_id, "tool_use_id": f"toolu_{index}",
                    "input": {"hook_event_name": "PreToolUse", "tool_name": name, "tool_input": tool_input,
                              "tool_use_id": f"toolu_{index}", "session_id": "demo", "cwd": os.getcwd(),
                              "transcript_path": ""}})
                yield frame
                output = (await answer).get("response") or {}
                specific = output.get("hookSpecificOutput") or {}
                decision = specific.get("permissionDecision", decision)
                reason = specific.get("permissionDecisionReason", reason)
            if decision == "deny":
                print(f"  [SCRIPTED cli] hook said deny → not run. {reason}")
                continue
            how = f"hook said allow ({reason})" if decision == "allow" else "no hook opinion (its own permissions)"
            server = re.match(r"^mcp__(.+?)__(.+)$", name)
            if server and server.group(1) in self.sdk_servers:
                for message in (
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                        "protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": {"name": "scripted-cli", "version": "0"}}},
                    {"jsonrpc": "2.0", "method": "notifications/initialized"},
                    {"jsonrpc": "2.0", "id": 10 + index, "method": "tools/call",
                     "params": {"name": server.group(2), "arguments": tool_input}},
                ):
                    frame, answer = self.ask_sdk(
                        {"subtype": "mcp_message", "server_name": server.group(1), "message": message})
                    yield frame
                    response = await answer
                result = response["response"]["mcp_response"]["result"]
                text = " ".join(part.get("text", "") for part in result["content"])
                print(f"  [SCRIPTED cli] {how} → tool result{' (error)' if result.get('isError') else ''}: {text}")
            else:
                print(f"  [SCRIPTED cli] {how} → [SIMULATED tool] ran")
        yield {"type": "assistant", "parent_tool_use_id": None, "session_id": "demo",
               "message": {"role": "assistant", "model": "scripted", "content": [{"type": "text", "text": "done"}]}}
        yield {"type": "result", "subtype": "success", "duration_ms": 1, "duration_api_ms": 1, "is_error": False,
               "num_turns": 1, "session_id": "demo", "result": "done"}
        await self.closed.wait()


# The session a tool call belongs to. Your app sets it (here, before the client
# connects); the model cannot write it. GuardianTools reads it through `scope`, so
# a held refund is claimed only by the same call in the same session.
SESSION = contextvars.ContextVar("session", default=None)


@tool("refund_order", "Refund an order", {"order_id": str, "amount_cents": int})
async def refund_order(args):
    # Your code. Guardian only lets it run after ALLOW or a person's approval.
    return {"content": [{"type": "text", "text": f"[SIMULATED refund] {args['order_id']} refunded"}]}


async def main():
    credential = os.environ.get("GUARDIAN_AGENT_CREDENTIAL")
    live = bool(credential)
    G = "[LIVE guardian]" if live else "[SIMULATED guardian]"
    log = lambda line: print(f"    {G} {line}")  # noqa: E731

    if live:
        # Route 2 (your own tools): Guard needs an async client. mode="remote"
        # would have Guardian make the call instead of the handler.
        tools = GuardianTools(
            AsyncGuardianClient(credential=credential, base_url=os.environ.get("GUARDIAN_BASE_URL", DEFAULT_BASE_URL)),
            connection_id=os.environ["GUARDIAN_CONNECTION_ID"],
            agent_name="Claude agent",
            scope=lambda _tool: SESSION.get(),
        )
        # Route 1 (the agent's own tools): the hook reads its settings from the
        # environment and moves the credential out of it.
        matcher = guardian_hook_matcher(skip_mcp_servers=["billing"], log=log)
    else:
        policy = DemoGuardian()
        tools = GuardianTools(AsyncDemoGuardian(policy), connection_id="pcn_demo_tools", agent_name="Claude agent",
                              scope=lambda _tool: SESSION.get())
        matcher = guardian_hook_matcher(
            {"GUARDIAN_CONNECTION_ID": "pcn_demo_everyday", "GUARDIAN_HOOK_ASK_CONNECTION_ID": "pcn_demo_approval"},
            client=policy,
            skip_mcp_servers=["billing"],
            wait=lambda _seconds: None,  # demo: do not really wait for the simulated person
            log=log,
        )

    options = ClaudeAgentOptions(
        hooks={"PreToolUse": [matcher]},
        mcp_servers={"billing": create_sdk_mcp_server("billing", tools=[tools.wrap(refund_order)])},
    )
    big_refund = ("mcp__billing__refund_order", {"order_id": "A-2002", "amount_cents": 1_240_000})
    cli = ScriptedCLI(
        [
            ("Bash", {"command": "npm test"}),
            ("Bash", {"command": "terraform apply -auto-approve"}),
            ("Bash", {"command": "rm -rf ~/project"}),
            ("Read", {"file_path": "/work/README.md"}),
            ("mcp__billing__refund_order", {"order_id": "A-1001", "amount_cents": 4_800}),
            big_refund,  # ASK: held, the handler does not run
            big_refund,  # the same call again, after approval: runs the approved request
        ],
        sdk_servers={"billing"},
    )
    SESSION.set("demo-session")  # in an app: the signed-in user or the conversation
    print(f"{G} deciding; [SCRIPTED cli] in place of the Claude Code CLI and the model")
    async with ClaudeSDKClient(options=options, transport=cli) as client:  # live agent: no transport=
        await client.query("Run the tests, deploy staging, clean up, then refund the two orders")
        async for _message in client.receive_response():
            pass


asyncio.run(main())
