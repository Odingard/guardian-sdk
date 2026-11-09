"""Guardian for Hermes Agent (NousResearch/hermes-agent): a ``pre_tool_call`` plugin.

Hermes fires its ``pre_tool_call`` plugin hook once before every tool call
(built-in tools, plugin tools and MCP tools alike) and runs the tool only if no
hook returns ``{"action": "block", "message": ...}``. A callback that raises
or outlives ``plugins.hook_callback_timeout`` is treated as a block by Hermes
too. This module is that hook::

    # Hermes config.yaml (or $HERMES_HOME/config.yaml)
    plugins:
      enabled: [guardian]          # the entry point this package ships
      hook_callback_timeout: 130   # lets an ASK wait up to ~2 minutes

and in the environment Hermes runs in: ``GUARDIAN_AGENT_CREDENTIAL``,
``GUARDIAN_CONNECTION_ID`` (everyday tools) and
``GUARDIAN_HOOK_ASK_CONNECTION_ID`` (tools that need approval).

* ALLOW: the single-use capability is redeemed (receipt recorded), then
  Hermes runs the tool. Decision-gated, like ``@odingard/guardian-hook``.
* ASK: the hook waits for a person to approve in Guardian (phone or
  console). Approved: redeemed, then the tool runs. Not approved in time:
  blocked. Within the same Hermes process, the exact same call retried picks
  up the open request; it is never carried across processes (see
  :class:`PendingStore`).
* DENY, missing config, Guardian unreachable, a crash, a timeout: blocked.
* Writes to Hermes' own home (``config.yaml``, ``.env``, ``plugins/``) and to
  this package are routed as ``hermes_config`` (needs approval), so the agent
  cannot switch Guardian off through an everyday edit. The credential is
  moved out of ``os.environ`` on first use, so tool subprocesses do not
  inherit it.

Hermes' own approval gate (``{"action": "approve"}``) is never used: a
``hermes chat -q`` run denies it outright, and Guardian holds the ASK itself.

The routing (which Hermes tool is proposed as which Guardian tool) mirrors
``packages/hook/src/classify.ts`` so the same console setup serves both.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, MutableMapping, Optional, Sequence

from .client import DEFAULT_BASE_URL, GuardianClient, RequestResult

_logger = logging.getLogger("odingard_guardian.hermes")

__all__ = [
    "HERMES_TOOLS",
    "GovernedCall",
    "HermesVerdict",
    "PendingStore",
    "classify_command",
    "connection_for",
    "decide",
    "governed_call",
    "hermes_home",
    "protected_paths",
    "make_pre_tool_call",
    "register",
    "setup_text",
    "tier_of",
]

#: Guardian tool names this adapter proposes. Register each once in the console
#: (record-only), on the connection whose mode matches ``suggested_mode``.
HERMES_TOOLS: List[Dict[str, str]] = [
    {"name": "shell", "suggested_mode": "allow", "description": "Ordinary terminal commands (build, test, inspection)."},
    {
        "name": "shell_deploy",
        "suggested_mode": "ask",
        "description": "Infrastructure and deploy commands: terraform/tofu apply or destroy, kubectl apply/delete, "
        "helm, cloud deploy CLIs, package publishing.",
    },
    {
        "name": "shell_destructive",
        "suggested_mode": "ask",
        "description": "Destructive commands: rm -rf, git reset --hard, git clean, force pushes, dropping databases.",
    },
    {"name": "git_push", "suggested_mode": "ask", "description": "Pushing commits to a remote."},
    {"name": "file_write", "suggested_mode": "allow", "description": "write_file and patch (workspace edits)."},
    {"name": "web_fetch", "suggested_mode": "allow", "description": "web_extract (fetching URLs)."},
    {"name": "code_exec", "suggested_mode": "ask", "description": "execute_code (runs Python the model wrote)."},
    {
        "name": "browser",
        "suggested_mode": "ask",
        "description": "browser_exec, browser_cdp, browser_dialog, browser_vault (drives a real browser session).",
    },
    {"name": "computer_use", "suggested_mode": "ask", "description": "computer_use (mouse and keyboard on a desktop)."},
    {"name": "scheduled_task", "suggested_mode": "ask", "description": "cronjob_manage changes (create, run, remove jobs)."},
    {"name": "delegate", "suggested_mode": "ask", "description": "delegate_task (starts sub-agents)."},
    {
        "name": "hermes_config",
        "suggested_mode": "ask",
        "description": "Changes to Hermes' own home ($HERMES_HOME: config.yaml, .env, plugins) or to the Guardian "
        "plugin, and commands that name them or GUARDIAN_* settings.",
    },
    {"name": "hermes_other", "suggested_mode": "ask", "description": "Any other Hermes tool that is not read-only."},
]

_TIERS = {t["name"]: t["suggested_mode"] for t in HERMES_TOOLS}

#: Hermes tools that only read. Not routed through Guardian.
READ_ONLY_TOOLS = frozenset(
    {
        "read_file",
        "search_files",
        "web_search",
        "x_search",
        "vision_analyze",
        "video_analyze",
        "skills_list",
        "skill_view",
        "todo_list",
        "session_search",
        "clarify",
        "read_terminal",
        "kanban_show",
        "kanban_list",
        "kanban_attachments",
    }
)

_PROCESS_READ_ACTIONS = frozenset({"list", "poll", "log", "wait"})
_CRON_READ_ACTIONS = frozenset({"list"})
_BROWSER_TOOLS = frozenset({"browser_exec", "browser_cdp", "browser_dialog", "browser_vault"})

MAX_TEXT = 2_000

# Same patterns as packages/hook/src/classify.ts. They err toward the Ask
# tools: a false match costs one approval; a miss runs under "shell".
_DEPLOY = [
    re.compile(p, f)
    for p, f in [
        (r"\b(terraform|tofu)\b.*\s(apply|destroy|import|state\s+(rm|mv|push))\b", 0),
        (r"\bpulumi\s+(up|destroy|update)\b", 0),
        (r"\bkubectl\b.*\s(apply|delete|create|replace|patch|scale|rollout|drain|cordon)\b", 0),
        (r"\bhelm\s+(install|upgrade|uninstall|rollback|delete)\b", 0),
        (r"\b(cdk|serverless|sls|sam)\s+(deploy|destroy|remove)\b", 0),
        (r"\bfly(ctl)?\s+(deploy|destroy|apps\s+destroy|scale)\b", 0),
        (r"\bvercel\b.*(--prod\b|\bdeploy\b|\bpromote\b|\bremove\b)", 0),
        (r"\bnetlify\s+deploy\b.*--prod\b", 0),
        (r"\bgcloud\s+.*\b(deploy|delete)\b", 0),
        (r"\baws\s+.*\b(deploy|delete-stack|create-stack|update-stack|terminate-instances|delete-db-instance)\b", 0),
        (r"\baz\s+.*\b(deploy|delete|create)\b", 0),
        (r"\bwrangler\s+(deploy|publish|delete)\b", 0),
        (r"\bdocker\s+(push|compose\s+.*\bup\b.*--remote)\b", 0),
        (r"\b(npm|pnpm|yarn)\s+publish\b", 0),
        (r"\btwine\s+upload\b", 0),
        (r"\bgh\s+(release\s+create|workflow\s+run|pr\s+merge)\b", 0),
    ]
]
_DESTRUCTIVE = [
    re.compile(p, f)
    for p, f in [
        (r"\brm\s+(?:-\S*[rR]\S*\s+(?:-\S+\s+)*|-\S*f\S*\s+-\S*[rR])", 0),
        (r"\bgit\s+reset\s+.*--hard\b", 0),
        (r"\bgit\s+clean\s+-\S*f", 0),
        (r"\bgit\s+push\b.*(\s--force\b|\s-f\b|--force-with-lease|\s\+\S)", 0),
        (r"\bgit\s+(branch\s+-D|checkout\s+--\s|restore\s+--source)\b", 0),
        (r"\b(drop|truncate)\s+(table|database|schema)\b", re.IGNORECASE),
        (r"\bdelete\s+from\s+\w+\s*(;|$)", re.IGNORECASE),
        (r"\b(mkfs|dd\s+if=|shred|wipefs)\b", 0),
        (r"\bchmod\s+-R\s+777\b", 0),
        (r"\bfind\b.*\s-delete\b", 0),
    ]
]
_GIT_PUSH = re.compile(r"\bgit\s+push\b")


def classify_command(command: str) -> str:
    """``shell`` / ``shell_deploy`` / ``shell_destructive`` / ``git_push`` for one command line."""
    if any(p.search(command) for p in _DESTRUCTIVE):
        return "shell_destructive"
    if any(p.search(command) for p in _DEPLOY):
        return "shell_deploy"
    if _GIT_PUSH.search(command):
        return "git_push"
    return "shell"


def _part(text: str) -> str:
    out = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    out = re.sub(r"^(\d)", r"x\1", out)
    return out or "x"


def _mcp_name(*parts: str) -> str:
    """Guardian tool names: ``^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$``, at most 64 chars."""
    return re.sub(r"[._-]+$", "", ("mcp." + ".".join(_part(p) for p in parts))[:64])


def tier_of(tool_name: str) -> str:
    """``allow`` or ``ask``: which connection a Guardian tool's request goes to."""
    return _TIERS.get(tool_name, "ask")


@dataclass(frozen=True)
class GovernedCall:
    tool_name: str
    #: What the approver sees. Bounded; file contents and code beyond the limit are digested.
    arguments: Dict[str, Any]
    summary: str


def _str(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _digest(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def _bounded(text: str, limit: int = MAX_TEXT) -> str:
    return text if len(text) <= limit else f"{text[:limit]}… [{len(text) - limit} more chars]"


def _text_fields(key: str, text: str) -> Dict[str, Any]:
    """The text itself when it fits; else its start plus a digest of all of it, so two
    different long inputs can never look like the same proposal."""
    if len(text) <= MAX_TEXT:
        return {key: text}
    return {key: _bounded(text), f"{key}Bytes": len(text.encode("utf-8", "surrogatepass")), f"{key}Digest": _digest(text)}


def _input_fields(value: Any) -> Dict[str, Any]:
    text = _json(value)
    if len(text) <= MAX_TEXT:
        return {"input": value}
    return {"inputBytes": len(text.encode("utf-8", "surrogatepass")), "inputDigest": _digest(text)}


def hermes_home(env: Optional[Mapping[str, str]] = None) -> str:
    """``$HERMES_HOME``, or ``~/.hermes`` (Hermes' default)."""
    source = os.environ if env is None else env
    return (source.get("HERMES_HOME") or "").strip() or os.path.join(os.path.expanduser("~"), ".hermes")


def protected_paths(env: Optional[Mapping[str, str]] = None) -> List[str]:
    """Directories whose changes are governed as ``hermes_config``: Hermes' home
    (its ``config.yaml``, ``.env`` and ``plugins/`` live there) and this package."""
    out: List[str] = []
    for path in (hermes_home(env), os.path.dirname(os.path.abspath(__file__))):
        for form in (os.path.abspath(os.path.expanduser(path)), os.path.realpath(os.path.expanduser(path))):
            if form not in out:
                out.append(form)
    return out


def _under(path: str, roots: Sequence[str]) -> bool:
    if not path:
        return False
    expanded = os.path.expanduser(path)
    forms = {os.path.abspath(expanded), os.path.realpath(expanded)}
    if ".hermes" in os.path.normpath(expanded).split(os.sep):
        return True
    for form in forms:
        for root in roots:
            if form == root or form.startswith(root.rstrip(os.sep) + os.sep):
                return True
    return False


# Commands that name Hermes' home, its settings or the Guardian plugin. This is
# a pattern check, so it errs toward asking; it cannot catch a command that
# builds the path at run time (see the README's "What is not governed").
_CONFIG_WORDS = re.compile(
    r"(\.hermes\b|HERMES_HOME|HERMES_SAFE_MODE|GUARDIAN_|odingard|guardian[-_]?(hermes|plugin)"
    r"|\bhermes\s+(plugins?|config|setup|tools)\b|/proc/[^\s]*/environ)",
    re.IGNORECASE,
)


def _names_config(text: str, roots: Sequence[str]) -> bool:
    if _CONFIG_WORDS.search(text):
        return True
    return any(root and root != os.sep and root in text for root in roots)


def _wrong_type(a: Mapping[str, Any], *fields: str) -> bool:
    """A field that should be a string but is not: Hermes coerces it *after* the
    hook, so the raw value is what must be governed, not ``""``."""
    return any(a.get(f) is not None and not isinstance(a.get(f), str) for f in fields)


def _raw(tool_name: str, a: Mapping[str, Any]) -> GovernedCall:
    return GovernedCall("hermes_other", {"tool": tool_name, **_input_fields(dict(a))},
                        f"Hermes tool {tool_name} (unexpected argument types)")


def _options(a: Mapping[str, Any], skip: str) -> Dict[str, Any]:
    rest = {k: a[k] for k in sorted(a) if k != skip}
    if not rest:
        return {}
    text = _json(rest)
    if len(text) <= MAX_TEXT:
        return {"options": rest}
    return {"optionsBytes": len(text.encode("utf-8", "surrogatepass")), "optionsDigest": _digest(text)}


def governed_call(
    tool_name: str,
    args: Optional[Mapping[str, Any]],
    *,
    mcp: str = "hook",
    protected: Optional[Sequence[str]] = None,
) -> Optional[GovernedCall]:
    """Route one Hermes tool call to the Guardian tool it is governed as.

    ``None`` means the call is not governed: a read-only tool, a read-only action,
    or (with ``mcp="proxy"``) an MCP tool that guardian-mcp already governs.
    Any tool this table does not know is governed as ``hermes_other``, so a new
    Hermes tool is never silently let through. ``protected`` are the directories
    whose changes are ``hermes_config`` (default: :func:`protected_paths`).
    """
    a: Dict[str, Any] = dict(args) if isinstance(args, Mapping) else {}
    roots = protected_paths() if protected is None else list(protected)
    if tool_name == "read_file":
        # Reading Hermes' .env would hand the Guardian credential to the model.
        path = a.get("path")
        if not isinstance(path, str) and path is not None:
            return _raw(tool_name, a)
        if isinstance(path, str) and _under(path, roots) and os.path.basename(path).startswith(".env"):
            return GovernedCall("hermes_config", {"operation": "read_file", "path": path}, f"Read {path}")
        return None
    if tool_name in READ_ONLY_TOOLS:
        return None
    if tool_name == "terminal":
        if _wrong_type(a, "command", "workdir"):
            return _raw(tool_name, a)
        command = _str(a.get("command"))
        # Every other argument (workdir, background, timeout, pty, notify, force, ...)
        # is part of what is approved.
        fields = {**_text_fields("command", command), **_options(a, "command")}
        workdir = _str(a.get("workdir"))
        tool = "hermes_config" if (_names_config(command, roots) or _under(workdir, roots)) \
            else classify_command(command)
        return GovernedCall(tool, fields, f"Run: {_bounded(command, 160)}")
    if tool_name in ("process_manage", "process"):
        action = _str(a.get("action"))
        if action in _PROCESS_READ_ACTIONS:
            return None
        if _wrong_type(a, "action", "data", "session_id"):
            return _raw(tool_name, a)
        data = _str(a.get("data"))
        tool = ("hermes_config" if _names_config(data, roots) else classify_command(data)) if data else "shell"
        return GovernedCall(tool, {"operation": f"process_manage.{action or '?'}",
                                   "session_id": _str(a.get("session_id")), **_text_fields("data", data)},
                            f"Process {action or '?'} {_str(a.get('session_id'))}".strip())
    if tool_name in ("write_file", "patch"):
        if _wrong_type(a, "path", "content", "new_string", "old_string", "patch"):
            return _raw(tool_name, a)
        path = _str(a.get("path"))
        content = _str(a.get("content")) if tool_name == "write_file" else (
            _str(a.get("new_string")) or _str(a.get("patch")))
        # A V4A patch names its files inside the patch text.
        to_config = _under(path, roots) or (tool_name == "patch" and _names_config(_str(a.get("patch")), roots))
        return GovernedCall("hermes_config" if to_config else "file_write", {
            "operation": tool_name,
            "path": path,
            "contentBytes": len(content.encode("utf-8", "surrogatepass")),
            # The whole call, so a patch's old_string / replace_all / mode count too.
            "contentDigest": _digest(_json(a)),
        }, f"{'Write' if tool_name == 'write_file' else 'Edit'} {path}")
    if tool_name == "web_extract":
        raw = a.get("urls")
        if isinstance(raw, str):
            raw = [raw]  # Hermes wraps a bare string into a list after the hook
        if raw is not None and (not isinstance(raw, list) or not all(isinstance(u, str) for u in raw)):
            return _raw(tool_name, a)
        urls: List[str] = list(raw or [])
        joined = " ".join(urls)
        return GovernedCall("web_fetch", _text_fields("urls", joined), f"Fetch {_bounded(joined, 160)}")
    if tool_name == "execute_code":
        if _wrong_type(a, "code"):
            return _raw(tool_name, a)
        code = _str(a.get("code"))
        return GovernedCall("code_exec", _text_fields("code", code), f"Run code ({len(code)} chars)")
    if tool_name in _BROWSER_TOOLS:
        return GovernedCall("browser", {"tool": tool_name, **_input_fields(a)}, f"Browser: {tool_name}")
    if tool_name == "computer_use":
        return GovernedCall("computer_use", _input_fields(a), "Control the desktop")
    if tool_name in ("cronjob_manage", "cronjob"):
        action = _str(a.get("action"))
        if action in _CRON_READ_ACTIONS:
            return None
        return GovernedCall("scheduled_task", _input_fields(a), f"Scheduled job: {action or '?'}")
    if tool_name == "delegate_task":
        return GovernedCall("delegate", _input_fields(a), "Start sub-agent(s)")
    # MCP tools: mcp__<server>__<tool> (current Hermes) or mcp_<name> (older releases).
    m = re.match(r"^mcp__(.+?)__(.+)$", tool_name)
    if m or tool_name.startswith("mcp_"):
        if mcp == "proxy":
            return None
        parts = (m.group(1), m.group(2)) if m else (tool_name[4:],)
        name = _mcp_name(*parts)
        fields = {"server": parts[0], "tool": parts[1]} if m else {"tool": tool_name}
        return GovernedCall(name, {**fields, **_input_fields(a)}, f"MCP {' → '.join(parts)}")
    return GovernedCall("hermes_other", {"tool": tool_name, **_input_fields(a)}, f"Hermes tool {tool_name}")


# --- the decision -------------------------------------------------------------


@dataclass(frozen=True)
class HermesVerdict:
    allow: bool
    #: Shown to the model (it becomes the tool result on a block). Plain words.
    reason: str
    request_id: Optional[str] = None
    guardian_decision: Optional[str] = None
    approved_by_human: bool = False


_PLAIN = {
    "NOT_AUTHORIZED": "this agent is not authorized for it",
    "APPROVAL_DENIED": "the approver declined it",
    "APPROVAL_NOT_SATISFIED": "the approver declined it",
    "APPROVAL_EXPIRED": "the approval expired",
    "UNAUTHENTICATED": "the Guardian agent credential was rejected",
    "INVALID_REQUEST": "this tool is not allowed for the agent yet. In the Guardian console: Agents → this agent → "
    "the connection's card → \"Allow a tool by name\"",
    "SERVICE_UNAVAILABLE": "Guardian could not be reached",
    "REQUEST_CONFLICT": "Guardian saw a conflicting request",
}

_HELD = ("APPROVAL_REQUIRED", "APPROVAL_PENDING")


def _denied(call: GovernedCall, code: str, **extra: Any) -> HermesVerdict:
    return HermesVerdict(
        allow=False,
        reason=f"Guardian blocked {call.tool_name} ({code}): {_PLAIN.get(code, code)}. Nothing ran. "
        "Do not retry or work around this; ask the developer to review it in the Guardian console.",
        **extra,
    )


def _pending(r: RequestResult) -> bool:
    return (not r.ok and r.reason_code in _HELD) or (r.ok and r.decision == "ASK")


#: How long before the window closes the final approval check runs.
FINAL_CHECK_LEAD_S = 1.5


class PendingStore:
    """Requests still waiting for a person, keyed by the exact proposal, in this
    process's memory only.

    A retry of the same call in the same Hermes process claims the open request
    instead of filing a new one. It is deliberately never written to disk: any
    file Hermes can read, its tools can rewrite, and a rewritten entry could
    point an approval of one call at a different call. One ``hermes chat -q``
    per message (as some hosts run it) therefore starts with an empty store.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._mem: Dict[str, Dict[str, Any]] = {}

    def get(self, key: str, now: float) -> Optional[Dict[str, Any]]:
        with self._lock:
            self._mem = {k: v for k, v in self._mem.items() if v["expires_at"] > now}
            entry = self._mem.get(key)
            return dict(entry) if entry is not None else None

    def put(self, key: str, request_id: str, expires_at: float) -> None:
        with self._lock:
            self._mem[key] = {"request_id": request_id, "expires_at": float(expires_at)}

    def delete(self, key: str) -> None:
        with self._lock:
            self._mem.pop(key, None)


def _proposal_key(connection_id: str, call: GovernedCall) -> str:
    return hashlib.sha256(_json([connection_id, call.tool_name, call.arguments]).encode("utf-8", "surrogatepass")).hexdigest()


#: The Python SDK asks Guardian for a 120 s request window (``requestedTtlMs``).
REQUEST_TTL_S = 120.0


def decide(
    call: GovernedCall,
    *,
    client: Any,
    connection_id: str,
    agent_name: str,
    approval_timeout_s: float,
    request_ttl_s: float = REQUEST_TTL_S,
    poll_interval_s: float = 2.0,
    max_poll_interval_s: float = 10.0,
    deadline: Optional[float] = None,
    call_timeout_s: float = 8.0,
    store: Optional[PendingStore] = None,
    wait: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
    wall: Callable[[], float] = time.time,
    log: Callable[[str], None] = lambda _line: None,
) -> HermesVerdict:
    """One governed call: the Python port of ``packages/hook/src/decide.ts``.

    ``deadline`` (on the ``now`` clock) is when every Guardian call must have
    *finished*: past it Hermes has already given up on the hook, so a redeem
    landing then would record a receipt for a call that never ran. Each call
    may take up to ``call_timeout_s``, so a call starts only if it, and the
    redeem that may follow it, fit before the deadline.
    """

    def room(calls: int) -> bool:
        return deadline is None or now() + calls * call_timeout_s <= deadline

    key = _proposal_key(connection_id, call)
    if not room(2):  # the request (or claim) plus the redeem
        return _denied(call, "HOOK_DEADLINE_PASSED")
    held = store.get(key, wall()) if store is not None else None
    if held is not None:
        request_id: Optional[str] = held["request_id"]
        remaining_ttl = max(0.0, float(held["expires_at"]) - wall())
        try:
            result = client.claim(request_id)
        except Exception:
            result = RequestResult(ok=False, request_id=request_id, reason_code="APPROVAL_PENDING")
    else:
        remaining_ttl = request_ttl_s
        try:
            result = client.request({
                "action": "tool.invoke",
                "connection_id": connection_id,
                "tool_name": call.tool_name,
                "arguments": call.arguments,
                "purpose": f"{agent_name}: {call.summary}",
            })
        except Exception:
            return _denied(call, "SERVICE_UNAVAILABLE")
        request_id = result.request_id
    # Guardian's window started inside that call; timing from the reply errs late,
    # and a check after the window is refused by Guardian, so nothing runs.
    answered_at = now()
    approved_by_human = False

    if _pending(result):
        if not request_id:
            return _denied(call, "MISSING_REQUEST_ID")
        if store is not None and held is None:
            store.put(key, request_id, wall() + request_ttl_s)
        log(f'Guardian: "{call.summary}" is held for approval (request {request_id}). '
            "Approve it on your phone or in the console.")
        window = max(0.0, min(approval_timeout_s, remaining_ttl))
        lead = min(FINAL_CHECK_LEAD_S, window / 4)
        last_check_at = answered_at + window - lead
        if deadline is not None:
            # The last claim, and the redeem after it, must both finish in time.
            last_check_at = min(last_check_at, deadline - 2 * call_timeout_s)
        interval = poll_interval_s
        max_interval = max(max_poll_interval_s, poll_interval_s)
        while True:
            wait(max(0.0, min(interval, last_check_at - now())))
            interval = min(interval * 1.5, max_interval)
            claimed = None
            if room(2):
                try:
                    claimed = client.claim(request_id)
                except Exception:
                    claimed = None
            if claimed is not None and not _pending(claimed):
                result = claimed
                approved_by_human = claimed.ok and claimed.decision == "ALLOW"
                break
            if claimed is None and not room(2) or now() >= last_check_at:
                return HermesVerdict(
                    allow=False,
                    reason=f"Guardian is still waiting for a person to approve {call.tool_name} "
                    f"(request {request_id}). Nothing ran. Tell the user it needs approval in the Guardian app. "
                    "If it is approved while this Hermes session is still running, run exactly the same action "
                    "again and it will go ahead; otherwise asking again files a new request.",
                    request_id=request_id,
                    guardian_decision="ASK",
                )
    if store is not None:
        store.delete(key)  # decided one way or the other: never reuse it

    if not result.ok or result.decision != "ALLOW" or not result.capability_token:
        code = (result.reason_code or ("DENIED" if result.decision == "DENY" else "MISSING_CAPABILITY")) \
            if result.ok else (result.reason_code or "DENIED")
        return _denied(call, code, request_id=request_id, guardian_decision="DENY")

    if not room(1):
        return _denied(call, "HOOK_DEADLINE_PASSED", request_id=result.request_id,
                       guardian_decision="ASK" if approved_by_human else "ALLOW")
    try:
        executed = client.execute(request_id=result.request_id, capability_token=result.capability_token)
    except Exception:
        return _denied(call, "SERVICE_UNAVAILABLE", request_id=result.request_id,
                       guardian_decision="ASK" if approved_by_human else "ALLOW")
    if not executed.ok:
        return _denied(call, executed.reason_code or "EXECUTE_FAILED", request_id=result.request_id,
                       guardian_decision="ASK" if approved_by_human else "ALLOW",
                       approved_by_human=approved_by_human)
    return HermesVerdict(
        allow=True,
        reason=(f"Approved by a person in Guardian (request {result.request_id})." if approved_by_human
                else f"Allowed by Guardian policy (request {result.request_id})."),
        request_id=result.request_id,
        guardian_decision="ASK" if approved_by_human else "ALLOW",
        approved_by_human=approved_by_human,
    )


# --- the Hermes plugin --------------------------------------------------------

Env = Mapping[str, str]

#: Default ``plugins.hook_callback_timeout`` in Hermes.
HERMES_DEFAULT_HOOK_TIMEOUT_S = 30.0
#: Each Guardian HTTP call's timeout. The hook only starts a call that, with
#: the redeem after it, fits inside Hermes' hook timeout.
_HTTP_TIMEOUT_S = 8.0
#: Kept back from Hermes' hook timeout for returning to Hermes.
_RETURN_MARGIN_S = 1.0
_CREDENTIAL = "GUARDIAN_AGENT_CREDENTIAL"


def connection_for(tool_name: str, env: Env) -> Optional[str]:
    """Allow-tier tools go to ``GUARDIAN_CONNECTION_ID``; Ask-tier tools to
    ``GUARDIAN_HOOK_ASK_CONNECTION_ID`` (falling back to the first)."""
    allow = (env.get("GUARDIAN_CONNECTION_ID") or "").strip() or None
    if tier_of(tool_name) == "allow":
        return allow
    return (env.get("GUARDIAN_HOOK_ASK_CONNECTION_ID") or "").strip() or allow


def _hermes_hook_timeout() -> float:
    """Hermes' effective ``plugins.hook_callback_timeout`` (0 = unbounded)."""
    try:
        from hermes_cli.plugins import _resolve_hook_callback_timeout  # type: ignore[import-not-found]

        return float(_resolve_hook_callback_timeout())
    except Exception:
        return HERMES_DEFAULT_HOOK_TIMEOUT_S


def _block(message: str) -> Dict[str, str]:
    return {"action": "block", "message": message}


def make_pre_tool_call(
    env: Optional[Env] = None,
    *,
    client: Any = None,
    store: Optional[PendingStore] = None,
    hook_timeout_s: Optional[float] = None,
    wait: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
    wall: Callable[[], float] = time.time,
    log: Optional[Callable[[str], None]] = None,
) -> Callable[..., Optional[Dict[str, str]]]:
    """Build the ``pre_tool_call`` callback. Returns ``None`` to let a call run,
    or a block directive. It never raises."""
    source: Env = os.environ if env is None else env
    shared: Dict[str, Any] = {}
    lock = threading.Lock()
    secret: Dict[str, str] = {}

    def _take_credential() -> str:
        # Hermes passes its environment to terminal and other tool subprocesses
        # and does not strip GUARDIAN_*: move the credential out of it so tools
        # cannot read it (e.g. echo $GUARDIAN_AGENT_CREDENTIAL).
        with lock:
            if isinstance(source, MutableMapping) and _CREDENTIAL in source:
                value = (source.pop(_CREDENTIAL, None) or "").strip()
                if value:
                    secret["credential"] = value
            elif not isinstance(source, MutableMapping):
                value = (source.get(_CREDENTIAL) or "").strip()
                if value:
                    secret["credential"] = value
            return secret.get("credential", "")

    try:
        _take_credential()
    except Exception:
        pass  # checked again (and fails closed) on each call

    def _say(line: str) -> None:
        (log or _logger.warning)(line)

    def pre_tool_call(tool_name: Any = None, args: Any = None, **_: Any) -> Optional[Dict[str, str]]:
        try:
            started = now()
            if not isinstance(tool_name, str) or not tool_name:
                return _block("Guardian: the tool call had no tool name. Nothing ran.")
            credential = _take_credential()
            mcp_mode = (source.get("GUARDIAN_HERMES_MCP") or "hook").strip().lower()
            call = governed_call(tool_name, args if isinstance(args, Mapping) else {}, mcp=mcp_mode,
                                 protected=protected_paths(source))
            if call is None:
                return None  # read-only: Hermes' own rules apply
            connection_id = connection_for(call.tool_name, source)
            base_url = ((source.get("GUARDIAN_BASE_URL") or "").strip() or DEFAULT_BASE_URL).rstrip("/")
            if client is None and (not credential or not connection_id):
                return _block("Guardian: GUARDIAN_AGENT_CREDENTIAL and GUARDIAN_CONNECTION_ID must be set in the "
                              "environment Hermes runs in. Nothing ran.")
            if client is None and not base_url.startswith("https://"):
                return _block("Guardian: GUARDIAN_BASE_URL must be https. Nothing ran.")
            if not connection_id:
                return _block("Guardian: GUARDIAN_CONNECTION_ID must be set. Nothing ran.")
            guardian = client
            if guardian is None:
                with lock:
                    guardian = shared.get("client")
                    if guardian is None:
                        adapter = (source.get("GUARDIAN_ADAPTER_ID") or "").strip() or None
                        guardian = GuardianClient(credential=credential, base_url=base_url,
                                                  adapter_id=adapter, timeout=_HTTP_TIMEOUT_S)
                        shared["client"] = guardian
            pending = store
            if pending is None:
                with lock:
                    pending = shared.get("store")
                    if pending is None:
                        pending = PendingStore()
                        shared["store"] = pending

            hermes_timeout = _hermes_hook_timeout() if hook_timeout_s is None else hook_timeout_s
            try:
                requested = float(source.get("GUARDIAN_HERMES_APPROVAL_TIMEOUT_MS") or REQUEST_TTL_S * 1000) / 1000
            except ValueError:
                requested = REQUEST_TTL_S
            approval_timeout = min(max(requested, 0.0), REQUEST_TTL_S)
            # Hermes blocks the call when the hook outlives its timeout (and leaves
            # the hook running), so every Guardian call must finish before then.
            deadline = started + hermes_timeout - _RETURN_MARGIN_S if hermes_timeout > 0 else None

            verdict = decide(
                call,
                client=guardian,
                connection_id=connection_id,
                agent_name=(source.get("GUARDIAN_HERMES_AGENT_NAME") or "").strip() or "Hermes",
                approval_timeout_s=approval_timeout,
                deadline=deadline,
                call_timeout_s=_HTTP_TIMEOUT_S,
                store=pending,
                wait=wait,
                now=now,
                wall=wall,
                log=_say,
            )
            return None if verdict.allow else _block(verdict.reason)
        except Exception as exc:  # fail closed, and never echo arguments or settings
            return _block(f"Guardian: the check failed ({type(exc).__name__}). Nothing ran.")

    return pre_tool_call


def register(ctx: Any) -> None:
    """Hermes plugin entry point (``hermes_agent.plugins`` → ``guardian``)."""
    ctx.register_hook("pre_tool_call", make_pre_tool_call())


CONFIG_SNIPPET = """\
plugins:
  enabled:
    - guardian
  # Hermes blocks a pre_tool_call hook that runs longer than this. 130 s lets an
  # ASK wait about 1m50s; the default 30 s allows about 12 s (the hook keeps
  # room for its last check and the redeem, up to 8 s each).
  hook_callback_timeout: 130
"""


def setup_text() -> str:
    def rows(mode: str) -> str:
        return "\n".join(f"     {t['name']:<18} {t['description']}" for t in HERMES_TOOLS if t["suggested_mode"] == mode)

    return "\n".join([
        "Guardian modes are set per connection, so Hermes uses two record-only tool servers.",
        "",
        "1. In the Guardian console, Connections → Register a tool server → record-only:",
        '   a) "Hermes — everyday" with these tools:',
        rows("allow"),
        '   b) "Hermes — needs approval" with these tools:',
        rows("ask"),
        "      plus any MCP tools you use, named mcp.<server>.<tool>.",
        "",
        "2. Agents → your Hermes agent: Allow on (a), Ask me first on (b), and allow each tool",
        '   by name on both connection cards ("Allow a tool by name"). Otherwise every call is',
        "   denied as INVALID_REQUEST.",
        "",
        "3. In the environment Hermes runs in, set GUARDIAN_AGENT_CREDENTIAL,",
        "   GUARDIAN_CONNECTION_ID (a) and GUARDIAN_HOOK_ASK_CONNECTION_ID (b).",
        "",
        "4. pip install odingard-guardian into Hermes' Python, then add to config.yaml:",
        CONFIG_SNIPPET,
        "Read-only tools (" + ", ".join(sorted(READ_ONLY_TOOLS)) + ") are not routed through Guardian.",
    ])


if __name__ == "__main__":  # python -m odingard_guardian.hermes
    print(setup_text())
