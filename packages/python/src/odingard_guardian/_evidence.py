"""Evidence-chain verification — a faithful port of ``verifyEvidenceChain``.

Mirrors ``packages/sdk/src/evidence/evidence.ts``. Every record's payload digest and record hash is re-derived with
guardian-canonical-json.v1, the hash links and sequence are checked, and the
event order must follow the authority lifecycle (decision → capability →
adapter authentication → execution → effect), including the approval state
machine. Any malformed input fails closed.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from ._canonical import canonical_sha256

_CONTEXT_KEYS = ("tenantId", "principalId", "agentId", "requestId", "correlationId")
_RECORD_KEYS = {
    "schemaVersion",
    "id",
    "tenantId",
    "principalId",
    "agentId",
    "requestId",
    "correlationId",
    "eventTimeEpochMs",
    "event",
    "sequence",
    "previousRecordHash",
    "payloadDigest",
    "recordHash",
}
_SHA256 = re.compile(r"^[a-f0-9]{64}$")

_APPROVAL_TRANSITIONS = {
    "pending": ("approved", "denied", "revoked", "expired", "superseded"),
    "approved": ("denied", "revoked", "expired", "superseded", "consumed"),
}
_HUMAN_DECISION_FOR_STATE = {"approved": "approve", "denied": "deny", "revoked": "revoke"}
_DECISION_FROM_STATES = {
    "approve": ("pending",),
    "deny": ("pending", "approved"),
    "revoke": ("pending", "approved"),
}
_EXECUTION_EVENT_TYPES = {
    "EXECUTION_ATTEMPTED",
    "EXECUTION_ABORTED",
    "EFFECT_PREPARED",
    "EFFECT_COMMIT_AUTHORIZED",
    "EFFECT_OUTCOME_UNKNOWN",
    "EFFECT_UNRESOLVED",
    "EFFECT_VERIFIED",
    "EXECUTION_FAILED",
}
_PRE_COMMIT_FAILURE_CODES = {
    "SENDER_ACCOUNT_MISMATCH",
    "CREDENTIAL_UNAVAILABLE",
    "PREPARE_REJECTED",
    "PREPARE_AMBIGUOUS",
    "READBACK_UNAVAILABLE",
    "PREPARED_CONTENT_MISMATCH",
    "COMMIT_NOT_AUTHORIZED",
    "AUTHORITY_REVOKED_BEFORE_COMMIT",
    "COMMIT_DEADLINE_EXPIRED",
}


def hash_evidence_payload(event: Any) -> str:
    return canonical_sha256({"domain": "odingard.guardian.evidence.payload.v1", "event": event})


def hash_evidence_record_core(core: Any) -> str:
    return canonical_sha256({"domain": "odingard.guardian.evidence.record.v1", "record": core})


def _invalid(reason: str, index: Optional[int]) -> dict:
    return {"valid": False, "reasonCode": reason, "recordIndex": index}


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _well_formed(record: Any) -> bool:
    if not isinstance(record, dict) or set(record.keys()) != _RECORD_KEYS:
        return False
    if record["schemaVersion"] != 1:
        return False
    for key in ("id", *_CONTEXT_KEYS):
        if not isinstance(record[key], str) or not record[key]:
            return False
    if not _is_int(record["sequence"]) or record["sequence"] < 1:
        return False
    if not _is_int(record["eventTimeEpochMs"]) or record["eventTimeEpochMs"] < 0:
        return False
    if record["previousRecordHash"] is not None and not (
        isinstance(record["previousRecordHash"], str) and _SHA256.match(record["previousRecordHash"])
    ):
        return False
    for key in ("payloadDigest", "recordHash"):
        if not isinstance(record[key], str) or not _SHA256.match(record[key]):
            return False
    event = record["event"]
    return (
        isinstance(event, dict)
        and isinstance(event.get("eventType"), str)
        and isinstance(event.get("payload"), dict)
    )


class _ApprovalTracker:
    def __init__(self) -> None:
        self.approval_id: Optional[str] = None
        self.state: Optional[str] = None
        self.version = 0
        self.state_digests: dict = {}
        self.decisions: dict = {}

    def human_approved_current_version(self) -> bool:
        decision = self.decisions.get(self.version)
        return self.state == "approved" and decision is not None and decision[0] == "approve"

    def accept(self, event: dict) -> bool:
        event_type = event["eventType"]
        if event_type not in (
            "APPROVAL_STATE_REFERENCED",
            "APPROVAL_DECISION_RECORDED",
            "APPROVAL_PRESENTED",
            "APPROVAL_REJECTED",
        ):
            return True
        payload = event["payload"]
        if self.approval_id is not None and payload.get("approvalId") != self.approval_id:
            return False
        self.approval_id = payload.get("approvalId")
        if event_type == "APPROVAL_PRESENTED":
            return self.version >= 1
        if event_type == "APPROVAL_REJECTED":
            return True
        digest = hash_evidence_payload(event)
        version = payload.get("version")
        if event_type == "APPROVAL_DECISION_RECORDED":
            existing = self.decisions.get(version)
            if existing is not None:
                return existing[1] == digest and version in (self.version, self.version + 1)
            if (
                self.version < 1
                or version != self.version + 1
                or self.state is None
                or self.state not in _DECISION_FROM_STATES.get(payload.get("decision"), ())
            ):
                return False
            self.decisions[version] = (payload.get("decision"), digest)
            return True
        existing_state = self.state_digests.get(version)
        if existing_state is not None:
            return existing_state == digest and version == self.version
        if version != self.version + 1:
            return False
        new_state = payload.get("state")
        if self.state is None:
            lifecycle_valid = new_state == "pending"
        else:
            lifecycle_valid = new_state in _APPROVAL_TRANSITIONS.get(self.state, ())
        required = _HUMAN_DECISION_FOR_STATE.get(new_state)
        recorded = self.decisions.get(version)
        recorded_decision = recorded[0] if recorded else None
        if not lifecycle_valid or (
            recorded_decision is not None if required is None else recorded_decision != required
        ):
            return False
        self.state_digests[version] = digest
        self.version = version
        self.state = new_state
        return True


def verify_evidence_chain(chain: Any) -> dict:
    """Verify an evidence chain. Returns ``{"valid": True, ...}`` or a reason code."""
    try:
        if not isinstance(chain, list) or len(chain) > 10_000:
            return _invalid("MALFORMED_CHAIN", None)
        if not all(_well_formed(r) for r in chain):
            return _invalid("MALFORMED_CHAIN", None)
        if not chain:
            return {"valid": True, "count": 0, "lastRecordHash": None, "context": None}
        first = chain[0]
        if first["sequence"] != 1 or first["previousRecordHash"] is not None:
            return _invalid("INVALID_GENESIS", 0)
        ids = [r["id"] for r in chain]
        if len(set(ids)) != len(ids):
            return _invalid("DUPLICATE_EVIDENCE_ID", None)
        sequences = [r["sequence"] for r in chain]
        if len(set(sequences)) != len(sequences):
            return _invalid("DUPLICATE_SEQUENCE", None)
        if any(seq != i + 1 for i, seq in enumerate(sorted(sequences))):
            return _invalid("SEQUENCE_GAP", None)

        bound_action_digest = None
        recorded_decision = None
        last_decision_index = -1
        approval = _ApprovalTracker()
        issued_capabilities: set = set()
        authenticated_adapters: set = set()
        capability_used = False
        execution_start = None
        execution_key = None
        prepared = False
        prepared_index = -1
        commit_authorized = False
        outcome_unknown = False
        unresolved = False
        terminal = False

        for index, record in enumerate(chain):
            event = record["event"]
            event_type = event["eventType"]
            payload = event["payload"]
            if record["sequence"] != index + 1:
                return _invalid("RECORD_REORDERED", index)
            if any(record[k] != first[k] for k in _CONTEXT_KEYS):
                return _invalid("CONTEXT_MISMATCH", index)
            if index > 0 and record["eventTimeEpochMs"] < chain[index - 1]["eventTimeEpochMs"]:
                return _invalid("NON_MONOTONIC_EVENT_TIME", index)
            if hash_evidence_payload(event) != record["payloadDigest"]:
                return _invalid("PAYLOAD_DIGEST_MISMATCH", index)
            if "actionDigest" in payload:
                if bound_action_digest is None:
                    bound_action_digest = payload["actionDigest"]
                elif payload["actionDigest"] != bound_action_digest:
                    return _invalid("ACTION_DIGEST_MISMATCH", index)
            if event_type == "DECISION_RECORDED":
                recorded_decision = payload.get("decision")
                last_decision_index = index
            if not approval.accept(event):
                return _invalid("INVALID_EVENT_ORDER", index)
            approval_state = approval.state
            approval_satisfied = approval_state in ("approved", "consumed")

            if event_type == "CAPABILITY_STATE_REFERENCED":
                capability_id = payload.get("capabilityId")
                state = payload.get("state")
                if state == "issued":
                    human_approved = (
                        recorded_decision == "ASK" and approval.human_approved_current_version()
                    )
                    if recorded_decision != "ALLOW" and not human_approved:
                        return _invalid("INVALID_EVENT_ORDER", index)
                    issued_capabilities.add(capability_id)
                elif capability_id not in issued_capabilities:
                    return _invalid("INVALID_EVENT_ORDER", index)
                elif state == "used" and recorded_decision == "ASK" and approval_state != "consumed":
                    return _invalid("INVALID_EVENT_ORDER", index)
                elif state == "used":
                    capability_used = True

            if event_type == "ADAPTER_AUTHENTICATION_RECORDED":
                if not issued_capabilities:
                    return _invalid("INVALID_EVENT_ORDER", index)
                authenticated_adapters.add(payload.get("adapterId"))

            if event_type in _EXECUTION_EVENT_TYPES and (execution_start == "aborted" or terminal):
                return _invalid("INVALID_EVENT_ORDER", index)

            if event_type in ("EXECUTION_ATTEMPTED", "EXECUTION_ABORTED"):
                if (
                    execution_start is not None
                    or not capability_used
                    or payload.get("adapterId") not in authenticated_adapters
                    or recorded_decision is None
                    or recorded_decision == "DENY"
                    or (recorded_decision == "ASK" and not approval_satisfied)
                ):
                    return _invalid("INVALID_EVENT_ORDER", index)
                execution_key = f"{payload.get('adapterId')}:{payload.get('attemptReference')}"
                execution_start = "attempted" if event_type == "EXECUTION_ATTEMPTED" else "aborted"

            if event_type in _EXECUTION_EVENT_TYPES and event_type not in (
                "EXECUTION_ATTEMPTED",
                "EXECUTION_ABORTED",
            ):
                if "adapterId" not in payload or "attemptReference" not in payload:
                    return _invalid("INVALID_EVENT_ORDER", index)
                attempt = f"{payload['adapterId']}:{payload['attemptReference']}"
                if execution_start != "attempted" or attempt != execution_key:
                    return _invalid("INVALID_EVENT_ORDER", index)

            if event_type == "EFFECT_PREPARED":
                if prepared:
                    return _invalid("INVALID_EVENT_ORDER", index)
                prepared = True
                prepared_index = index

            if event_type == "EFFECT_COMMIT_AUTHORIZED":
                allows_commit = recorded_decision == "ALLOW" or (
                    recorded_decision == "ASK" and approval_state == "consumed"
                )
                if (
                    commit_authorized
                    or not prepared
                    or last_decision_index <= prepared_index
                    or not allows_commit
                ):
                    return _invalid("INVALID_EVENT_ORDER", index)
                commit_authorized = True

            if event_type == "EFFECT_OUTCOME_UNKNOWN":
                if not commit_authorized or outcome_unknown or unresolved:
                    return _invalid("INVALID_EVENT_ORDER", index)
                outcome_unknown = True

            if event_type == "EFFECT_UNRESOLVED":
                if not commit_authorized or unresolved:
                    return _invalid("INVALID_EVENT_ORDER", index)
                unresolved = True

            if event_type == "EFFECT_VERIFIED":
                if not commit_authorized:
                    return _invalid("INVALID_EVENT_ORDER", index)
                terminal = True

            if event_type == "EXECUTION_FAILED":
                code = payload.get("failureCode")
                if (outcome_unknown or unresolved) and code not in (
                    "EFFECT_MISMATCH",
                    "DUPLICATE_EFFECT_DETECTED",
                ):
                    return _invalid("INVALID_EVENT_ORDER", index)
                if code in ("COMMIT_REJECTED", "COMMIT_NOT_ISSUED") and (
                    not commit_authorized or outcome_unknown or unresolved
                ):
                    return _invalid("INVALID_EVENT_ORDER", index)
                if commit_authorized and code in _PRE_COMMIT_FAILURE_CODES:
                    return _invalid("INVALID_EVENT_ORDER", index)
                terminal = True

            expected_previous = None if index == 0 else chain[index - 1]["recordHash"]
            if record["previousRecordHash"] != expected_previous:
                return _invalid("BROKEN_LINK", index)
            core = {k: v for k, v in record.items() if k != "recordHash"}
            if hash_evidence_record_core(core) != record["recordHash"]:
                return _invalid("RECORD_HASH_MISMATCH", index)

        return {
            "valid": True,
            "count": len(chain),
            "lastRecordHash": chain[-1]["recordHash"],
            "context": {k: first[k] for k in _CONTEXT_KEYS},
        }
    except Exception:  # noqa: BLE001 — fail closed on anything unexpected
        return _invalid("MALFORMED_CHAIN", None)
