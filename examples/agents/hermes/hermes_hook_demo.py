"""hermes_hook_demo.py: the Guardian pre_tool_call hook deciding Hermes tool calls.

    terminal: ls -la                      → ALLOW: Hermes runs it, receipt recorded
    terminal: terraform apply             → ASK:   held until a person approves
    terminal: rm -rf ~/project            → DENY:  blocked, Hermes never runs it
    read_file                             → not routed (read-only)

Run:  pip install odingard-guardian && python hermes_hook_demo.py

This calls the exact callback Hermes registers (odingard_guardian.hermes),
with the payload Hermes passes it. Hermes itself is NOT running here, so the
tool calls are [SIMULATED hermes]. Guardian is labelled too:

* no env vars: [SIMULATED guardian], a local demo policy, not Guardian;
* GUARDIAN_AGENT_CREDENTIAL, GUARDIAN_CONNECTION_ID and
  GUARDIAN_HOOK_ASK_CONNECTION_ID set: [LIVE guardian]. Your console decides,
  and the ASK waits for a real person (up to 2 minutes).

For the real thing (LIVE hermes + LIVE guardian) see README.md in this folder.
"""

import os
import secrets

from odingard_guardian import ExecuteResult, RequestResult
from odingard_guardian.hermes import PendingStore, governed_call, make_pre_tool_call


class DemoGuardian:
    """LOCAL demo policy, NOT Guardian: shell runs, deploys ask, destructive denies."""

    def request(self, invocation):
        rid = f"req_{secrets.token_hex(6)}"
        tool = invocation["tool_name"]
        if tool == "shell_destructive":
            return RequestResult(ok=True, request_id=rid, decision="DENY", reason_code="POLICY_DENY")
        if tool in ("shell_deploy", "git_push"):
            return RequestResult(ok=False, request_id=rid, reason_code="APPROVAL_REQUIRED")
        return RequestResult(ok=True, request_id=rid, decision="ALLOW", capability_token=f"gcap.demo.{rid}")

    def claim(self, request_id):  # demo: the person's approval is simulated
        print("    [SIMULATED guardian] a person approves the exact command…")
        return RequestResult(ok=True, request_id=request_id, decision="ALLOW", capability_token="gcap.demo")

    def execute(self, *, request_id, capability_token):
        return ExecuteResult(ok=True, receipt={"schemaVersion": 1, "requestId": request_id, "demo": True})


live = bool(os.environ.get("GUARDIAN_AGENT_CREDENTIAL"))
G = "[LIVE guardian]" if live else "[SIMULATED guardian]"
if live:
    hook = make_pre_tool_call(hook_timeout_s=130, log=lambda line: print(f"    {G} {line}"))
else:
    hook = make_pre_tool_call(
        {"GUARDIAN_CONNECTION_ID": "pcn_demo_everyday", "GUARDIAN_HOOK_ASK_CONNECTION_ID": "pcn_demo_approval"},
        client=DemoGuardian(),
        store=PendingStore(),
        hook_timeout_s=0,
        wait=lambda _s: None,
        log=lambda line: print(f"    {G} {line}"),
    )

for tool_name, args in [
    ("terminal", {"command": "ls -la"}),
    ("terminal", {"command": "terraform apply -auto-approve"}),
    ("terminal", {"command": "rm -rf ~/project"}),
    ("read_file", {"path": "README.md"}),
]:
    shown = args.get("command") or args.get("path")
    print(f"\n→ [SIMULATED hermes] {tool_name}: {shown}")
    directive = hook(tool_name=tool_name, args=args, task_id="demo", session_id="demo")
    if governed_call(tool_name, args) is None:
        print("  not routed through Guardian (read-only); Hermes' own rules apply")
    elif directive is None:
        print(f"  {G} no block → Hermes would run the tool now")
    else:
        print(f"  {G} block → Hermes returns this to the model instead of running the tool:")
        print(f"    {directive['message']}")
