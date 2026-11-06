"""Portable receipt (``greceipt.v1``) verification.

Offline verification needs only the receipt and Guardian's published Ed25519
verification keys — no agent credential, account or Guardian service. It is a
port of ``verifyPortableAuthorityReceipt``
(``packages/sdk/src/evidence/receipt.ts``): the signature is checked
over the guardian-canonical-json.v1 receipt body, the embedded evidence chain
is re-derived record by record, and every embedded object (subject, action,
decision, approval, capability, execution, effect) is cross-checked against
it. Results and reason codes are identical to the TypeScript SDK; golden
fixtures generated from it live in ``tests/fixtures/receipts.json``.

Schema scope: the receipt envelope is validated structurally (every
top-level field, literal, identifier and enum the TypeScript schema
requires at that level). The deeply nested action/approval/execution record
schemas are not re-validated field by field. Those objects are covered by
the signature and by the digest re-derivation, so a forged or altered
receipt still fails. Verification is never billable.
"""

from __future__ import annotations

import base64
import re
from typing import Any, Optional

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from ._canonical import canonical_json, canonical_sha256
from ._evidence import verify_evidence_chain

__all__ = [
    "PORTABLE_RECEIPT_DOMAIN",
    "verify_receipt_offline",
    "fetch_receipt_verification_keys",
    "afetch_receipt_verification_keys",
    "verify_receipt_online",
    "averify_receipt_online",
    "approval_record_digest",
    "capability_claims_digest",
]

PORTABLE_RECEIPT_DOMAIN = "odingard.guardian.receipt.v1"

_BODY_KEYS = {
    "format",
    "schemaVersion",
    "receiptId",
    "issuedAtEpochMs",
    "subject",
    "runtime",
    "action",
    "delegationChain",
    "decision",
    "approval",
    "capability",
    "execution",
    "effect",
    "evidence",
    "generatedBy",
}
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_KEY_ID = re.compile(r"^rkey_[a-f0-9]{16,64}$")
_RECEIPT_ID = re.compile(r"^rcp_[A-Za-z0-9][A-Za-z0-9_-]{7,119}$")
_GRANT_ID = re.compile(r"^grt_[A-Za-z0-9][A-Za-z0-9_-]{7,119}$")
_X = re.compile(r"^[A-Za-z0-9_-]{43,44}$")
_SIG = re.compile(r"^[A-Za-z0-9_-]{86}$")


def _fail(reason: str) -> dict:
    return {"valid": False, "reasonCode": reason}


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _strict(obj: Any, keys: set) -> bool:
    return isinstance(obj, dict) and set(obj.keys()) == keys


def _is_digest(value: Any) -> bool:
    return isinstance(value, str) and bool(_SHA256.match(value))


def _nullable_digest(value: Any) -> bool:
    return value is None or _is_digest(value)


def _envelope_ok(receipt: Any) -> bool:
    if not isinstance(receipt, dict) or set(receipt.keys()) != _BODY_KEYS | {"proof"}:
        return False
    r = receipt
    if r["format"] != "greceipt.v1" or r["schemaVersion"] != 1:
        return False
    if r["generatedBy"] != "guardian-control-plane":
        return False
    if not isinstance(r["receiptId"], str) or not _RECEIPT_ID.match(r["receiptId"]):
        return False
    if not _is_int(r["issuedAtEpochMs"]) or r["issuedAtEpochMs"] < 0:
        return False
    if not _strict(
        r["subject"], {"tenantId", "principalId", "agentId", "requestId", "correlationId"}
    ) or not all(isinstance(v, str) and v for v in r["subject"].values()):
        return False
    rt = r["runtime"]
    if not _strict(rt, {"interface", "requestedAdapterId", "adapterId"}):
        return False
    if not isinstance(rt["requestedAdapterId"], str) or not (
        rt["adapterId"] is None or isinstance(rt["adapterId"], str)
    ):
        return False
    if not isinstance(r["action"], dict):
        return False
    dc = r["delegationChain"]
    if not isinstance(dc, list) or len(dc) > 32:
        return False
    for grant in dc:
        if not _strict(grant, {"grantId", "version"}):
            return False
        if not isinstance(grant["grantId"], str) or not _GRANT_ID.match(grant["grantId"]):
            return False
        if not _is_int(grant["version"]) or grant["version"] < 1:
            return False
    d = r["decision"]
    if not _strict(d, {"decision", "reasonCode", "actionDecisionDigest", "decidedAtEpochMs"}):
        return False
    if d["decision"] not in ("ALLOW", "ASK", "DENY") or not isinstance(d["reasonCode"], str):
        return False
    if not _is_digest(d["actionDecisionDigest"]) or not _is_int(d["decidedAtEpochMs"]):
        return False
    # A non-DENY decision requires a non-empty delegation chain.
    if d["decision"] != "DENY" and len(dc) == 0:
        return False
    a = r["approval"]
    if a is not None:
        if not _strict(a, {"approvalId", "state", "version", "approvalDigest", "record"}):
            return False
        if not _is_int(a["version"]) or a["version"] < 1 or not _is_digest(a["approvalDigest"]):
            return False
        if not isinstance(a["record"], dict):
            return False
    c = r["capability"]
    if c is not None:
        if not _strict(c, {"capabilityId", "claims", "claimsDigest", "state"}):
            return False
        if c["state"] not in ("issued", "used", "expired", "revoked"):
            return False
        if not _is_digest(c["claimsDigest"]) or not isinstance(c["claims"], dict):
            return False
    if r["execution"] is not None and not isinstance(r["execution"], dict):
        return False
    e = r["effect"]
    if not _strict(e, {"kind", "terminalEvent", "failureCode", "effectDigest", "failureDigest"}):
        return False
    if e["kind"] not in ("verified", "failed", "outcome-pending", "none"):
        return False
    if e["terminalEvent"] not in (None, "EFFECT_VERIFIED", "EXECUTION_FAILED", "EXECUTION_ABORTED"):
        return False
    if not (e["failureCode"] is None or (isinstance(e["failureCode"], str) and len(e["failureCode"]) <= 128)):
        return False
    if not _nullable_digest(e["effectDigest"]) or not _nullable_digest(e["failureDigest"]):
        return False
    ev = r["evidence"]
    if not _strict(ev, {"chain", "recordCount", "headRecordHash"}):
        return False
    if not isinstance(ev["chain"], list) or not (1 <= len(ev["chain"]) <= 10_000):
        return False
    if not _is_int(ev["recordCount"]) or not (1 <= ev["recordCount"] <= 10_000):
        return False
    if not _is_digest(ev["headRecordHash"]):
        return False
    p = r["proof"]
    if not _strict(p, {"algorithm", "canonicalization", "domain", "keyId", "signature"}):
        return False
    return (
        p["algorithm"] == "Ed25519"
        and p["canonicalization"] == "guardian-canonical-json.v1"
        and p["domain"] == PORTABLE_RECEIPT_DOMAIN
        and isinstance(p["keyId"], str)
        and bool(_KEY_ID.match(p["keyId"]))
        and isinstance(p["signature"], str)
        and bool(_SIG.match(p["signature"]))
    )


def _keys_ok(keys: Any) -> bool:
    if not _strict(keys, {"keys"}) or not isinstance(keys["keys"], list):
        return False
    if not (1 <= len(keys["keys"]) <= 8):
        return False
    for jwk in keys["keys"]:
        if not _strict(jwk, {"kty", "crv", "kid", "use", "alg", "x"}):
            return False
        if (jwk["kty"], jwk["crv"], jwk["use"], jwk["alg"]) != ("OKP", "Ed25519", "sig", "EdDSA"):
            return False
        if not isinstance(jwk["kid"], str) or not _KEY_ID.match(jwk["kid"]):
            return False
        if not isinstance(jwk["x"], str) or not _X.match(jwk["x"]):
            return False
    return True


def _b64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def approval_record_digest(record: Any) -> str:
    return canonical_sha256({"domain": "odingard.guardian.approval-record.v1", "record": record})


def capability_claims_digest(claims: Any) -> str:
    return canonical_sha256({"domain": "odingard.guardian.capability-claims.v1", "claims": claims})


def verify_receipt_offline(receipt: Any, keys: Any) -> dict:
    """Verify a portable receipt locally against a published key set.

    Pure: no network. ``keys`` may be the published key set (``{"keys": [...]}``)
    or the result of :func:`fetch_receipt_verification_keys` as returned
    (``{"ok": True, "keys": ...}``); a failed fetch result never verifies.
    Returns ``{"valid": True, "subject": …, "decision": …, "effect": …}`` or
    ``{"valid": False, "reasonCode": …}``.
    """
    if isinstance(keys, dict) and "ok" in keys:
        keys = keys.get("keys") if keys.get("ok") is True else None
    try:
        return _verify(receipt, keys)
    except Exception:  # noqa: BLE001 — fail closed
        return _fail("MALFORMED_RECEIPT")


def _verify(receipt: Any, keys: Any) -> dict:
    if not _envelope_ok(receipt):
        return _fail("MALFORMED_RECEIPT")
    if not _keys_ok(keys):
        return _fail("MALFORMED_RECEIPT")
    proof = receipt["proof"]
    body = {k: v for k, v in receipt.items() if k != "proof"}

    jwk = next((k for k in keys["keys"] if k["kid"] == proof["keyId"]), None)
    if jwk is None:
        return _fail("UNKNOWN_KEY")
    try:
        public_key = Ed25519PublicKey.from_public_bytes(_b64url(jwk["x"]))
        message = canonical_json({"domain": PORTABLE_RECEIPT_DOMAIN, "receipt": body}).encode(
            "utf-8", "surrogatepass"
        )
        public_key.verify(_b64url(proof["signature"]), message)
    except (InvalidSignature, ValueError, TypeError):
        return _fail("SIGNATURE_INVALID")

    chain = receipt["evidence"]["chain"]
    verdict = verify_evidence_chain(chain)
    if not verdict["valid"] or verdict["context"] is None:
        return _fail("EVIDENCE_CHAIN_INVALID")
    context = verdict["context"]
    subject = receipt["subject"]
    ctx_keys = ("tenantId", "principalId", "agentId", "requestId", "correlationId")
    if any(context[k] != subject[k] for k in ctx_keys):
        return _fail("SUBJECT_MISMATCH")
    if (
        verdict["lastRecordHash"] != receipt["evidence"]["headRecordHash"]
        or len(chain) != receipt["evidence"]["recordCount"]
    ):
        return _fail("EVIDENCE_HEAD_MISMATCH")

    action = receipt["action"]
    if any(action.get(k) != subject[k] for k in ctx_keys):
        return _fail("ACTION_MISMATCH")
    grants = [
        {"grantId": g.get("id"), "version": g.get("version")}
        for g in action["authority"]["evaluatedGrants"]
    ]
    if canonical_sha256(grants) != canonical_sha256(receipt["delegationChain"]):
        return _fail("ACTION_MISMATCH")
    if (
        action.get("interface") != receipt["runtime"]["interface"]
        or action.get("requestedAdapterId") != receipt["runtime"]["requestedAdapterId"]
    ):
        return _fail("ACTION_MISMATCH")

    bound_action_digest: Optional[str] = None
    decision_event: Optional[dict] = None
    latest_approval: Optional[dict] = None
    capability_events: dict = {}
    execution_event: Optional[dict] = None
    terminal_event: Optional[dict] = None

    for record in chain:
        event_type = record["event"]["eventType"]
        payload = record["event"]["payload"]
        if "actionDigest" in payload and payload["actionDigest"] is not None:
            if bound_action_digest is None:
                bound_action_digest = payload["actionDigest"]
            if payload["actionDigest"] != bound_action_digest:
                return _fail("ACTION_MISMATCH")
        if event_type == "DECISION_RECORDED":
            decision_event = {**payload, "at": record["eventTimeEpochMs"]}
        if event_type == "REQUEST_DENIED":
            decision_event = {
                "decision": "DENY",
                "reasonCode": payload.get("reasonCode"),
                "actionDecisionDigest": payload.get("requestDeniedDigest"),
                "at": record["eventTimeEpochMs"],
            }
        if event_type == "APPROVAL_STATE_REFERENCED":
            latest_approval = payload
        if event_type == "CAPABILITY_STATE_REFERENCED":
            capability_events[payload.get("capabilityId")] = payload
        if event_type == "EXECUTION_ATTEMPTED":
            execution_event = {
                "adapterId": payload.get("adapterId"),
                "attemptId": payload.get("attemptReference"),
            }
        if event_type in ("EFFECT_VERIFIED", "EXECUTION_FAILED", "EXECUTION_ABORTED"):
            terminal_event = {
                "kind": event_type,
                "failureCode": payload.get("failureCode") if event_type == "EXECUTION_FAILED" else None,
                "effectDigest": payload.get("effectDigest") if event_type == "EFFECT_VERIFIED" else None,
                "failureDigest": (payload.get("failureDigest") if event_type == "EXECUTION_FAILED" else None),
            }

    if bound_action_digest != action.get("materialDigest"):
        return _fail("ACTION_MISMATCH")
    decision = receipt["decision"]
    if (
        decision_event is None
        or decision_event.get("decision") != decision["decision"]
        or decision_event.get("reasonCode") != decision["reasonCode"]
        or decision_event.get("actionDecisionDigest") != decision["actionDecisionDigest"]
        or decision_event.get("at") != decision["decidedAtEpochMs"]
    ):
        return _fail("DECISION_MISMATCH")

    approval = receipt["approval"]
    if latest_approval is None:
        if approval is not None:
            return _fail("APPROVAL_MISMATCH")
    else:
        record = approval.get("record") if approval else None
        binding = record.get("binding", {}) if isinstance(record, dict) else {}
        if (
            approval is None
            or approval["approvalId"] != latest_approval.get("approvalId")
            or approval["state"] != latest_approval.get("state")
            or approval["version"] != latest_approval.get("version")
            or approval["approvalDigest"] != latest_approval.get("approvalDigest")
            or approval_record_digest(record) != approval["approvalDigest"]
            or binding.get("approvalId") != approval["approvalId"]
            or binding.get("actionDigest") != action.get("materialDigest")
        ):
            return _fail("APPROVAL_MISMATCH")

    capability = receipt["capability"]
    if not capability_events:
        if capability is not None:
            return _fail("CAPABILITY_MISMATCH")
    else:
        event = capability_events.get(capability["capabilityId"]) if capability else None
        claims = capability["claims"] if capability else {}
        if (
            capability is None
            or event is None
            or capability_claims_digest(claims) != capability["claimsDigest"]
            or capability["claimsDigest"] != event.get("capabilityDigest")
            or claims.get("actionDigest") != action.get("materialDigest")
            or claims.get("tenantId") != subject["tenantId"]
            or claims.get("agentId") != subject["agentId"]
            or claims.get("requestId") != subject["requestId"]
        ):
            return _fail("CAPABILITY_MISMATCH")

    execution = receipt["execution"]
    if execution_event is None:
        if execution is not None:
            return _fail("EXECUTION_MISMATCH")
    else:
        if (
            execution is None
            or execution.get("attemptId") != execution_event["attemptId"]
            or execution.get("adapterId") != execution_event["adapterId"]
            or execution.get("actionDigest") != action.get("materialDigest")
            or execution.get("tenantId") != subject["tenantId"]
            or execution.get("requestId") != subject["requestId"]
            or (capability is not None and execution.get("capabilityId") != capability["capabilityId"])
        ):
            return _fail("EXECUTION_MISMATCH")
        if execution.get("adapterId") != receipt["runtime"]["adapterId"]:
            return _fail("EXECUTION_MISMATCH")

    effect = receipt["effect"]
    if terminal_event is None:
        if effect["kind"] not in ("none", "outcome-pending"):
            return _fail("EFFECT_MISMATCH")
        if (effect["kind"] == "none") != (execution_event is None and execution is None):
            return _fail("EFFECT_MISMATCH")
    else:
        expected_kind = "verified" if terminal_event["kind"] == "EFFECT_VERIFIED" else "failed"
        if (
            effect["terminalEvent"] != terminal_event["kind"]
            or effect["failureCode"] != terminal_event["failureCode"]
            or effect["effectDigest"] != terminal_event["effectDigest"]
            or effect["failureDigest"] != terminal_event["failureDigest"]
            or effect["kind"] != expected_kind
        ):
            return _fail("EFFECT_MISMATCH")
        if terminal_event["kind"] == "EFFECT_VERIFIED" and execution:
            outcome = execution.get("outcome")
            if isinstance(outcome, dict) and outcome.get("kind") == "verified":
                recomputed = canonical_sha256(
                    {
                        "domain": "odingard.guardian.email-effect.v1",
                        "provider": execution.get("provider"),
                        "adapterId": execution.get("adapterId"),
                        "attemptId": execution.get("attemptId"),
                        "sentRefDigest": canonical_sha256(outcome.get("sentRef")),
                        "observedDigest": outcome.get("observedDigest"),
                        "level": outcome.get("level"),
                        "observedAtEpochMs": outcome.get("observedAtEpochMs"),
                    }
                )
                if recomputed != terminal_event["effectDigest"]:
                    return _fail("EFFECT_MISMATCH")

    return {
        "valid": True,
        "subject": subject,
        "decision": decision["decision"],
        "effect": effect["kind"],
    }


def _base(url: str) -> str:
    return url.rstrip("/")


_KEY_ID = re.compile(r"^rkey_[A-Za-z0-9_-]{1,128}$")


def _keys_url(base_url: str, kid: Optional[str], for_receipt: Any) -> str:
    if kid is None and isinstance(for_receipt, dict) and isinstance(for_receipt.get("proof"), dict):
        kid = for_receipt["proof"].get("keyId")
    url = f"{_base(base_url)}/v1/receipts/verification-keys"
    if isinstance(kid, str) and _KEY_ID.match(kid):
        url += f"?kid={kid}"
    return url


def fetch_receipt_verification_keys(
    base_url: str,
    *,
    kid: Optional[str] = None,
    for_receipt: Any = None,
    transport: Optional[httpx.BaseTransport] = None,
    timeout: float = 15.0,
) -> dict:
    """Fetch the published verification key set (public; no credential).

    The published set holds Guardian's newest keys (at most 8). To verify a
    receipt signed by an older key, pass ``for_receipt=receipt`` (or ``kid``):
    the set returned then contains that receipt's signing key.

    Returns ``{"ok": True, "keys": {...}}`` or ``{"ok": False, "reasonCode": …}``.
    """
    try:
        with httpx.Client(transport=transport, timeout=timeout) as http:
            response = http.get(_keys_url(base_url, kid, for_receipt))
        body = response.json() if response.content else None
    except (httpx.HTTPError, ValueError):
        return {"ok": False, "reasonCode": "SERVICE_UNAVAILABLE"}
    if not response.is_success or not isinstance(body, dict) or not isinstance(body.get("keys"), list):
        return {"ok": False, "reasonCode": f"HTTP_{response.status_code}"}
    return {"ok": True, "keys": body}


async def afetch_receipt_verification_keys(
    base_url: str,
    *,
    kid: Optional[str] = None,
    for_receipt: Any = None,
    transport: Optional[httpx.AsyncBaseTransport] = None,
    timeout: float = 15.0,
) -> dict:
    """Async form of :func:`fetch_receipt_verification_keys`."""
    try:
        async with httpx.AsyncClient(transport=transport, timeout=timeout) as http:
            response = await http.get(_keys_url(base_url, kid, for_receipt))
        body = response.json() if response.content else None
    except (httpx.HTTPError, ValueError):
        return {"ok": False, "reasonCode": "SERVICE_UNAVAILABLE"}
    if not response.is_success or not isinstance(body, dict) or not isinstance(body.get("keys"), list):
        return {"ok": False, "reasonCode": f"HTTP_{response.status_code}"}
    return {"ok": True, "keys": body}


def verify_receipt_online(
    base_url: str,
    receipt: Any,
    *,
    transport: Optional[httpx.BaseTransport] = None,
    timeout: float = 15.0,
) -> dict:
    """Ask a Guardian deployment to verify a receipt (public endpoint)."""
    try:
        with httpx.Client(transport=transport, timeout=timeout) as http:
            response = http.post(f"{_base(base_url)}/v1/receipts/verify", json={"receipt": receipt})
        body = response.json() if response.content else None
    except (httpx.HTTPError, ValueError):
        return {"ok": False, "reasonCode": "SERVICE_UNAVAILABLE"}
    if not isinstance(body, dict):
        return {"ok": False, "reasonCode": f"HTTP_{response.status_code}"}
    return {"ok": True, "result": body}


async def averify_receipt_online(
    base_url: str,
    receipt: Any,
    *,
    transport: Optional[httpx.AsyncBaseTransport] = None,
    timeout: float = 15.0,
) -> dict:
    """Async form of :func:`verify_receipt_online`."""
    try:
        async with httpx.AsyncClient(transport=transport, timeout=timeout) as http:
            response = await http.post(
                f"{_base(base_url)}/v1/receipts/verify", json={"receipt": receipt}
            )
        body = response.json() if response.content else None
    except (httpx.HTTPError, ValueError):
        return {"ok": False, "reasonCode": "SERVICE_UNAVAILABLE"}
    if not isinstance(body, dict):
        return {"ok": False, "reasonCode": f"HTTP_{response.status_code}"}
    return {"ok": True, "result": body}
