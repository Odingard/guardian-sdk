"""The OpenAI Agents helper with ``@guard(file_args=...)`` tools.

Tools wrapped with ``@guard`` raise a content-pin refusal to the Agents SDK
as the tool's exception, and the helper tells the model the call did not
run. These tests run without the Agents SDK; ``guardian_tool`` is tested
against it in ``test_openai_agents_tool.py``.
"""

import asyncio
import sys

import pytest

from odingard_guardian import AsyncGuardianClient, ExecuteResult, Guard, GuardianExecutionFailed, RequestResult
from odingard_guardian.openai_agents import (
    guardian_error_message,
    guardian_failure_error_function,
    guardian_tool,
)

CONNECTION = "pcn_0123456789abcdef0123456789abcdef"


def test_guardian_tool_without_the_agents_sdk_says_what_to_install(monkeypatch):
    monkeypatch.setitem(sys.modules, "agents", None)  # as if openai-agents were not installed

    def refund_order(order_id: str) -> str:
        return "refunded"

    with pytest.raises(ImportError, match=r"odingard-guardian\[openai-agents\]"):
        guardian_tool(refund_order, AsyncGuardianClient(credential="gak_test"), connection_id=CONNECTION)


class RewritingClient:
    def __init__(self, path):
        self.path = path
        self.calls = []

    def request(self, invocation):
        self.calls.append("request")
        with open(self.path, "wb") as f:  # the file changes after approval
            f.write(b"rewritten")
        return RequestResult(ok=True, request_id="req_1", decision="ALLOW", capability_token="cap")

    def claim(self, request_id):  # pragma: no cover - not used
        raise AssertionError("no claim expected")

    def execute(self, *, request_id, capability_token):
        self.calls.append("execute")
        return ExecuteResult(ok=True, receipt={"status": "succeeded"})


def test_a_changed_file_is_reported_to_the_model_as_did_not_run(tmp_path):
    path = tmp_path / "report.pdf"
    path.write_bytes(b"approved")
    client = RewritingClient(str(path))
    guard = Guard(client, connection_id=CONNECTION)
    ran = []

    @guard("send_report", file_args={"attachment_path": "bytes"})
    def send_report(attachment_path):
        ran.append(attachment_path)
        return "sent"

    try:
        send_report(str(path))
    except GuardianExecutionFailed as err:
        error = err
    else:  # pragma: no cover
        raise AssertionError("expected a refusal")
    assert error.reason_code == "CONTENT_CHANGED_SINCE_APPROVAL"
    assert ran == []
    assert client.calls == ["request"]

    message = guardian_error_message(error)
    assert message is not None
    assert "did not run" in message
    assert "CONTENT_CHANGED_SINCE_APPROVAL" in message
    assert "may have run" not in message

    # The ready-made failure_error_function gives the model the same text.
    told = asyncio.run(guardian_failure_error_function(None, error))
    assert told == message
