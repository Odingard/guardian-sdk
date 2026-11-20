"""Guardian for agents built on the Claude Agent SDK (``claude-agent-sdk`` on PyPI).

Two routes, for the two kinds of tool such an agent has.

**1. The agent's own tools (Bash, Write, Edit, MCP servers): a ``PreToolUse`` hook.**
The Claude Code CLI runs these itself, after the hook answers, so this is
the coding-agent hook case, the same one as ``@odingard/guardian-hook``
(its Claude Agent SDK entry is ``packages/hook/src/agent-sdk.ts``)::

    from claude_agent_sdk import ClaudeAgentOptions, query
    from odingard_guardian.claude_agent_sdk import guardian_hook_matcher

    options = ClaudeAgentOptions(hooks={"PreToolUse": [guardian_hook_matcher()]})
    async for message in query(prompt="Deploy the staging stack", options=options):
        ...

with ``GUARDIAN_AGENT_CREDENTIAL``, ``GUARDIAN_CONNECTION_ID`` (everyday
tools) and ``GUARDIAN_HOOK_ASK_CONNECTION_ID`` (tools that need approval) in
the environment. :func:`guardian_hook_matcher` registers the hook for every
tool with a timeout longer than the approval window and
``on_failure="block"``. The callback alone is :func:`guardian_pre_tool_use`::

    guardian_hook = guardian_pre_tool_use()
    options = ClaudeAgentOptions(hooks={"PreToolUse": [HookMatcher(hooks=[guardian_hook])]})

* ALLOW: the single-use capability is redeemed (receipt recorded), then the
  hook answers ``permissionDecision: "allow"`` and the CLI runs the tool.
  Decision-gated: the receipt proves Guardian's authorization of that exact
  call, not the command's own outcome.
* ASK: the hook waits for a person to approve in the Guardian console,
  within the request's window. Approved: redeemed, then ``"allow"``. Not
  approved in time: ``"deny"``. The exact same call retried in the same
  process claims the open request (see :class:`PendingStore`). The hook
  never answers ``"ask"``: Guardian holds the approval itself.
* DENY, missing configuration, Guardian unreachable, a crash, the hook's own
  deadline: ``"deny"``.
* Guardian's answer to the redemption lost: the request is looked up; only a
  verified redemption lets the tool run (``_outcome_unknown`` and
  ``_lookup_answer`` in ``guard.py``).
* Read-only tools and tools the table does not know: ``{}`` (no opinion; the
  agent's own permissions apply).

The hook never returns ``updatedInput``: the tool runs with the input the
decision was made on.

The decision code is shared with the Hermes plugin (``_hook.py``); the tool
table mirrors ``packages/hook/src/classify.ts`` as far as this package goes
(see ``README.md`` for what the TypeScript hook checks and this one does not).

**2. Tools you write (``@tool`` + ``create_sdk_mcp_server``): :class:`GuardianTools`.**
These run in your process, so they go through :class:`~odingard_guardian.Guard`
like any other Python tool::

    guardian = GuardianTools(AsyncGuardianClient(credential=...), connection_id=...)

    @tool("refund_order", "Refund an order", {"order_id": str, "amount_cents": int})
    async def refund_order(args): ...

    server = create_sdk_mcp_server("billing", tools=[guardian.wrap(refund_order)])

``mode="remote"`` (for all tools, or per tool with ``modes``) is enforced
mode: Guardian holds the credential and makes the call, the handler does not
run, and the model gets Guardian's result.
"""

from __future__ import annotations

import copy
import dataclasses
import inspect
import logging
import os
import re
import threading
import time
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Union

from claude_agent_sdk import HookMatcher, SdkMcpTool

from ._framework import ToolNames, build_guard, decide_and_run, is_stream_function, json_record, resolve_tool_name
from ._hook import (
    REQUEST_TTL_S,
    CredentialHolder,
    GovernedCall,
    PendingStore,
    _digest,
    _input_fields,
    _json,
    _mcp_name,
    _str,
    _text_fields,
    _bounded,
    classify_command as _shell_tier,
    decide,
)
from .client import DEFAULT_BASE_URL, AsyncGuardianClient, GuardianClient
from .content_pins import (
    CONTENT_PIN_INVALID_ARGUMENT,
    CONTENT_PIN_KEY,
    CONTENT_PIN_UNREADABLE,
    ContentPinError,
    pin_file,
)
from .guard import GuardianExecutionFailed, Mode

_logger = logging.getLogger("odingard_guardian.claude_agent_sdk")

__all__ = [
    "CLAUDE_TOOLS",
    "CONTENT_PIN_TOOLS",
    "GUARDIAN_HOOK_TIMEOUT_S",
    "READ_ONLY_TOOLS",
    "SDK_DEFAULT_HOOK_TIMEOUT_S",
    "EditPinRefused",
    "GovernedCall",
    "GuardianTools",
    "PendingStore",
    "classify_command",
    "connection_for",
    "governed_call",
    "guardian_hook_matcher",
    "guardian_pre_tool_use",
    "is_agent_config_path",
    "pin_edit_target",
    "setup_text",
    "tier_of",
]

# --- the tool table (mirrors packages/hook/src/classify.ts) -------------------

#: Guardian tool names the hook proposes: the names ``@odingard/guardian-hook``
#: uses, so one console setup serves both. Register each once in the console
#: (record-only), on the connection whose mode matches ``suggested_mode``.
CLAUDE_TOOLS: List[Dict[str, str]] = [
    {"name": "shell", "suggested_mode": "allow",
     "description": "Ordinary shell commands (build, test, read-only inspection)."},
    {
        "name": "shell_deploy",
        "suggested_mode": "ask",
        "description": "Infrastructure and deploy commands: terraform/tofu apply or destroy, pulumi up, "
        "kubectl apply/delete, helm install/upgrade, cloud deploy CLIs, package publishing.",
    },
    {
        "name": "shell_destructive",
        "suggested_mode": "ask",
        "description": "Destructive commands: rm -rf, git reset --hard, git clean, force pushes, dropping "
        "databases, disk formatting. Also commands and file writes that name the agent's own MCP servers, "
        "hooks or permissions (.mcp.json, .claude/settings.json) or the GUARDIAN_* settings.",
    },
    {"name": "git_push", "suggested_mode": "ask", "description": "Pushing commits to a remote."},
    {"name": "file_write", "suggested_mode": "allow", "description": "Creating or editing files in the workspace."},
    {"name": "web_fetch", "suggested_mode": "allow", "description": "Fetching a URL or searching the web."},
]

_TIERS = {t["name"]: t["suggested_mode"] for t in CLAUDE_TOOLS}

#: Claude Code tools that only read. The hook gives no opinion on them.
READ_ONLY_TOOLS = frozenset({"Read", "NotebookRead", "Grep", "Glob", "LS"})

_FILE_TOOLS = frozenset({"Write", "Edit", "MultiEdit", "NotebookEdit"})

#: Edit-type tools: the result depends on the target's current bytes, so the
#: hook pins them (Write replaces the whole file and is not pinned).
CONTENT_PIN_TOOLS = frozenset({"Edit", "MultiEdit", "NotebookEdit"})

# Files that set the agent's own MCP servers, hooks, permissions or plugins
# (AGENT_CONFIG_PATH in packages/hook/src/classify.ts; keep the two in step).
_EDGE = r"""(?:^|[\s/\\'"=:,(~])"""
_AGENT_CONFIG_PATH = re.compile(
    "|".join([
        _EDGE + r"(?:\.?mcp\.json|\.claude\.json|settings\.local\.json|managed-settings\.json"
        r"|managed-mcp\.json|claude_desktop_config\.json|guardian-hooks\.json|cordis\.patch\.ya?ml)(?![\w-])",
        _EDGE + r"""\.claude(?:[/\\](?:settings[^/\\\s'"]*\.json|hooks|agents|commands|skills|plugins"""
        r"""|output-styles)(?![\w-])|[/\\]?(?=$|[\s'"]))""",
        _EDGE + r"""\.(?:codex|cursor|gemini|dsh)(?=$|[/\\\s'"])""",
    ]),
    re.IGNORECASE,
)

# Destructive patterns classify.ts has beyond the ones in _hook.py.
_MORE_DESTRUCTIVE = [
    re.compile(r"\bdd\b.*\bof="),
    re.compile(r"\brsync\b.*\s--(delete\S*|remove-source-files)\b"),
    re.compile(r"\btruncate\b.*(\s-s\s*0\b|\s--size[= ]0\b)"),
]

# A command that names the Guardian settings or a process environment. A
# pattern check, so it errs toward asking.
_NAMES_GUARDIAN_ENV = re.compile(r"(GUARDIAN_\w*|/proc/[^\s]*/environ)", re.IGNORECASE)

_AGENT_CONFIG_NOTE = "(agent MCP, hook, permission or plugin config)"
_GUARDIAN_ENV_NOTE = "(Guardian settings or a process environment)"


def is_agent_config_path(path: str) -> bool:
    """True when a file path is agent MCP, hook, permission or plugin config."""
    return bool(_AGENT_CONFIG_PATH.search(path))


def classify_command(command: str) -> str:
    """``shell`` / ``shell_deploy`` / ``shell_destructive`` / ``git_push`` for one command line.

    Pattern checks only. A command that names the agent's own configuration,
    a ``GUARDIAN_*`` setting or ``/proc/.../environ`` is ``shell_destructive``.
    """
    if (
        any(p.search(command) for p in _MORE_DESTRUCTIVE)
        or _AGENT_CONFIG_PATH.search(command)
        or _NAMES_GUARDIAN_ENV.search(command)
    ):
        return "shell_destructive"
    return _shell_tier(command)


def tier_of(tool_name: str) -> str:
    """``allow`` or ``ask``: which connection a Guardian tool's request goes to."""
    return _TIERS.get(tool_name, "ask")


def _command_text(value: Any) -> Optional[str]:
    """A command as text: a string, or argv (some exec tools). ``None`` for anything else."""
    if isinstance(value, str):
        return value
    if isinstance(value, list) and value and all(isinstance(v, str) for v in value):
        return " ".join(value)
    return None


def governed_call(
    tool_name: str,
    tool_input: Optional[Mapping[str, Any]],
    *,
    cwd: Optional[str] = None,
    skip_mcp_servers: Iterable[str] = (),
) -> Optional[GovernedCall]:
    """Route one Claude Code tool call to the Guardian tool it is governed as.

    ``None`` means the call is not governed (no opinion; the agent's own
    permissions apply): a read-only tool, a tool this table does not know, or
    a tool of an MCP server named in ``skip_mcp_servers``.
    """
    a: Dict[str, Any] = dict(tool_input) if isinstance(tool_input, Mapping) else {}
    where = {"cwd": cwd} if isinstance(cwd, str) and cwd else {}
    if tool_name == "Bash":
        command = _command_text(a.get("command"))
        if command is None:
            # Not a command the hook can read: governed as the whole input, on the Ask tier.
            return GovernedCall("shell_destructive", {"tool": tool_name, **_input_fields(a), **where},
                                "Run a command the hook could not read")
        tool = classify_command(command)
        note = touches = None
        if _NAMES_GUARDIAN_ENV.search(command):
            touches, note = "sensitive-env", _GUARDIAN_ENV_NOTE
        elif _AGENT_CONFIG_PATH.search(command):
            touches, note = "agent-config", _AGENT_CONFIG_NOTE
        return GovernedCall(
            tool,
            {**_text_fields("command", command), **({"touches": touches} if touches else {}), **where},
            f"Run: {_bounded(command, 160)}{f' {note}' if note else ''}",
        )
    if tool_name in _FILE_TOOLS:
        path = _str(a.get("file_path")) or _str(a.get("notebook_path"))
        edits = a.get("edits")
        content = (
            _str(a.get("content"))
            or _str(a.get("new_string"))
            or _str(a.get("new_source"))
            or (_json(edits) if isinstance(edits, list) else "")
        )
        # Editing the agent's own MCP servers, hooks or permissions changes what
        # it may do next, so it goes to the Ask tier.
        config = is_agent_config_path(path)
        return GovernedCall(
            "shell_destructive" if config else "file_write",
            {
                "operation": tool_name,
                "path": path,
                "contentBytes": len(content.encode("utf-8", "surrogatepass")),
                "contentDigest": _digest(content),
                # The whole call, so old_string, replace_all and edit_mode count too.
                "inputDigest": _digest(_json(a)),
                **({"touches": "agent-config"} if config else {}),
                **where,
            },
            f"{'Write' if tool_name == 'Write' else 'Edit'} {path}{f' {_AGENT_CONFIG_NOTE}' if config else ''}",
        )
    if tool_name in READ_ONLY_TOOLS:
        return None
    if tool_name == "WebSearch":
        query = _str(a.get("query"))

        def domains(value: Any) -> Optional[List[str]]:
            return [d for d in value if isinstance(d, str)][:20] if isinstance(value, list) else None

        allowed, blocked = domains(a.get("allowed_domains")), domains(a.get("blocked_domains"))
        return GovernedCall(
            "web_fetch",
            {
                **_text_fields("query", query),
                **({"allowedDomains": allowed} if allowed is not None else {}),
                **({"blockedDomains": blocked} if blocked is not None else {}),
            },
            f"Search the web: {_bounded(query, 160)}",
        )
    if tool_name == "WebFetch":
        url = _str(a.get("url"))
        return GovernedCall("web_fetch", _text_fields("url", url), f"Fetch {_bounded(url, 160)}")
    m = re.match(r"^mcp__(.+?)__(.+)$", tool_name)
    if m:
        server, name = m.group(1), m.group(2)
        if server in set(skip_mcp_servers):
            return None
        return GovernedCall(_mcp_name(server, name), {"server": server, "tool": name, **_input_fields(a)},
                            f"MCP {server} → {name}")
    return None


class EditPinRefused(Exception):
    """A content pin could not be taken, so the call is denied before proposing."""

    def __init__(self, reason_code: str, message: str) -> None:
        self.reason_code = reason_code
        super().__init__(message)


def pin_edit_target(tool_name: str, call: GovernedCall) -> GovernedCall:
    """For an Edit-type tool, pin the target file's current contents.

    The pin goes into the proposed arguments under ``guardianContentPins``
    (mode ``"recheck"``; ``absent`` when the file does not exist yet), so the
    approval binds the file as it was when the call was proposed. Other
    calls are returned unchanged. The path must be absolute; it is never
    resolved against ``cwd``. Any failure raises :class:`EditPinRefused`.
    """
    if tool_name not in CONTENT_PIN_TOOLS:
        return call
    path = call.arguments.get("path")
    if not isinstance(path, str) or not path.startswith("/"):
        raise EditPinRefused(
            CONTENT_PIN_INVALID_ARGUMENT,
            f"{tool_name} needs an absolute file path; the hook does not resolve relative paths",
        )
    try:
        pin = pin_file(path, allow_absent=True)
    except Exception as err:  # noqa: BLE001 - a file that cannot be pinned is never edited
        code = err.reason_code if isinstance(err, ContentPinError) else CONTENT_PIN_UNREADABLE
        raise EditPinRefused(code, f"the current contents of {path} could not be pinned") from None
    record: Dict[str, Any] = {"arg": "path", "index": 0, "mode": "recheck"}
    if pin.get("absent") is True:
        record["absent"] = True
    else:
        record.update(name=pin["name"], size=pin["size"], sha256=pin["sha256"])
    return dataclasses.replace(
        call, arguments={**call.arguments, CONTENT_PIN_KEY: [record]}, content_pin=(path, pin)
    )


# --- the PreToolUse hook ------------------------------------------------------

Env = Mapping[str, str]

#: The Claude Code CLI's timeout for a hook whose matcher sets none.
SDK_DEFAULT_HOOK_TIMEOUT_S = 60.0
#: The matcher timeout :func:`guardian_hook_matcher` sets: the request window
#: this package asks Guardian for (120 s) plus a margin, so an approval is
#: never cut off by the SDK's timeout.
GUARDIAN_HOOK_TIMEOUT_S = REQUEST_TTL_S + 30.0
#: Each Guardian HTTP call's timeout. The hook only starts a call that, with
#: the redeem after it, fits inside the hook's timeout.
_HTTP_TIMEOUT_S = 8.0
#: Kept back from the hook's timeout for answering the CLI.
_RETURN_MARGIN_S = 1.0
#: Settings of the TypeScript hook that this hook cannot honour.
_UNSUPPORTED_SETTINGS = ("GUARDIAN_HOOK_SENSITIVE_PATHS", "GUARDIAN_HOOK_SENSITIVE_MODE")


class _Abandoned(Exception):
    """The CLI cancelled the hook: stop before the next Guardian call."""


def connection_for(tool_name: str, env: Env) -> Optional[str]:
    """Allow-tier tools go to ``GUARDIAN_CONNECTION_ID``; Ask-tier tools to
    ``GUARDIAN_HOOK_ASK_CONNECTION_ID`` (falling back to the first)."""
    allow = (env.get("GUARDIAN_CONNECTION_ID") or "").strip() or None
    if tier_of(tool_name) == "allow":
        return allow
    return (env.get("GUARDIAN_HOOK_ASK_CONNECTION_ID") or "").strip() or allow


def _permission(decision: str, reason: str) -> Dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            # Only an allow allows; anything else given here denies.
            "permissionDecision": "allow" if decision == "allow" else "deny",
            "permissionDecisionReason": reason,
        }
    }


def _block(reason: str) -> Dict[str, Any]:
    return _permission("deny", reason)


def guardian_pre_tool_use(
    env: Optional[Env] = None,
    *,
    agent_name: Optional[str] = None,
    hook_timeout_s: float = SDK_DEFAULT_HOOK_TIMEOUT_S,
    skip_mcp_servers: Iterable[str] = (),
    client: Any = None,
    store: Optional[PendingStore] = None,
    log: Optional[Callable[[str], None]] = None,
    wait: Optional[Callable[[float], None]] = None,
    now: Callable[[], float] = time.monotonic,
    wall: Callable[[], float] = time.time,
) -> Callable[[Any, Optional[str], Any], Awaitable[Dict[str, Any]]]:
    """Build the ``PreToolUse`` callback. It never raises.

    :param env: configuration (default ``os.environ``), same names as
        ``@odingard/guardian-hook``: ``GUARDIAN_AGENT_CREDENTIAL``,
        ``GUARDIAN_CONNECTION_ID``, ``GUARDIAN_HOOK_ASK_CONNECTION_ID``,
        ``GUARDIAN_BASE_URL``, ``GUARDIAN_ADAPTER_ID``,
        ``GUARDIAN_HOOK_AGENT_NAME``, ``GUARDIAN_HOOK_APPROVAL_TIMEOUT_MS``
        (at most 120000) and ``GUARDIAN_HOOK_WATCH_MODE`` (``on``: while the
        agent is in watch mode, a call Guardian would have held or denied is
        left to the agent's own permissions). The credential is moved out of
        a mutable mapping when the callback is built, so a CLI started
        afterwards, and the commands it runs, do not inherit it.
    :param agent_name: label approvers see (default ``"Claude agent"``).
    :param hook_timeout_s: the timeout of the matcher this callback is
        registered on (the SDK's default is 60 s). Every Guardian call must
        finish before it, so an ASK waits about 16 s less than this, and at
        most 120 s. :func:`guardian_hook_matcher` sets both for you.
    :param skip_mcp_servers: MCP servers whose tools are governed elsewhere
        (wrapped with :class:`GuardianTools`, or run behind ``guardian-mcp``):
        the hook gives no opinion on ``mcp__<server>__*`` for them.
    :param client: a Guardian client stand-in (sync), for tests.
    :param store: held requests (default: one per callback, in memory).
    :param log: progress lines, e.g. "held for approval". Default: the
        ``odingard_guardian.claude_agent_sdk`` logger, at warning level.
    """
    if not hook_timeout_s > 0:
        raise ValueError("hook_timeout_s must be positive (the timeout of the hook's matcher, in seconds)")
    if client is not None and inspect.iscoroutinefunction(getattr(client, "request", None)):
        raise TypeError("use a GuardianClient (sync): the hook runs its Guardian calls in a worker thread")
    source: Env = os.environ if env is None else env
    skipped = frozenset(skip_mcp_servers)
    credential = CredentialHolder(source)
    pending = store if store is not None else PendingStore()
    shared: Dict[str, Any] = {}
    lock = threading.Lock()

    try:
        credential.take()
    except Exception:  # noqa: BLE001 - checked again (and fails closed) on each call
        pass

    def say(line: str) -> None:
        (log or _logger.warning)(line)

    def evaluate(data: Any, started: float, cancelled: threading.Event) -> Dict[str, Any]:
        if not isinstance(data, Mapping):
            return _block("Guardian hook: could not read the tool call from the agent. Nothing ran.")
        if data.get("hook_event_name") not in (None, "PreToolUse"):
            return {}
        tool_name = data.get("tool_name")
        if not isinstance(tool_name, str) or not tool_name:
            return _block("Guardian hook: the tool call had no tool name. Nothing ran.")
        tool_input = data.get("tool_input")
        cwd = data.get("cwd")
        secret = credential.take()
        classified = governed_call(
            tool_name,
            tool_input if isinstance(tool_input, Mapping) else {},
            cwd=cwd if isinstance(cwd, str) else None,
            skip_mcp_servers=skipped,
        )
        if classified is None:
            return {}  # not governed: no opinion, the agent's own permissions apply
        unsupported = [name for name in _UNSUPPORTED_SETTINGS if (source.get(name) or "").strip()]
        if unsupported:
            return _block(
                f"Guardian hook: {' and '.join(unsupported)} is set, and this hook does not check "
                "sensitive-file patterns (the guardian-hook command does). Unset it to use this hook. Nothing ran."
            )
        try:
            call = pin_edit_target(tool_name, classified)
        except EditPinRefused as err:
            return _block(f"Guardian hook: {err} ({err.reason_code}). Nothing ran.")

        connection_id = connection_for(call.tool_name, source)
        base_url = ((source.get("GUARDIAN_BASE_URL") or "").strip() or DEFAULT_BASE_URL).rstrip("/")
        if client is None and (not secret or not connection_id):
            return _block("Guardian hook: GUARDIAN_AGENT_CREDENTIAL and GUARDIAN_CONNECTION_ID must be set in "
                          "the environment the agent runs in. Nothing ran.")
        if client is None and not base_url.startswith("https://"):
            return _block("Guardian hook: GUARDIAN_BASE_URL must be https. Nothing ran.")
        if not connection_id:
            return _block("Guardian hook: GUARDIAN_CONNECTION_ID must be set. Nothing ran.")
        guardian = client
        if guardian is None:
            with lock:
                guardian = shared.get("client")
                if guardian is None:
                    adapter = (source.get("GUARDIAN_ADAPTER_ID") or "").strip() or None
                    guardian = GuardianClient(credential=secret, base_url=base_url, adapter_id=adapter,
                                              timeout=_HTTP_TIMEOUT_S)
                    shared["client"] = guardian

        try:
            requested = float(source.get("GUARDIAN_HOOK_APPROVAL_TIMEOUT_MS") or REQUEST_TTL_S * 1000) / 1000
        except ValueError:
            requested = REQUEST_TTL_S
        if requested != requested:  # NaN
            requested = REQUEST_TTL_S

        def checked_now() -> float:
            # decide() reads the clock before each Guardian call it starts:
            # once the CLI has cancelled the hook, no further call is made.
            if cancelled.is_set():
                raise _Abandoned()
            return now()

        def checked_wait(seconds: float) -> None:
            if wait is not None:
                wait(seconds)
            elif cancelled.wait(seconds):
                raise _Abandoned()
            if cancelled.is_set():
                raise _Abandoned()

        verdict = decide(
            call,
            client=guardian,
            connection_id=connection_id,
            agent_name=agent_name or (source.get("GUARDIAN_HOOK_AGENT_NAME") or "").strip() or "Claude agent",
            approval_timeout_s=min(max(requested, 0.0), REQUEST_TTL_S),
            # The CLI gives up on the hook at its timeout; a redeem landing after
            # that would record a receipt for a call that never ran.
            deadline=started + hook_timeout_s - _RETURN_MARGIN_S,
            call_timeout_s=_HTTP_TIMEOUT_S,
            store=pending,
            wait=checked_wait,
            now=checked_now,
            wall=wall,
            log=say,
            host="agent",
            watch_aware=(source.get("GUARDIAN_HOOK_WATCH_MODE") or "").strip() == "on",
        )
        if verdict.would_decision is not None:
            # Watch mode: no permission decision, so the agent's own
            # permissions apply. The reason is shown to the person.
            return {"systemMessage": verdict.reason}
        return _permission("allow" if verdict.allow else "deny", verdict.reason)

    def run(data: Any, started: float, cancelled: threading.Event) -> Dict[str, Any]:
        try:
            return evaluate(data, started, cancelled)
        except Exception as exc:  # noqa: BLE001 - fail closed, and never echo arguments or settings
            return _block(f"Guardian hook: the check failed ({type(exc).__name__}). Nothing ran.")

    async def guardian_hook(input_data: Any, tool_use_id: Optional[str] = None, context: Any = None) -> Dict[str, Any]:
        cancelled = threading.Event()
        try:
            # File hashing and the Guardian calls block, so they run in a
            # worker thread and the SDK keeps reading the CLI meanwhile.
            return await _in_thread(run, input_data, now(), cancelled)
        except Exception as exc:  # noqa: BLE001
            return _block(f"Guardian hook: the check failed ({type(exc).__name__}). Nothing ran.")
        except BaseException:
            cancelled.set()  # the CLI cancelled the request: stop the worker
            raise

    return guardian_hook


async def _in_thread(fn: Callable[..., Dict[str, Any]], *args: Any) -> Dict[str, Any]:
    import anyio.to_thread  # a dependency of claude-agent-sdk

    run_sync = anyio.to_thread.run_sync
    # A cancelled hook must not wait for the worker (anyio 4.1 renamed the option).
    option = "abandon_on_cancel" if "abandon_on_cancel" in inspect.signature(run_sync).parameters else "cancellable"
    return await run_sync(lambda: fn(*args), **{option: True})


def guardian_hook_matcher(
    env: Optional[Env] = None,
    *,
    matcher: Optional[str] = None,
    timeout_s: float = GUARDIAN_HOOK_TIMEOUT_S,
    **options: Any,
) -> HookMatcher:
    """The recommended registration: every tool, fail closed, and a timeout
    longer than the approval window.

    ``on_failure="block"`` makes the CLI block a call when the hook fails or
    times out, instead of treating that as no decision. The SDK refuses to
    connect to a CLI too old to honour it (``CLIConnectionError``).
    ``matcher`` (default: every tool) selects which tools reach the hook at
    all: a tool it does not match is not governed. Other options are those
    of :func:`guardian_pre_tool_use`.
    """
    if "hook_timeout_s" in options:
        raise TypeError("pass timeout_s: the matcher's timeout is the hook's timeout")
    return HookMatcher(
        matcher=matcher,
        hooks=[guardian_pre_tool_use(env, hook_timeout_s=timeout_s, **options)],
        timeout=timeout_s,
        on_failure="block",
    )


def setup_text() -> str:
    def rows(mode: str) -> str:
        return "\n".join(f"     {t['name']:<18} {t['description']}" for t in CLAUDE_TOOLS if t["suggested_mode"] == mode)

    return "\n".join([
        "Guardian modes are set per connection, so the hook uses two record-only tool servers",
        "(the same two as the guardian-hook command).",
        "",
        "1. In the Guardian console, Connections → Register a tool server → record-only:",
        '   a) "Coding agent — everyday" with these tools:',
        rows("allow"),
        '   b) "Coding agent — needs approval" with these tools:',
        rows("ask"),
        "      plus any MCP tools you use, named mcp.<server>.<tool>.",
        "",
        "2. Agents → your agent: Allow on (a), Ask me on (b), and allow each tool by name on",
        '   both connection cards ("Allow a tool by name"). Otherwise every call is denied as',
        "   INVALID_REQUEST.",
        "",
        "3. In the environment the agent runs in, set GUARDIAN_AGENT_CREDENTIAL,",
        "   GUARDIAN_CONNECTION_ID (a) and GUARDIAN_HOOK_ASK_CONNECTION_ID (b).",
        "",
        "4. Register the hook:",
        '   ClaudeAgentOptions(hooks={"PreToolUse": [guardian_hook_matcher()]})',
        "",
        "Read-only tools (" + ", ".join(sorted(READ_ONLY_TOOLS)) + ") and tools the table does not know",
        "are not routed through Guardian.",
    ])


# --- tools you write: @tool + create_sdk_mcp_server ---------------------------

def _text(message: str, *, error: bool) -> Dict[str, Any]:
    return {"content": [{"type": "text", "text": message}], **({"is_error": True} if error else {})}


class GuardianTools:
    """Sends each call of an SDK MCP tool (``@tool``) to Guardian before its handler runs.

    Built on :class:`~odingard_guardian.Guard`; tools run in your process, so
    nothing here goes through the CLI's permission system.

    * ALLOW (``in_process``): the handler runs once with the arguments
      Guardian decided on, then the capability is redeemed and the decision
      recorded.
    * ALLOW (``remote``): Guardian makes the call. The handler does not run;
      the model gets Guardian's result (the receipt) as JSON text.
    * ASK: the handler does not run. The model is told the call is held for
      a person, as an error result; after the person approves, the same call
      (same tool, same arguments) claims the approved request and runs.
    * DENY, or Guardian unreachable: the handler does not run and the model
      is told so, as an error result.

    :param client: an :class:`AsyncGuardianClient` (the agent's credential).
    :param connection_id: the Guardian connection the tools are registered on.
    :param mode: ``"in_process"`` (default) or ``"remote"``, for every tool.
    :param modes: the mode per Guardian tool name, where it differs.
    :param tool_names: the Guardian tool name for an SDK tool name, as a
        mapping or a function. Default: the same name.
    :param on_approval_pending: ``callback(tool_name, request_id)`` when a
        call is held, so the app can show the request to a person.
    :param agent_name / purpose / adapter_id / amount_args / on_receipt /
        on_execution_error: as for :class:`Guard`.
    """

    def __init__(
        self,
        client: AsyncGuardianClient,
        *,
        connection_id: str,
        mode: Mode = "in_process",
        modes: Optional[Mapping[str, Mode]] = None,
        agent_name: str = "agent",
        purpose: Union[None, str, Callable[[str, Dict[str, Any]], str]] = None,
        adapter_id: Optional[str] = None,
        amount_args: Optional[Mapping[str, Mapping[str, Any]]] = None,
        tool_names: ToolNames = None,
        on_approval_pending: Optional[Callable[[str, str], Any]] = None,
        on_receipt: Optional[Callable[[str, str, Optional[Dict[str, Any]]], Any]] = None,
        on_execution_error: Optional[Callable[[GuardianExecutionFailed], Any]] = None,
    ) -> None:
        self._guard = build_guard(
            client,
            connection_id=connection_id,
            agent_name=agent_name,
            adapter_id=adapter_id,
            purpose=purpose,
            amount_args=amount_args,
            on_receipt=on_receipt,
            on_execution_error=on_execution_error,
            mode=mode,
            modes=modes,
        )
        self._tool_names = tool_names
        self._on_approval_pending = on_approval_pending

    def wrap(self, tool: "SdkMcpTool[Any]") -> "SdkMcpTool[Any]":
        """The same tool with a handler that asks Guardian first."""
        return dataclasses.replace(tool, handler=self.handler(tool.name, tool.handler))

    def wrap_all(self, tools: Sequence["SdkMcpTool[Any]"]) -> List["SdkMcpTool[Any]"]:
        return [self.wrap(tool) for tool in tools]

    def handler(
        self, name: str, handler: Callable[[Any], Awaitable[Dict[str, Any]]]
    ) -> Callable[[Any], Awaitable[Dict[str, Any]]]:
        """Govern a raw handler (``async def handler(args) -> dict``) registered as SDK tool ``name``."""
        if is_stream_function(handler):
            # Calling one runs none of its body, so Guardian would record a call that never ran.
            raise TypeError(f"{name}: an SDK MCP tool handler returns its result; a generator cannot be governed")
        tool_name = resolve_tool_name(self._tool_names, name)
        guard = self._guard

        async def governed(args: Any) -> Dict[str, Any]:
            try:
                proposed = json_record(args)
                decided = copy.deepcopy(args)
            except Exception:  # noqa: BLE001 - arguments Guardian cannot read never run
                return _text(
                    f"Guardian could not read the arguments of {tool_name} as JSON, so it was not "
                    "proposed and did not run.",
                    error=True,
                )
            result: Dict[str, Any] = {}

            async def run_handler() -> None:
                nonlocal result
                # The handler gets the arguments Guardian decided on.
                result = await handler(copy.deepcopy(decided))

            # The handler's own error is raised from here: the SDK reports it to the model.
            outcome = await decide_and_run(guard, tool_name, proposed, run_handler)
            if outcome.message is None:
                return result  # ALLOW: the handler ran and Guardian recorded it
            if outcome.decision == "ALLOW" and not outcome.ran and outcome.reason_code is None:
                # Remote mode: Guardian made the call; the message is its result.
                return _text(outcome.message, error=False)
            if outcome.decision == "ASK" and self._on_approval_pending is not None and outcome.request_id:
                pending = self._on_approval_pending(tool_name, outcome.request_id)
                if inspect.isawaitable(pending):
                    await pending
            return _text(outcome.message, error=True)

        return governed


if __name__ == "__main__":  # python -m odingard_guardian.claude_agent_sdk
    print(setup_text())
