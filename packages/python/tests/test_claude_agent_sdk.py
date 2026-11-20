"""Claude Agent SDK: the PreToolUse hook and the SDK MCP tool wrapper.

No network and no Claude Code CLI. The hook callback is called with the
SDK's own input type, and the SDK's real control protocol (``Query`` behind
``ClaudeSDKClient`` and ``query()``) is driven by a scripted CLI on a custom
``Transport``: it sends ``hook_callback`` and ``mcp_message`` control
requests and acts on the answers the way the CLI does. Guardian is a fake.
"""

import asyncio
import json
import os
import re
import time
import typing

import pytest

sdk = pytest.importorskip("claude_agent_sdk")

from claude_agent_sdk import (  # noqa: E402
    ClaudeAgentOptions,
    ClaudeSDKClient,
    CLIConnectionError,
    HookMatcher,
    ResultMessage,
    Transport,
    create_sdk_mcp_server,
    query,
    tool,
)
from claude_agent_sdk.types import (  # noqa: E402
    PreToolUseHookInput,
    PreToolUseHookSpecificOutput,
    SyncHookJSONOutput,
)

from odingard_guardian import ExecuteResult, ReceiptsResult, RequestResult  # noqa: E402
from odingard_guardian import claude_agent_sdk as cas  # noqa: E402
from odingard_guardian.claude_agent_sdk import (  # noqa: E402
    GUARDIAN_HOOK_TIMEOUT_S,
    GuardianTools,
    PendingStore,
    classify_command,
    connection_for,
    governed_call,
    guardian_hook_matcher,
    guardian_pre_tool_use,
    tier_of,
)

from test_guard import CONNECTION, AsyncFake, FakeClient  # noqa: E402
from test_guard import ALLOW as TOOL_ALLOW  # noqa: E402
from test_guard import HELD as TOOL_HELD  # noqa: E402
from test_hermes import ALLOW, DENY, EVERYDAY, APPROVAL, EXPIRED, HELD, PENDING, SECRET, Clock, FakeGuardian  # noqa: E402

ENV = {
    "GUARDIAN_AGENT_CREDENTIAL": SECRET,
    "GUARDIAN_CONNECTION_ID": EVERYDAY,
    "GUARDIAN_HOOK_ASK_CONNECTION_ID": APPROVAL,
}
APPROVED = RequestResult(ok=True, request_id="req_1", decision="ALLOW", capability_token="cap_1")
DECLINED = RequestResult(ok=False, request_id="req_1", reason_code="APPROVAL_DENIED")
UNREACHABLE = RequestResult(ok=False, reason_code="SERVICE_UNAVAILABLE")
WATCHED = RequestResult(ok=True, request_id="req_w", decision="DENY", reason_code="WATCHED", watched="ASK")


def hook_input(tool_name, tool_input, cwd="/work") -> PreToolUseHookInput:
    """The SDK's PreToolUse input, as the CLI sends it."""
    return PreToolUseHookInput(
        session_id="sess_1",
        transcript_path="/tmp/transcript.jsonl",
        cwd=cwd,
        permission_mode="default",
        hook_event_name="PreToolUse",
        tool_name=tool_name,
        tool_input=tool_input,
        tool_use_id="toolu_1",
    )


def bash(command):
    return hook_input("Bash", {"command": command, "description": "run it"})


def make_hook(client, clock=None, env=ENV, store=None, hook_timeout_s=GUARDIAN_HOOK_TIMEOUT_S, logs=None, **options):
    clock = clock or Clock()
    return guardian_pre_tool_use(
        dict(env),  # the hook moves the credential out of the mapping it is given
        client=client,
        store=store,
        hook_timeout_s=hook_timeout_s,
        wait=clock.wait,
        now=clock.now,
        wall=clock.wall,
        log=(logs.append if logs is not None else (lambda _l: None)),
        **options,
    )


def decision_of(output):
    """The permission decision, after checking the output is one the SDK's types allow."""
    assert set(output) <= set(SyncHookJSONOutput.__annotations__)
    specific = output.get("hookSpecificOutput")
    if specific is None:
        return None
    assert set(specific) <= set(PreToolUseHookSpecificOutput.__annotations__)
    assert specific["hookEventName"] == "PreToolUse"
    allowed = typing.get_args(typing.get_args(PreToolUseHookSpecificOutput.__annotations__["permissionDecision"])[0])
    assert specific["permissionDecision"] in allowed
    # Guardian holds an ASK itself, and the tool runs with the input that was decided on.
    assert specific["permissionDecision"] in ("allow", "deny")
    assert "updatedInput" not in specific
    assert isinstance(specific["permissionDecisionReason"], str)
    return specific["permissionDecision"]


def reason_of(output):
    return output["hookSpecificOutput"]["permissionDecisionReason"]


# --- the tool table --------------------------------------------------------------


@pytest.mark.parametrize(
    "command,tool",
    [
        ("ls -la && npm test", "shell"),
        ("terraform apply -auto-approve", "shell_deploy"),
        ("kubectl -n prod delete pod api-1", "shell_deploy"),
        ("npm publish", "shell_deploy"),
        ("rm -rf build", "shell_destructive"),
        ("git reset --hard HEAD~3", "shell_destructive"),
        ("git push --force origin main", "shell_destructive"),
        ("dd if=/dev/zero of=/dev/sda", "shell_destructive"),
        ("rsync -a --delete src/ dst/", "shell_destructive"),
        ("truncate -s 0 app.log", "shell_destructive"),
        ("git push origin main", "git_push"),
        ("echo '{}' > .mcp.json", "shell_destructive"),
        ("claude mcp add x && cat .claude/settings.json", "shell_destructive"),
        ("echo $GUARDIAN_AGENT_CREDENTIAL", "shell_destructive"),
        ("cat /proc/self/environ", "shell_destructive"),
    ],
)
def test_bash_is_routed_by_consequence(command, tool):
    assert classify_command(command) == tool
    call = governed_call("Bash", {"command": command}, cwd="/work")
    assert call.tool_name == tool
    assert call.arguments["command"] == command
    assert call.arguments["cwd"] == "/work"
    assert call.summary.startswith(f"Run: {command}")


def test_a_long_command_is_proposed_with_a_digest_of_all_of_it():
    one = governed_call("Bash", {"command": "echo " + "a" * 5000 + " one"})
    two = governed_call("Bash", {"command": "echo " + "a" * 5000 + " two"})
    assert len(one.arguments["command"]) < 2100
    assert one.arguments["commandDigest"].startswith("sha256:")
    assert one.arguments != two.arguments


def test_a_command_the_hook_cannot_read_goes_to_the_ask_tier():
    call = governed_call("Bash", {"command": {"argv": ["rm"]}})
    assert call.tool_name == "shell_destructive"
    assert call.arguments["input"] == {"command": {"argv": ["rm"]}}
    assert governed_call("Bash", {"command": ["git", "push"]}).tool_name == "git_push"


@pytest.mark.parametrize(
    "name,tool_input,verb",
    [
        ("Write", {"file_path": "/work/a.py", "content": "print(1)\n"}, "Write"),
        ("Edit", {"file_path": "/work/a.py", "old_string": "1", "new_string": "2"}, "Edit"),
        ("MultiEdit", {"file_path": "/work/a.py", "edits": [{"old_string": "1", "new_string": "2"}]}, "Edit"),
        ("NotebookEdit", {"notebook_path": "/work/n.ipynb", "new_source": "x = 1"}, "Edit"),
    ],
)
def test_file_tools_are_file_write_with_the_content_digested(name, tool_input, verb):
    call = governed_call(name, tool_input, cwd="/work")
    path = tool_input.get("file_path") or tool_input.get("notebook_path")
    assert call.tool_name == "file_write"
    assert call.arguments["operation"] == name
    assert call.arguments["path"] == path
    assert call.arguments["contentDigest"].startswith("sha256:")
    assert call.arguments["contentBytes"] > 0
    assert call.summary == f"{verb} {path}"
    # File contents are digested, never sent.
    assert "print(1)" not in json.dumps(call.arguments)


def test_an_edit_is_bound_to_its_whole_input_not_only_the_new_text():
    one = governed_call("Edit", {"file_path": "/w/a", "old_string": "x", "new_string": "z"})
    two = governed_call("Edit", {"file_path": "/w/a", "old_string": "y", "new_string": "z"})
    all_ = governed_call("Edit", {"file_path": "/w/a", "old_string": "x", "new_string": "z", "replace_all": True})
    assert one.arguments["contentDigest"] == two.arguments["contentDigest"]
    assert len({one.arguments["inputDigest"], two.arguments["inputDigest"], all_.arguments["inputDigest"]}) == 3


@pytest.mark.parametrize(
    "path",
    ["/work/.mcp.json", "/work/.claude/settings.json", "/home/u/.claude.json", "/work/.claude/hooks/pre.sh",
     "/work/.cursor/mcp.json"],
)
def test_writing_the_agents_own_configuration_needs_approval(path):
    call = governed_call("Write", {"file_path": path, "content": "{}"})
    assert call.tool_name == "shell_destructive"
    assert call.arguments["touches"] == "agent-config"
    assert tier_of(call.tool_name) == "ask"


@pytest.mark.parametrize(
    "path",
    [
        "/work/.claude//settings.json",
        "/work/.claude/./settings.json",
        "/work//.claude///settings.local.json",
        "/work/.claude/tmp/../settings.json",
        "/work/src/../.claude/x/../hooks/pre.sh",
        "/work/.CLAUDE//Settings.json",
        "/work/sub/..//.mcp.json",
        "/work/.claude\\\\settings.json",
        ".claude//settings.json",
        "./.claude/./settings.json",
        "~/.claude//settings.json",
    ],
)
def test_an_alias_of_an_agent_configuration_path_still_needs_approval(path):
    for name, tool_input in (
        ("Write", {"file_path": path, "content": "{}"}),
        ("Edit", {"file_path": path, "old_string": "a", "new_string": "b"}),
        ("MultiEdit", {"file_path": path, "edits": []}),
        ("NotebookEdit", {"notebook_path": path, "new_source": "x"}),
    ):
        call = governed_call(name, tool_input, cwd="/work")
        assert call.tool_name == "shell_destructive", (name, path)
        assert call.arguments["touches"] == "agent-config"
        assert call.arguments["path"] == path  # proposed as the agent wrote it


def test_a_symbolic_link_to_agent_configuration_still_needs_approval(tmp_path):
    work = tmp_path / "work"
    (work / ".claude").mkdir(parents=True)
    (work / ".claude" / "settings.json").write_text("{}")
    (work / "innocent.json").symlink_to(work / ".claude" / "settings.json")  # the file is a link
    (work / "notes").symlink_to(work / ".claude", target_is_directory=True)  # a folder on the way is a link
    for path in (str(work / "innocent.json"), str(work / "notes" / "settings.json"),
                 str(work / "notes" / "settings.local.json"), "notes/settings.json"):
        call = governed_call("Write", {"file_path": path, "content": "{}"}, cwd=str(work))
        assert call.tool_name == "shell_destructive", path
    plain = governed_call("Write", {"file_path": str(work / "a.json"), "content": "{}"}, cwd=str(work))
    assert plain.tool_name == "file_write"


def _file_calls(path):
    return (
        ("Write", {"file_path": path, "content": "{}"}),
        ("Edit", {"file_path": path, "old_string": "a", "new_string": "b"}),
        ("MultiEdit", {"file_path": path, "edits": []}),
        ("NotebookEdit", {"notebook_path": path, "new_source": "x"}),
    )


@pytest.fixture
def linked(tmp_path):
    """A project with folder links into ``.claude/hooks/x``."""
    proj = tmp_path / "proj"
    hooks = proj / ".claude" / "hooks"
    (hooks / "x").mkdir(parents=True)
    (proj / "t").mkdir()
    (proj / "d").symlink_to(hooks / "x", target_is_directory=True)
    (proj / "t" / "sub").symlink_to(hooks / "x", target_is_directory=True)

    def lands(path, expected):
        """The route first; then a write through the path shows which file it changes."""
        for name, tool_input in _file_calls(path):
            call = governed_call(name, tool_input, cwd=str(proj))
            assert call.tool_name == "shell_destructive", (name, path)
            assert call.arguments["touches"] == "agent-config"
            assert call.arguments["path"] == path
        assert not expected.exists()
        with open(path if os.path.isabs(path) else os.path.join(str(proj), path), "w") as handle:
            handle.write("written through the path")
        assert expected.read_text() == "written through the path"

    return proj, hooks, lands


def test_a_relative_link_target_is_taken_from_the_links_real_folder(linked):
    proj, _hooks, lands = linked
    # proj/d → .claude/hooks/x; proj/d/f → ../../settings.json (no such file yet).
    (proj / "d" / "f").symlink_to("../../settings.json")
    lands(str(proj / "d" / "f"), proj / ".claude" / "settings.json")


def test_a_chain_of_links_whose_targets_do_not_exist_yet(linked):
    proj, _hooks, lands = linked
    (proj / "d" / "f1").symlink_to("f2")
    (proj / "d" / "f2").symlink_to("../../settings.local.json")
    lands(str(proj / "d" / "f1"), proj / ".claude" / "settings.local.json")


def test_dot_dot_in_a_link_target_applies_after_the_folder_link_before_it(linked):
    proj, hooks, lands = linked
    # proj/t/sub → .claude/hooks/x, so sub/.. is .claude/hooks.
    (proj / "t" / "g").symlink_to("sub/../a.sh")
    lands(str(proj / "t" / "g"), hooks / "a.sh")
    (proj / "t" / "h").symlink_to(str(proj / "t" / "sub") + "/../b.sh")  # an absolute target
    lands(str(proj / "t" / "h"), hooks / "b.sh")


def test_dot_dot_after_a_link_in_the_written_path_absolute_and_relative(linked):
    proj, hooks, lands = linked
    lands(str(proj / "d") + "/../c.sh", hooks / "c.sh")
    lands("d/../e.sh", hooks / "e.sh")
    lands("./t/sub/../g.sh", hooks / "g.sh")


def test_a_link_to_a_link_each_relative_to_its_own_folder(linked):
    proj, hooks, lands = linked
    (proj / "d" / "k2").symlink_to("../k.sh")
    (proj / "k").symlink_to("d/k2")
    lands(str(proj / "k"), hooks / "k.sh")


def test_a_trailing_separator_on_a_link_whose_target_does_not_exist_yet(tmp_path):
    (tmp_path / "c").symlink_to(tmp_path / ".claude")
    for path in (str(tmp_path / "c") + "/", str(tmp_path / "c") + "//", "c/"):
        assert cas.is_agent_config_path(path, str(tmp_path)), path


@pytest.mark.skipif(os.name == "nt", reason="a backslash is a separator on Windows")
def test_a_link_whose_own_name_contains_a_backslash(linked):
    proj, _hooks, lands = linked
    # On POSIX a backslash is an ordinary character in a file name.
    (proj / "c\\d").symlink_to(proj / ".mcp.json")
    lands(str(proj / "c\\d"), proj / ".mcp.json")


def test_an_ordinary_file_reached_through_links_stays_on_file_write(linked):
    proj, _hooks, _lands = linked
    (proj / "src").mkdir()
    (proj / "s").symlink_to(proj / "src", target_is_directory=True)
    (proj / "s" / "n").symlink_to("../notes.txt")
    for path in (str(proj / "s" / "n"), "s/../src/a.py", "s/new.py", str(proj / "src") + "//b.py"):
        for name, tool_input in _file_calls(path):
            assert governed_call(name, tool_input, cwd=str(proj)).tool_name == "file_write", (name, path)


def test_a_path_that_cannot_be_resolved_goes_to_the_ask_tier():
    call = governed_call("Write", {"file_path": "/work/a\x00b.json", "content": "{}"}, cwd="/work")
    assert call.tool_name == "shell_destructive"


@pytest.mark.parametrize(
    "command",
    [
        "echo '{}' > .claude//settings.json",
        "cp x.json /work/.claude/./settings.json",
        "tee .claude/tmp/../settings.json < x",
        "cat x > '.claude//settings.local.json'",
        "cp x ./sub/..//.mcp.json",
    ],
)
def test_a_command_that_names_an_alias_of_agent_configuration_needs_approval(command):
    call = governed_call("Bash", {"command": command}, cwd="/work")
    assert call.tool_name == "shell_destructive"
    assert call.arguments["touches"] == "agent-config"


def test_skipping_an_mcp_server_never_skips_another_server_whose_name_starts_with_it():
    skip = ["billing"]
    assert governed_call("mcp__billing__refund", {}, skip_mcp_servers=skip) is None
    # Server "billing__shell", tool "run" (or server "billing", tool "shell__run"): not provably the skipped server.
    other = governed_call("mcp__billing__shell__run", {}, skip_mcp_servers=skip)
    assert other is not None and other.tool_name.startswith("mcp.")
    assert governed_call("mcp__billing_extra__run", {}, skip_mcp_servers=skip) is not None
    assert governed_call("mcp__billing____run", {}, skip_mcp_servers=skip) is not None
    # A skipped server whose own name has "__" is matched as a whole name.
    assert governed_call("mcp__my__srv__run", {}, skip_mcp_servers=["my__srv"]) is None
    assert governed_call("mcp__my__srv__run", {}, skip_mcp_servers=["my"]) is not None


async def test_through_the_sdk_a_lookalike_of_a_skipped_server_is_still_decided():
    guardian = FakeGuardian(DENY)
    cli = ScriptedCLI([("mcp__billing__shell__run", {"command": "rm -rf /"})])
    await run_agent(cli, hooked(guardian, skip_mcp_servers=["billing"]))
    assert cli.ran == []
    assert [i["tool_name"] for i in guardian.invocations] == ["mcp.billing.shell_run"]


@pytest.mark.parametrize("name", ["Read", "NotebookRead", "Grep", "Glob", "LS", "TodoWrite", "Task", "Skill"])
def test_read_only_and_unknown_tools_are_not_governed(name):
    assert governed_call(name, {"file_path": "/work/a.py", "pattern": "*"}) is None


def test_web_tools_are_web_fetch():
    fetch = governed_call("WebFetch", {"url": "https://example.com/a", "prompt": "summarize"})
    assert (fetch.tool_name, fetch.arguments) == ("web_fetch", {"url": "https://example.com/a"})
    search = governed_call("WebSearch", {"query": "guardian", "allowed_domains": ["example.com", 7]})
    assert search.tool_name == "web_fetch"
    assert search.arguments == {"query": "guardian", "allowedDomains": ["example.com"]}


def test_mcp_tools_are_named_by_server_and_tool():
    call = governed_call("mcp__GitHub__create_issue", {"title": "x"})
    assert call.tool_name == "mcp.github.create_issue"
    assert call.arguments == {"server": "GitHub", "tool": "create_issue", "input": {"title": "x"}}
    assert tier_of(call.tool_name) == "ask"
    big = governed_call("mcp__s__t", {"blob": "x" * 5000})
    assert "input" not in big.arguments and big.arguments["inputDigest"].startswith("sha256:")
    assert governed_call("mcp__billing__refund", {}, skip_mcp_servers=["billing"]) is None
    assert governed_call("mcp__other__refund", {}, skip_mcp_servers=["billing"]) is not None


def test_tiers_go_to_two_connections():
    assert connection_for("shell", ENV) == EVERYDAY
    assert connection_for("file_write", ENV) == EVERYDAY
    assert connection_for("shell_deploy", ENV) == APPROVAL
    assert connection_for("mcp.x.y", ENV) == APPROVAL
    assert connection_for("git_push", {"GUARDIAN_CONNECTION_ID": EVERYDAY}) == EVERYDAY
    assert {t["name"] for t in cas.CLAUDE_TOOLS} == {
        "shell", "shell_deploy", "shell_destructive", "git_push", "file_write", "web_fetch"}


# --- the hook callback, with the SDK's input and output types -------------------


async def test_allow_redeems_then_answers_allow():
    guardian = FakeGuardian(ALLOW)
    output = await make_hook(guardian)(bash("npm test"), "toolu_1", {"signal": None})
    assert decision_of(output) == "allow"
    assert "req_1" in reason_of(output)
    assert guardian.calls == ["request", "execute:req_1"]
    sent = guardian.invocations[0]
    assert sent["action"] == "tool.invoke"
    assert sent["connection_id"] == EVERYDAY
    assert sent["tool_name"] == "shell"
    assert sent["arguments"] == {"command": "npm test", "cwd": "/work"}
    assert sent["purpose"] == "Claude agent: Run: npm test"
    assert "watch_aware" not in sent


async def test_ask_tier_tools_go_to_the_approval_connection():
    guardian = FakeGuardian(ALLOW)
    await make_hook(guardian, agent_name="deploy-bot")(bash("terraform apply"), None, {"signal": None})
    assert guardian.invocations[0]["connection_id"] == APPROVAL
    assert guardian.invocations[0]["tool_name"] == "shell_deploy"
    assert guardian.invocations[0]["purpose"].startswith("deploy-bot: ")


async def test_ask_waits_for_the_person_then_redeems_and_allows():
    clock, logs = Clock(), []
    guardian = FakeGuardian(HELD, claims=[PENDING, PENDING, APPROVED], clock=clock)
    output = await make_hook(guardian, clock, logs=logs)(bash("terraform apply"), None, None)
    assert decision_of(output) == "allow"
    assert "Approved by a person" in reason_of(output)
    assert guardian.calls == ["request", "claim:req_1", "claim:req_1", "claim:req_1", "execute:req_1"]
    assert clock.t > 0 and "held for approval (request req_1)" in logs[0]


async def test_ask_not_approved_in_time_denies_and_the_same_call_later_claims_it():
    clock, store = Clock(), PendingStore()
    guardian = FakeGuardian(HELD, clock=clock)  # every claim: still pending
    # A matcher with the SDK's default 60 s timeout: the wait ends before it.
    hook = make_hook(guardian, clock, store=store, hook_timeout_s=60)
    first = await hook(bash("terraform apply"), None, None)
    assert decision_of(first) == "deny"
    assert "still waiting for a person" in reason_of(first) and "req_1" in reason_of(first)
    assert not any(c.startswith("execute") for c in guardian.calls)
    assert clock.t < 60

    # Approved meanwhile: the exact same call claims the open request. No new request.
    guardian.claims = [APPROVED]
    before = len(guardian.calls)
    again = await hook(bash("terraform apply"), None, None)
    assert decision_of(again) == "allow"
    assert guardian.calls[before:] == ["claim:req_1", "execute:req_1"]

    # A different call never picks up that approval.
    guardian.invoke, guardian.claims = HELD, [PENDING]
    other = await hook(bash("terraform destroy"), None, None)
    assert decision_of(other) == "deny"
    assert guardian.calls.count("request") == 2


async def test_ask_declined_or_expired_denies():
    for answer, code in ((DECLINED, "APPROVAL_DENIED"), (EXPIRED, "APPROVAL_EXPIRED")):
        guardian = FakeGuardian(HELD, claims=[PENDING, answer])
        output = await make_hook(guardian)(bash("git push"), None, None)
        assert decision_of(output) == "deny"
        assert code in reason_of(output)
        assert not any(c.startswith("execute") for c in guardian.calls)


async def test_deny_never_redeems():
    guardian = FakeGuardian(DENY)
    output = await make_hook(guardian)(bash("rm -rf /"), None, None)
    assert decision_of(output) == "deny"
    assert "POLICY_DENY" in reason_of(output)
    assert guardian.calls == ["request"]


@pytest.mark.parametrize("answer", [UNREACHABLE, ConnectionError("down")])
async def test_guardian_unreachable_fails_closed(answer):
    guardian = FakeGuardian(answer)
    output = await make_hook(guardian)(bash("ls"), None, None)
    assert decision_of(output) == "deny"
    assert "SERVICE_UNAVAILABLE" in reason_of(output)
    assert guardian.calls == ["request"]


async def test_a_refused_redemption_denies():
    guardian = FakeGuardian(ALLOW, execute_ok=False)
    output = await make_hook(guardian)(bash("ls"), None, None)
    assert decision_of(output) == "deny"
    assert "CAPABILITY_REVOKED" in reason_of(output)


@pytest.mark.parametrize(
    "lookup,decision,text",
    [
        (ReceiptsResult(ok=True, receipts=[{"state": "verified", "attemptId": "att_1"}]), "allow", "record shows"),
        (ReceiptsResult(ok=True, receipts=[{"state": "aborted"}]), "deny", "EXECUTION_NOT_SENT"),
        (ReceiptsResult(ok=True, receipts=[]), "deny", "EXECUTION_OUTCOME_UNKNOWN"),
        (ConnectionError("down"), "deny", "EXECUTION_OUTCOME_UNKNOWN"),
    ],
)
async def test_a_lost_redemption_answer_is_settled_by_guardians_record(lookup, decision, text):
    guardian = FakeGuardian(ALLOW, executed=ExecuteResult(ok=False, reason_code="HTTP_503"), lookup=lookup)
    output = await make_hook(guardian)(bash("ls"), None, None)
    assert decision_of(output) == decision
    assert text in reason_of(output)
    assert guardian.calls == ["request", "execute:req_1", "receipts:req_1"]


@pytest.mark.parametrize("tool_name", ["Read", "Grep", "Glob", "TodoWrite"])
async def test_read_only_tools_get_no_opinion_and_no_guardian_call(tool_name):
    guardian = FakeGuardian(DENY)
    output = await make_hook(guardian)(hook_input(tool_name, {"file_path": "/work/a.py"}), None, None)
    assert output == {}
    assert guardian.calls == []


async def test_other_hook_events_get_no_opinion():
    guardian = FakeGuardian(DENY)
    data = {**bash("rm -rf /"), "hook_event_name": "PostToolUse"}
    assert await make_hook(guardian)(data, None, None) == {}
    assert guardian.calls == []


@pytest.mark.parametrize(
    "env,text",
    [
        ({"GUARDIAN_CONNECTION_ID": EVERYDAY}, "GUARDIAN_AGENT_CREDENTIAL"),
        ({"GUARDIAN_AGENT_CREDENTIAL": SECRET}, "GUARDIAN_CONNECTION_ID"),
        ({**ENV, "GUARDIAN_BASE_URL": "http://guardian.internal"}, "must be https"),
    ],
)
async def test_missing_or_unsafe_configuration_denies(env, text):
    hook = guardian_pre_tool_use(dict(env), log=lambda _l: None)
    output = await hook(bash("ls"), None, None)
    assert decision_of(output) == "deny"
    assert text in reason_of(output)
    assert SECRET not in reason_of(output)


async def test_a_call_with_no_tool_name_or_no_input_denies():
    guardian = FakeGuardian(ALLOW)
    hook = make_hook(guardian)
    assert decision_of(await hook({"hook_event_name": "PreToolUse"}, None, None)) == "deny"
    assert decision_of(await hook(None, None, None)) == "deny"
    assert guardian.calls == []


async def test_a_crash_anywhere_in_the_hook_denies(monkeypatch):
    monkeypatch.setattr(cas, "governed_call", lambda *a, **k: 1 / 0)
    guardian = FakeGuardian(ALLOW)
    output = await make_hook(guardian)(bash("ls"), None, None)
    assert decision_of(output) == "deny"
    assert "ZeroDivisionError" in reason_of(output)
    assert guardian.calls == []


async def test_sensitive_file_settings_of_the_command_line_hook_are_refused_not_ignored():
    guardian = FakeGuardian(ALLOW)
    hook = make_hook(guardian, env={**ENV, "GUARDIAN_HOOK_SENSITIVE_MODE": "deny"})
    output = await hook(bash("ls"), None, None)
    assert decision_of(output) == "deny"
    assert "GUARDIAN_HOOK_SENSITIVE_MODE" in reason_of(output)
    assert guardian.calls == []


async def test_every_guardian_call_finishes_before_the_hooks_timeout():
    clock = Clock()
    guardian = FakeGuardian(HELD, clock=clock, latency={"request": 1.0, "claim": 7.9, "execute": 7.9},
                            claims=lambda t: APPROVED if t > 50 else PENDING)
    output = await make_hook(guardian, clock, hook_timeout_s=60)(bash("terraform apply"), None, None)
    # Whether it was approved in time or not, nothing is redeemed after the CLI gave up.
    assert all(finished <= 59.0 for _began, finished in guardian.executed)
    assert clock.t <= 59.0
    assert decision_of(output) in ("allow", "deny")


def test_the_hook_refuses_a_timeout_it_cannot_plan_for_and_an_async_client():
    with pytest.raises(ValueError):
        guardian_pre_tool_use(dict(ENV), hook_timeout_s=0)
    with pytest.raises(TypeError):
        guardian_pre_tool_use(dict(ENV), client=AsyncFake(FakeClient(TOOL_ALLOW)))


# --- content pins on Edit-type tools ---------------------------------------------


async def test_an_edit_pins_the_file_and_proposes_the_pin(tmp_path):
    target = tmp_path / "a.py"
    target.write_text("x = 1\n")
    guardian = FakeGuardian(ALLOW)
    edit = hook_input("Edit", {"file_path": str(target), "old_string": "1", "new_string": "2"})
    assert decision_of(await make_hook(guardian)(edit, None, None)) == "allow"
    (pin,) = guardian.invocations[0]["arguments"]["guardianContentPins"]
    assert pin["arg"] == "path" and pin["mode"] == "recheck" and pin["size"] == 6
    assert pin["sha256"].startswith("sha256:")
    assert guardian.invocations[0]["tool_name"] == "file_write"


async def test_a_file_changed_while_the_edit_was_held_is_refused_and_nothing_is_redeemed(tmp_path):
    target = tmp_path / "a.py"
    target.write_text("x = 1\n")
    clock = Clock()
    original_wait = clock.wait

    def wait_and_change(seconds):
        target.write_text("x = 999\n")  # changed between the proposal and the approval
        original_wait(seconds)

    clock.wait = wait_and_change
    guardian = FakeGuardian(HELD, claims=[APPROVED], clock=clock)
    edit = hook_input("MultiEdit", {"file_path": str(target), "edits": [{"old_string": "1", "new_string": "2"}]})
    output = await make_hook(guardian, clock)(edit, None, None)
    assert decision_of(output) == "deny"
    assert "CONTENT_CHANGED_SINCE_APPROVAL" in reason_of(output)
    assert not any(c.startswith("execute") for c in guardian.calls)


async def test_an_edit_of_a_new_file_pins_its_absence_and_a_write_is_not_pinned(tmp_path):
    guardian = FakeGuardian(ALLOW)
    hook = make_hook(guardian)
    new = hook_input("NotebookEdit", {"notebook_path": str(tmp_path / "new.ipynb"), "new_source": "x"})
    assert decision_of(await hook(new, None, None)) == "allow"
    assert guardian.invocations[0]["arguments"]["guardianContentPins"] == [
        {"arg": "path", "index": 0, "mode": "recheck", "absent": True}]
    write = hook_input("Write", {"file_path": str(tmp_path / "w.txt"), "content": "hello"})
    assert decision_of(await hook(write, None, None)) == "allow"
    assert "guardianContentPins" not in guardian.invocations[1]["arguments"]


async def test_an_edit_that_cannot_be_pinned_is_denied_before_anything_is_proposed(tmp_path):
    guardian = FakeGuardian(ALLOW)
    hook = make_hook(guardian)
    relative = hook_input("Edit", {"file_path": "a.py", "old_string": "1", "new_string": "2"})
    output = await hook(relative, None, None)
    assert decision_of(output) == "deny" and "CONTENT_PIN_INVALID_ARGUMENT" in reason_of(output)
    folder = hook_input("Edit", {"file_path": str(tmp_path), "old_string": "1", "new_string": "2"})
    assert decision_of(await hook(folder, None, None)) == "deny"
    assert guardian.calls == []


# --- watch mode (opt-in) ----------------------------------------------------------


async def test_watch_mode_leaves_a_watched_call_to_the_agents_own_permissions():
    guardian = FakeGuardian(WATCHED)
    hook = make_hook(guardian, env={**ENV, "GUARDIAN_HOOK_WATCH_MODE": "on"})
    output = await hook(bash("terraform apply"), None, None)
    assert decision_of(output) is None
    assert "would have held it" in output["systemMessage"] and "req_w" in output["systemMessage"]
    assert guardian.invocations[0]["watch_aware"] is True
    assert guardian.calls == ["request"]  # no capability, nothing to redeem


async def test_without_watch_mode_a_watched_answer_is_a_denial():
    guardian = FakeGuardian(WATCHED)
    output = await make_hook(guardian)(bash("terraform apply"), None, None)
    assert decision_of(output) == "deny"
    assert "watch_aware" not in guardian.invocations[0]
    assert guardian.calls == ["request"]


# --- the credential ---------------------------------------------------------------


async def test_the_credential_is_moved_out_of_the_environment_but_still_used(monkeypatch):
    made = []

    def client(**options):
        made.append(options)
        return FakeGuardian(ALLOW)

    monkeypatch.setattr(cas, "GuardianClient", client)
    env = dict(ENV)
    hook = guardian_pre_tool_use(env, log=lambda _l: None)
    assert "GUARDIAN_AGENT_CREDENTIAL" not in env  # gone before any CLI is started
    assert decision_of(await hook(bash("ls"), None, None)) == "allow"
    assert made[0]["credential"] == SECRET
    assert made[0]["base_url"].startswith("https://")


# --- registration ------------------------------------------------------------------


def test_the_matcher_covers_every_tool_fails_closed_and_outlasts_the_approval_window():
    matcher = guardian_hook_matcher(dict(ENV), client=FakeGuardian(ALLOW))
    assert isinstance(matcher, HookMatcher)
    assert matcher.matcher is None
    assert matcher.on_failure == "block"
    assert matcher.timeout == GUARDIAN_HOOK_TIMEOUT_S == 150.0
    assert len(matcher.hooks) == 1
    with pytest.raises(TypeError):
        guardian_hook_matcher(dict(ENV), hook_timeout_s=5)


# --- the SDK's real control protocol, with a scripted CLI ---------------------------


class ScriptedCLI(Transport):
    """Stands in for the Claude Code CLI on the SDK's control protocol.

    After the SDK's ``initialize``, each user message makes it "call" the
    scripted tools in turn. For each one it sends the registered PreToolUse
    hooks a ``hook_callback`` control request and acts on the answer the way
    the CLI does: ``allow`` runs the tool, ``deny`` does not, no decision
    falls back to ``own_permission``. A hook that errors, or outlives
    ``hook_timeout``, blocks when its matcher says ``onFailure: "block"``.
    An allowed tool of an SDK MCP server is called over ``mcp_message``.
    """

    def __init__(self, calls, *, own_permission="allow", on_failure_supported=True, hook_timeout=None,
                 sdk_servers=()):
        self.script = list(calls)
        self.own_permission = own_permission
        self.on_failure_supported = on_failure_supported
        self.hook_timeout = hook_timeout
        self.sdk_servers = set(sdk_servers)
        self.initialize = None
        self.ran = []  # (tool name, input) the CLI ran itself
        self.results = []  # (tool name, what the model is told)
        self.hook_outputs = []
        self.cancelled = []
        self._inbox = asyncio.Queue()
        self._answers = {}
        self._closed = asyncio.Event()
        self._ids = 0

    async def connect(self):
        return None

    def is_ready(self):
        return True

    async def end_input(self):
        self._closed.set()  # stdin closed: the CLI exits, and its output ends

    async def close(self):
        self._closed.set()

    async def write(self, data):
        for line in data.splitlines():
            if not line.strip():
                continue
            message = json.loads(line)
            if message.get("type") == "control_response":
                response = message["response"]
                self._answers.pop(response["request_id"]).set_result(response)
            else:
                await self._inbox.put(message)

    def _request(self, body):
        self._ids += 1
        request_id = f"cli_{self._ids}"
        answer = asyncio.get_running_loop().create_future()
        self._answers[request_id] = answer
        return {"type": "control_request", "request_id": request_id, "request": body}, answer

    async def read_messages(self):
        first = await self._inbox.get()
        assert first["request"]["subtype"] == "initialize"
        self.initialize = first["request"]
        yield {
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": first["request_id"],
                "response": {"commands": [], **({"hook_on_failure_supported": True}
                                                if self.on_failure_supported else {})},
            },
        }
        user = await self._inbox.get()
        assert user["type"] == "user"
        matchers = (self.initialize.get("hooks") or {}).get("PreToolUse", [])
        for index, (name, tool_input) in enumerate(self.script):
            decision, reason = None, ""
            for matcher in matchers:
                if matcher.get("matcher") and not re.fullmatch(matcher["matcher"], name):
                    continue
                blocks = matcher.get("onFailure") == "block"
                for callback_id in matcher["hookCallbackIds"]:
                    frame, answer = self._request({
                        "subtype": "hook_callback",
                        "callback_id": callback_id,
                        "input": hook_input(name, json.loads(json.dumps(tool_input))),
                        "tool_use_id": f"toolu_{index}",
                    })
                    yield frame
                    try:
                        response = await asyncio.wait_for(answer, self.hook_timeout)
                    except asyncio.TimeoutError:
                        self.cancelled.append(frame["request_id"])
                        yield {"type": "control_cancel_request", "request_id": frame["request_id"]}
                        response = {"subtype": "error", "error": "hook timed out"}
                    if response["subtype"] == "error":
                        if blocks:
                            decision, reason = "deny", "hook failed"
                        continue
                    output = response["response"]
                    self.hook_outputs.append(output)
                    given = (output.get("hookSpecificOutput") or {}).get("permissionDecision")
                    if given == "deny" or (given == "allow" and decision is None):
                        decision = given
                        reason = output["hookSpecificOutput"].get("permissionDecisionReason", "")
            if (decision or self.own_permission) != "allow":
                self.results.append((name, reason or "denied by the agent's own permissions"))
                continue
            server = re.match(r"^mcp__(.+?)__(.+)$", name)
            if server and server.group(1) in self.sdk_servers:
                for message in (
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                        "protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": {"name": "scripted-cli", "version": "0"}}},
                    {"jsonrpc": "2.0", "method": "notifications/initialized"},
                    {"jsonrpc": "2.0", "id": 100 + index, "method": "tools/call",
                     "params": {"name": server.group(2), "arguments": tool_input}},
                ):
                    frame, answer = self._request(
                        {"subtype": "mcp_message", "server_name": server.group(1), "message": message})
                    yield frame
                    response = await answer
                result = response["response"]["mcp_response"]["result"]
                text = "".join(part.get("text", "") for part in result["content"])
                self.results.append((name, ("ERROR: " if result.get("isError") else "") + text))
            else:
                self.ran.append((name, tool_input))
                self.results.append((name, "ok"))
        yield {
            "type": "assistant",
            "message": {"role": "assistant", "model": "scripted",
                        "content": [{"type": "text", "text": "done"}]},
            "parent_tool_use_id": None,
            "session_id": "sess_1",
        }
        yield {"type": "result", "subtype": "success", "duration_ms": 1, "duration_api_ms": 1,
               "is_error": False, "num_turns": 1, "session_id": "sess_1", "result": "done"}
        await self._closed.wait()


async def run_agent(cli, options):
    """One turn of the SDK's streaming client against the scripted CLI."""
    async with ClaudeSDKClient(options=options, transport=cli) as client:
        await client.query("go")
        messages = [message async for message in client.receive_response()]
    assert isinstance(messages[-1], ResultMessage)
    return messages


def hooked(guardian, clock=None, **options):
    clock = clock or Clock()
    matcher = guardian_hook_matcher(
        dict(ENV), client=guardian, wait=clock.wait, now=clock.now, wall=clock.wall, log=lambda _l: None, **options)
    return ClaudeAgentOptions(hooks={"PreToolUse": [matcher]})


async def test_the_sdk_registers_the_hook_for_every_tool_with_its_timeout_and_fail_closed():
    cli = ScriptedCLI([])
    await run_agent(cli, hooked(FakeGuardian(ALLOW)))
    assert cli.initialize["hooks"]["PreToolUse"] == [
        {"matcher": None, "hookCallbackIds": ["hook_0"], "timeout": 150.0, "onFailure": "block"}]


async def test_through_the_sdk_an_allowed_call_runs_with_its_input_and_a_denied_one_does_not():
    guardian = FakeGuardian(ALLOW)
    cli = ScriptedCLI([("Bash", {"command": "npm test", "timeout": 5000})])
    await run_agent(cli, hooked(guardian))
    assert cli.ran == [("Bash", {"command": "npm test", "timeout": 5000})]
    assert guardian.calls == ["request", "execute:req_1"]
    assert decision_of(cli.hook_outputs[0]) == "allow"

    guardian = FakeGuardian(DENY)
    cli = ScriptedCLI([("Bash", {"command": "rm -rf /"})])
    await run_agent(cli, hooked(guardian))
    assert cli.ran == []
    assert "POLICY_DENY" in cli.results[0][1]
    assert guardian.calls == ["request"]


async def test_through_the_sdk_a_held_call_runs_once_after_the_person_approves():
    clock = Clock()
    guardian = FakeGuardian(HELD, claims=[PENDING, APPROVED], clock=clock)
    cli = ScriptedCLI([("Bash", {"command": "terraform apply"})])
    await run_agent(cli, hooked(guardian, clock))
    assert cli.ran == [("Bash", {"command": "terraform apply"})]
    assert guardian.calls == ["request", "claim:req_1", "claim:req_1", "execute:req_1"]


async def test_through_the_sdk_a_held_call_not_approved_does_not_run():
    clock = Clock()
    guardian = FakeGuardian(HELD, clock=clock)
    cli = ScriptedCLI([("Bash", {"command": "terraform apply"})])
    await run_agent(cli, hooked(guardian, clock))
    assert cli.ran == []
    assert "req_1" in cli.results[0][1]
    assert not any(c.startswith("execute") for c in guardian.calls)


async def test_through_the_sdk_unreachable_guardian_blocks_and_reads_are_left_to_the_agent():
    guardian = FakeGuardian(UNREACHABLE)
    cli = ScriptedCLI([("Bash", {"command": "ls"}), ("Read", {"file_path": "/work/a.py"})])
    await run_agent(cli, hooked(guardian))
    assert cli.ran == [("Read", {"file_path": "/work/a.py"})]  # no opinion: the agent's own permissions
    assert "SERVICE_UNAVAILABLE" in cli.results[0][1]
    assert cli.hook_outputs[1] == {}
    assert guardian.calls == ["request"]


async def test_the_one_shot_query_function_drives_the_same_hook():
    guardian = FakeGuardian(ALLOW)
    cli = ScriptedCLI([("Write", {"file_path": "/work/a.txt", "content": "hi"}), ("Bash", {"command": "git push"})])
    messages = [m async for m in query(prompt="go", options=hooked(guardian), transport=cli)]
    assert isinstance(messages[-1], ResultMessage)
    assert [name for name, _ in cli.ran] == ["Write", "Bash"]
    assert [i["tool_name"] for i in guardian.invocations] == ["file_write", "git_push"]
    assert [i["connection_id"] for i in guardian.invocations] == [EVERYDAY, APPROVAL]


async def test_the_bare_callback_on_a_plain_matcher_works_too():
    guardian = FakeGuardian(ALLOW)
    clock = Clock()
    guardian_hook = guardian_pre_tool_use(
        dict(ENV), client=guardian, wait=clock.wait, now=clock.now, wall=clock.wall, log=lambda _l: None)
    options = ClaudeAgentOptions(hooks={"PreToolUse": [HookMatcher(hooks=[guardian_hook])]})
    cli = ScriptedCLI([("Bash", {"command": "ls"})])
    await run_agent(cli, options)
    assert cli.ran == [("Bash", {"command": "ls"})]
    assert cli.initialize["hooks"]["PreToolUse"] == [{"matcher": None, "hookCallbackIds": ["hook_0"]}]


async def test_a_cli_that_cannot_fail_closed_is_refused_at_connect():
    cli = ScriptedCLI([("Bash", {"command": "ls"})], on_failure_supported=False)
    with pytest.raises(CLIConnectionError):
        await run_agent(cli, hooked(FakeGuardian(ALLOW)))
    assert cli.ran == []


async def test_a_hook_the_cli_gives_up_on_makes_no_further_guardian_call():
    guardian = FakeGuardian(HELD)  # every claim: still pending
    # The real clock, and short real waits between the hook's approval checks.
    matcher = guardian_hook_matcher(dict(ENV), client=guardian, log=lambda _l: None, wait=lambda _s: time.sleep(0.02))
    cli = ScriptedCLI([("Bash", {"command": "terraform apply"})], hook_timeout=0.2)
    await run_agent(cli, ClaudeAgentOptions(hooks={"PreToolUse": [matcher]}))
    assert cli.cancelled and cli.ran == []
    seen = list(guardian.calls)
    guardian.claims = [APPROVED]  # an approval now must not be redeemed by the abandoned hook
    await asyncio.sleep(0.3)
    assert guardian.calls == seen
    assert not any(c.startswith("execute") for c in guardian.calls)


# --- tools you write: @tool + create_sdk_mcp_server, through GuardianTools ---------

ran = []


@tool("refund_order", "Refund an order", {"order_id": str, "amount_cents": int})
async def refund_order(args):
    ran.append(dict(args))
    args["amount_cents"] = 0  # a handler changing its own copy changes nothing else
    return {"content": [{"type": "text", "text": f"refunded {args['order_id']}"}]}


@pytest.fixture(autouse=True)
def _reset():
    ran.clear()


REFUND = ("mcp__billing__refund_order", {"order_id": "A1", "amount_cents": 500})
TOOL_DENIED = RequestResult(ok=True, request_id="req_d", decision="DENY", reason_code="POLICY_DENY")
TOOL_APPROVED = RequestResult(ok=True, request_id="req_ask", decision="ALLOW", capability_token="cap")


def billing(guardian, **options):
    tools = GuardianTools(AsyncFake(guardian), connection_id=CONNECTION, **options)
    server = create_sdk_mcp_server("billing", tools=[tools.wrap(refund_order)])
    return ClaudeAgentOptions(mcp_servers={"billing": server})


async def call_tools(guardian, calls, **options):
    cli = ScriptedCLI(calls, sdk_servers=["billing"])
    await run_agent(cli, billing(guardian, **options))
    return [text for _name, text in cli.results]


async def test_tool_allow_runs_the_handler_once_with_the_decided_arguments():
    guardian = FakeClient(TOOL_ALLOW)
    receipts = []
    results = await call_tools(guardian, [REFUND], on_receipt=lambda t, r, rc: receipts.append((t, r)))
    assert results == ["refunded A1"]
    assert ran == [{"order_id": "A1", "amount_cents": 500}]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert guardian.last_invocation["tool_name"] == "refund_order"
    assert guardian.last_invocation["arguments"] == {"order_id": "A1", "amount_cents": 500}
    assert receipts == [("refund_order", "req_allow")]


async def test_tool_ask_is_held_then_the_same_call_runs_once_after_approval():
    guardian = FakeClient(TOOL_HELD, claims=[TOOL_APPROVED])
    pending = []
    results = await call_tools(guardian, [REFUND, REFUND],
                               on_approval_pending=lambda t, r: pending.append((t, r)))
    assert results[0].startswith("ERROR: ") and "req_ask" in results[0]
    assert results[1] == "refunded A1"
    assert ran == [{"order_id": "A1", "amount_cents": 500}]
    assert pending == [("refund_order", "req_ask")]
    # One approval: the second call claims the held request instead of asking again.
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]


async def test_tool_ask_still_pending_does_not_run_and_does_not_ask_twice():
    guardian = FakeClient(TOOL_HELD)
    results = await call_tools(guardian, [REFUND, REFUND])
    assert all(text.startswith("ERROR: ") and "req_ask" in text for text in results)
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask"]


@pytest.mark.parametrize("answer,code", [(TOOL_DENIED, "POLICY_DENY"), (UNREACHABLE, "SERVICE_UNAVAILABLE")])
async def test_tool_deny_or_unreachable_never_runs_the_handler(answer, code):
    guardian = FakeClient(answer)
    (result,) = await call_tools(guardian, [REFUND])
    assert result.startswith("ERROR: ") and code in result
    assert ran == []
    assert guardian.calls == ["request:tool.invoke"]


async def test_tool_guardian_raising_fails_closed():
    class Broken(FakeClient):
        def request(self, invocation):
            raise ConnectionError("down")

    (result,) = await call_tools(Broken(TOOL_ALLOW), [REFUND])
    assert result.startswith("ERROR: ") and "did not run" in result
    assert ran == []


async def test_tool_redemption_refused_after_the_handler_ran_is_reported_not_hidden():
    errors = []
    guardian = FakeClient(TOOL_ALLOW, execute_ok=False)
    (result,) = await call_tools(guardian, [REFUND], on_execution_error=errors.append)
    assert result.startswith("ERROR: ")
    assert len(ran) == 1 and len(errors) == 1 and errors[0].local_effect_ran is True


async def test_remote_mode_guardian_makes_the_call_and_the_handler_does_not_run():
    guardian = FakeClient(TOOL_ALLOW)
    (result,) = await call_tools(guardian, [REFUND], mode="remote")
    assert ran == []
    body = json.loads(result)["guardian"]
    assert body["decision"] == "ALLOW" and body["request_id"] == "req_allow"
    assert body["receipt"]["status"] == "sent-verified"
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


async def test_remote_mode_unverified_receipt_is_an_error_result():
    guardian = FakeClient(TOOL_ALLOW, receipt_status="not-sent")
    (result,) = await call_tools(guardian, [REFUND], mode="remote")
    assert result.startswith("ERROR: ") and ran == []


async def test_remote_mode_an_error_after_guardian_performed_the_call_is_never_reported_as_not_run():
    def broken_receipt_hook(tool_name, request_id, receipt):
        raise RuntimeError("the app's receipt hook failed")

    guardian = FakeClient(TOOL_ALLOW)
    (result,) = await call_tools(guardian, [REFUND], mode="remote", on_receipt=broken_receipt_hook)
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]  # Guardian made the call
    assert ran == []
    assert result.startswith("ERROR: ")
    assert "may have performed it" in result and "Do not call it again" in result
    assert "did not run" not in result


async def test_remote_mode_a_failing_guardian_call_is_reported_as_unknown_not_as_not_run():
    class Broken(FakeClient):
        def execute(self, *, request_id, capability_token):
            raise ConnectionError("lost")

    (result,) = await call_tools(Broken(TOOL_ALLOW), [REFUND], mode="remote")
    assert result.startswith("ERROR: ") and "did not run" not in result
    assert ran == []


def test_a_generator_handler_is_refused_when_wrapped():
    async def stream(args):
        yield {"content": []}

    tools = GuardianTools(AsyncFake(FakeClient(TOOL_ALLOW)), connection_id=CONNECTION)
    with pytest.raises(TypeError):
        tools.handler("stream", stream)


async def test_remote_mode_per_tool_and_guardian_tool_names():
    guardian = FakeClient(TOOL_ALLOW)
    (result,) = await call_tools(guardian, [REFUND], modes={"billing.refund": "remote"},
                                 tool_names={"refund_order": "billing.refund"})
    assert ran == [] and json.loads(result)["guardian"]["tool_name"] == "billing.refund"
    assert guardian.last_invocation["tool_name"] == "billing.refund"


def test_guardian_tools_checks_its_configuration():
    with pytest.raises(TypeError):
        GuardianTools(FakeClient(TOOL_ALLOW), connection_id=CONNECTION)  # a sync client
    with pytest.raises(ValueError):
        GuardianTools(AsyncFake(FakeClient(TOOL_ALLOW)), connection_id=CONNECTION, mode="enforced")


async def test_hook_and_wrapped_tools_together_decide_each_call_once():
    hook_guardian, tool_guardian = FakeGuardian(ALLOW), FakeClient(TOOL_ALLOW)
    options = billing(tool_guardian)
    clock = Clock()
    options.hooks = {"PreToolUse": [guardian_hook_matcher(
        dict(ENV), client=hook_guardian, skip_mcp_servers=["billing"],
        wait=clock.wait, now=clock.now, wall=clock.wall, log=lambda _l: None)]}
    cli = ScriptedCLI([REFUND, ("Bash", {"command": "ls"})], sdk_servers=["billing"])
    await run_agent(cli, options)
    assert [text for _n, text in cli.results] == ["refunded A1", "ok"]
    assert tool_guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert [i["tool_name"] for i in hook_guardian.invocations] == ["shell"]
