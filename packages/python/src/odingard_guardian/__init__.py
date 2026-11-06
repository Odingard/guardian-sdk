"""Guardian SDK for Python — Human Authority Infrastructure for Autonomous AI.

The agent proposes and the human decides. Every action gets a deterministic
ALLOW / ASK / DENY decision before it runs, and every execution produces a
tamper-evident receipt you can verify offline.
"""

from ._canonical import CanonicalJsonError, canonical_json, canonical_sha256
from .client import (
    DEFAULT_BASE_URL,
    AsyncGuardianClient,
    ExecuteResult,
    GuardianClient,
    PortableReceiptResult,
    ReceiptsResult,
    RequestResult,
    build_proposal,
)
from .guard import (
    Guard,
    GuardianApprovalPending,
    GuardianDenied,
    GuardianExecutionFailed,
    ResumeResult,
    denial_hint,
    to_arguments_record,
)
from .lifecycle import GuardianDecision, classify_request_result
from .receipts import (
    afetch_receipt_verification_keys,
    averify_receipt_online,
    fetch_receipt_verification_keys,
    verify_receipt_offline,
    verify_receipt_online,
)
from .verify import (
    DEFAULT_RECEIPT_MAX_AGE_MS,
    fetch_receipt_status,
    verify_before_acting,
)

__version__ = "0.1.4"

__all__ = [
    "DEFAULT_RECEIPT_MAX_AGE_MS",
    "fetch_receipt_status",
    "verify_before_acting",
    "AsyncGuardianClient",
    "CanonicalJsonError",
    "DEFAULT_BASE_URL",
    "ExecuteResult",
    "Guard",
    "GuardianApprovalPending",
    "GuardianClient",
    "GuardianDecision",
    "GuardianDenied",
    "GuardianExecutionFailed",
    "PortableReceiptResult",
    "ReceiptsResult",
    "RequestResult",
    "ResumeResult",
    "afetch_receipt_verification_keys",
    "averify_receipt_online",
    "build_proposal",
    "canonical_json",
    "canonical_sha256",
    "classify_request_result",
    "denial_hint",
    "fetch_receipt_verification_keys",
    "to_arguments_record",
    "verify_receipt_offline",
    "verify_receipt_online",
]
