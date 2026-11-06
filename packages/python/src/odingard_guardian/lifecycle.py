"""The single, fail-closed reading of a Guardian request result.

Port of ``classifyRequestResult`` (``packages/sdk/src/lifecycle.ts``):

* ALLOW — a capability token was issued; ``execute`` redeems it.
* ASK   — held for a human; keep ``request_id``, then ``claim(request_id)``
  after the human decides.
* DENY  — everything else, including ambiguity (ALLOW without a token), an
  unknown shape, or Guardian being unreachable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

from .client import RequestResult

__all__ = ["GuardianDecision", "classify_request_result"]


@dataclass(frozen=True)
class GuardianDecision:
    decision: Literal["ALLOW", "ASK", "DENY"]
    request_id: Optional[str] = None
    capability_token: Optional[str] = None
    reason_code: Optional[str] = None


def classify_request_result(result: RequestResult) -> GuardianDecision:
    if result.ok:
        if result.decision == "ALLOW":
            if result.capability_token:
                return GuardianDecision(
                    "ALLOW", request_id=result.request_id, capability_token=result.capability_token
                )
            return GuardianDecision("DENY", request_id=result.request_id, reason_code="CAPABILITY_MISSING")
        if result.decision == "ASK" and result.request_id:
            return GuardianDecision(
                "ASK", request_id=result.request_id, reason_code=result.reason_code or "APPROVAL_REQUIRED"
            )
        return GuardianDecision("DENY", request_id=result.request_id, reason_code=result.reason_code or "DENIED")
    if result.reason_code == "APPROVAL_REQUIRED" and result.request_id:
        return GuardianDecision("ASK", request_id=result.request_id, reason_code=result.reason_code)
    return GuardianDecision("DENY", request_id=result.request_id, reason_code=result.reason_code)
