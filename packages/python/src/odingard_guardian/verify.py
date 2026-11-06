"""Verify, don't trust: the check a receiver runs before acting.

Python port of ``verifyBeforeActing`` in ``@odingard/guardian-sdk``. For the
side that receives an agent's request (a bank moving money, a merchant
taking a payment, another agent). It returns ``{"ok": True, ...}`` only when
all of these hold:

1. the receipt is a genuine ``greceipt.v1``, valid offline;
2. the request in front of the receiver equals the authorized action's
   parameters, field for field;
3. Guardian allowed it, or a person approved it;
4. a capability was issued, and it is not revoked, expired or used;
5. amount, destination and currency equal what the receiver expects;
6. the receipt is fresh, within the receiver's window;
7. the receiver has not already acted on this request (``seen_request_ids``);
8. optionally, Guardian still reports the authorization active (``status``).

Anything else returns ``{"ok": False, "reasonCode": ..., "detail": ...}``.
Verdicts match the TypeScript SDK (golden fixtures in
``tests/fixtures/verify-before-acting.json``).
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Callable, Container, Optional
from urllib.parse import parse_qs

import httpx

from ._canonical import canonical_json
from .receipts import verify_receipt_offline

DEFAULT_RECEIPT_MAX_AGE_MS = 300_000
_CLOCK_SKEW_MS = 60_000
RECEIPT_STATUSES = ("active", "pending", "revoked", "expired", "used", "paused", "unknown")


def _refuse(code: str, detail: str) -> dict:
    return {"ok": False, "reasonCode": code, "detail": detail}


def _same_canonical(a: Any, b: Any) -> bool:
    try:
        return canonical_json(a) == canonical_json(b)
    except Exception:  # noqa: BLE001 — unreadable never matches
        return False


def _root_key_count(text: str, key: str) -> int:
    """How many times ``key`` is a key of the root JSON object."""
    depth = 0
    count = 0
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in "{[":
            depth += 1
        elif ch in "}]":
            depth -= 1
        elif ch == '"':
            end = i + 1
            while end < n and text[end] != '"':
                end += 2 if text[end] == "\\" else 1
            if depth == 1:
                nxt = end + 1
                while nxt < n and text[nxt].isspace():
                    nxt += 1
                if nxt < n and text[nxt] == ":":
                    try:
                        name = json.loads(text[i : end + 1])
                    except ValueError:
                        name = None
                    if name == key:
                        count += 1
            i = end
        i += 1
    return count


_MISSING = object()
_AMBIGUOUS = object()
_MAX_SAFE_INTEGER = 2**53 - 1
_AMOUNT_TEXT = re.compile(r"0|[1-9][0-9]{0,15}")


# JavaScript's String.prototype.trim whitespace (Python's strip() also drops \x1c-\x1f and \x85).
_JS_SPACE = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
    "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def _as_text(value: Any, allow_integer: bool) -> Any:
    """A string as is; a JSON integer as text when allowed; else _AMBIGUOUS."""
    if isinstance(value, str):
        return value
    # A bool is not an amount. A float like 100.0 is an integer in JSON (as in JS).
    if allow_integer and isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and not value.is_integer():
            return _AMBIGUOUS
        if 0 <= value <= _MAX_SAFE_INTEGER:
            return str(int(value))
    return _AMBIGUOUS


def _no_constant(name: str) -> Any:
    # JSON.parse rejects NaN, Infinity and -Infinity.
    raise ValueError(name)


def _js_int(text: str) -> Any:
    # JSON.parse reads every number as a double; a huge integer is not an error.
    return int(text) if len(text) <= 20 else float(text)


def _decode(text: str) -> Any:
    return json.loads(text, parse_int=_js_int, parse_constant=_no_constant)


_JSON_WS = re.compile(r"[ \t\n\r]*")
_JSON_STRING = r'"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"'
_JSON_KEY = re.compile(_JSON_STRING)
_JSON_SCALAR = re.compile(
    _JSON_STRING + r"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null"
)


def _parse_json_deep(text: str) -> Any:
    """JSON.parse without recursion, for bodies nested past Python's limit."""
    n = len(text)
    stack: list = []  # [container, pending key]

    def ws(i: int) -> int:
        return _JSON_WS.match(text, i).end()

    def key(i: int, frame: list) -> int:
        m = _JSON_KEY.match(text, i)
        if not m:
            raise ValueError("key")
        frame[1] = _decode(m.group())
        i = ws(m.end())
        if text[i : i + 1] != ":":
            raise ValueError("colon")
        return ws(i + 1)

    i = ws(0)
    while True:
        ch = text[i : i + 1]
        if ch in ("{", "["):
            j = ws(i + 1)
            if text[j : j + 1] == ("}" if ch == "{" else "]"):
                value: Any = {} if ch == "{" else []
                i = j + 1
            else:
                frame = [{} if ch == "{" else [], None]
                stack.append(frame)
                i = key(j, frame) if ch == "{" else j
                continue
        else:
            m = _JSON_SCALAR.match(text, i)
            if not m:
                raise ValueError("value")
            value = _decode(m.group())
            i = m.end()
        while True:
            i = ws(i)
            if not stack:
                if i != n:
                    raise ValueError("trailing")
                return value
            frame = stack[-1]
            container = frame[0]
            if isinstance(container, dict):
                container[frame[1]] = value
            else:
                container.append(value)
            ch = text[i : i + 1]
            if ch == ",":
                i = ws(i + 1)
                if isinstance(container, dict):
                    i = key(i, frame)
                break
            if ch == ("}" if isinstance(container, dict) else "]"):
                stack.pop()
                value = container
                i += 1
                continue
            raise ValueError("close")


def _parse_json(body: str) -> Any:
    """The body as JSON.parse reads it; _AMBIGUOUS if JSON.parse would throw."""
    try:
        return _decode(body)
    except RecursionError:
        pass
    except ValueError:
        return _AMBIGUOUS
    try:
        return _parse_json_deep(body)
    except ValueError:
        return _AMBIGUOUS


_UTF8_CHARSET = re.compile(r'charset="?utf-8"?')


def _parse_qs(body: str) -> dict:
    # Only "&" separates, as in URLSearchParams (needs Python 3.9.2+).
    return parse_qs(body, keep_blank_values=True, separator="&")


def _read_field(action: str, parameters: Any, field: str, allow_integer: bool = False) -> Any:
    """The field's string value; _MISSING if absent; _AMBIGUOUS if unreadable.

    ``allow_integer`` also accepts a JSON integer (amounts); currencies must be strings.
    """
    if not isinstance(parameters, dict):
        return _AMBIGUOUS
    if action != "api.request":
        if field not in parameters:
            return _MISSING
        return _as_text(parameters[field], allow_integer)
    body = parameters.get("body") if isinstance(parameters.get("body"), str) else ""
    headers = parameters.get("headers") if isinstance(parameters.get("headers"), list) else []
    type_values = []
    for header in headers:
        name = header.get("name") if isinstance(header, dict) else None
        value = header.get("value") if isinstance(header, dict) else None
        # A header that is not a plain name and value cannot be read safely.
        if not isinstance(name, str) or not isinstance(value, str):
            return _AMBIGUOUS
        if name.lower() == "content-type":
            type_values.append(value)
    # Missing or repeated content-type: unreadable.
    if len(type_values) != 1:
        return _AMBIGUOUS
    raw_type, *type_params = type_values[0].strip(_JS_SPACE).lower().split(";")
    media_type = raw_type.strip(_JS_SPACE)
    is_json = media_type in ("application/json", "text/json") or media_type.endswith("+json")
    # Read the body only for a known JSON or form type; anything else is
    # unreadable, so the receiver cannot parse it differently.
    if not is_json and media_type != "application/x-www-form-urlencoded":
        return _AMBIGUOUS
    # The body is decoded as UTF-8. A receiver honouring another charset could
    # decode different keys and values, so only no parameter or charset=utf-8 is read.
    params = [p.strip(_JS_SPACE) for p in type_params]
    params = [p for p in params if p != ""]
    if len(params) > 1 or (len(params) == 1 and not _UTF8_CHARSET.fullmatch(params[0])):
        return _AMBIGUOUS
    if is_json:
        value = _parse_json(body)
        if value is _AMBIGUOUS or not isinstance(value, dict):
            return _AMBIGUOUS
        if _root_key_count(body, field) > 1:
            return _AMBIGUOUS
        if field not in value:
            return _MISSING
        return _as_text(value[field], allow_integer)
    # URLSearchParams drops one leading "?" and splits only on "&".
    if body.startswith("?"):
        body = body[1:]
    parsed = _parse_qs(body)
    # Some servers (Rack) also strip spaces around keys, so " amount" may be a
    # second amount to them: ambiguous.
    if any(key != field and key.strip(_JS_SPACE) == field for key in parsed):
        return _AMBIGUOUS
    values = parsed.get(field, [])
    if not values:
        return _MISSING
    return values[0] if len(values) == 1 else _AMBIGUOUS


def verify_before_acting(
    receipt: Any,
    keys: Any,
    expected: dict,
    *,
    now_epoch_ms: Optional[int] = None,
    max_age_ms: int = DEFAULT_RECEIPT_MAX_AGE_MS,
    seen_request_ids: Optional[Container[str]] = None,
    status: Optional[Callable[[Any], dict]] = None,
) -> dict:
    """Check a receipt against the exact request the receiver got.

    ``expected`` keys: ``material_parameters`` (required: the request as
    received), and optionally ``action``, ``value_cents``, ``amount_field``,
    ``merchant_id``, ``currency``, ``currency_field`` (default ``"currency"``).

    ``amount_field`` names where the amount is in the signed request (e.g.
    ``"amount"`` for Stripe); it must equal any declared value. With no
    declared value it is accepted only when a person approved the request.

    ``status`` is an optional callable, e.g.
    ``lambda r: fetch_receipt_status(base_url, r)``; anything but
    ``{"ok": True, "status": "active"}`` refuses, and so does an exception.
    """
    verified = verify_receipt_offline(receipt, keys)
    if not verified.get("valid"):
        return _refuse(
            "RECEIPT_INVALID",
            f"The receipt is not a valid Guardian receipt ({verified.get('reasonCode', 'invalid')}).",
        )
    action = receipt["action"]

    want_action = expected.get("action")
    if want_action is not None and action.get("action") != want_action:
        return _refuse("ACTION_MISMATCH", f"The receipt authorizes {action.get('action')}, not {want_action}.")
    if not _same_canonical(action.get("materialParameters"), expected.get("material_parameters")):
        return _refuse("REQUEST_MISMATCH", "The request received is not the request Guardian authorized.")

    decision = receipt["decision"]["decision"]
    if decision == "DENY":
        return _refuse("NOT_AUTHORIZED", "Guardian denied this request.")
    approval = receipt.get("approval")
    approved_by_human = isinstance(approval, dict) and approval.get("state") == "approved"
    if decision == "ASK" and not approved_by_human:
        return _refuse("NOT_APPROVED", "No person has approved this request.")
    if isinstance(approval, dict) and approval.get("state") == "revoked":
        return _refuse("REVOKED", "The approval was revoked.")

    capability = receipt.get("capability")
    if capability is None:
        return _refuse("NOT_ISSUED", "Guardian has not issued an authorization for this request.")
    state = capability.get("state")
    if state == "revoked":
        return _refuse("REVOKED", "The authorization was revoked.")
    if state == "expired":
        return _refuse("EXPIRED", "The authorization expired.")
    if state == "used" or receipt["effect"]["kind"] != "none":
        return _refuse("ALREADY_USED", "This authorization was already used.")

    now = int(time.time() * 1000) if now_epoch_ms is None else now_epoch_ms
    issued = receipt["issuedAtEpochMs"]
    if issued > now + _CLOCK_SKEW_MS:
        return _refuse("NOT_YET_VALID", "The receipt is dated in the future.")
    if now - issued > max_age_ms:
        return _refuse("STALE", "The receipt is older than this receiver accepts.")
    if action["expiresAtEpochMs"] <= now:
        return _refuse("EXPIRED", "The authorized request window has closed.")
    if capability["claims"]["expiresAtEpochMs"] <= now:
        return _refuse("EXPIRED", "The authorization expired.")

    value_cents = action.get("valueCents")
    amount_field = expected.get("amount_field")
    if amount_field is not None:
        read = _read_field(action.get("action"), expected.get("material_parameters"), amount_field, True)
        amount = None
        if isinstance(read, str) and _AMOUNT_TEXT.fullmatch(read.strip(_JS_SPACE)):
            amount = int(read.strip(_JS_SPACE))
        if amount is None or amount > _MAX_SAFE_INTEGER:
            return _refuse("AMOUNT_NOT_AUTHORIZED", "The authorized request states no single, readable amount.")
        if value_cents is not None and value_cents != amount:
            return _refuse("AMOUNT_MISMATCH", "The request's amount is not the amount Guardian authorized.")
        # With no declared value, Guardian never checked this amount against a
        # cap or an ask threshold. Only a person who approved this exact
        # request (the approval shows its body) authorized the amount.
        if value_cents is None and not approved_by_human:
            return _refuse(
                "AMOUNT_NOT_AUTHORIZED", "No person approved this amount, and Guardian checked it against no cap."
            )
        value_cents = amount
    want_value = expected.get("value_cents")
    if want_value is not None:
        if value_cents is None:
            return _refuse("AMOUNT_NOT_AUTHORIZED", "Guardian authorized no amount for this request.")
        # A bool is not an amount (Python treats True as 1).
        if isinstance(want_value, bool) or value_cents != want_value:
            return _refuse(
                "AMOUNT_MISMATCH", f"Guardian authorized {value_cents} cents, not {json.dumps(want_value)}."
            )
    merchant_id = action.get("merchantId")
    want_merchant = expected.get("merchant_id")
    if want_merchant is not None and merchant_id != want_merchant:
        return _refuse("DESTINATION_MISMATCH", "Guardian authorized a different destination.")
    currency = None
    want_currency = expected.get("currency")
    if want_currency is not None:
        read = _read_field(
            action.get("action"), expected.get("material_parameters"), expected.get("currency_field", "currency")
        )
        if read is _MISSING:
            return _refuse("CURRENCY_MISSING", "The request names no currency.")
        if (
            read is _AMBIGUOUS
            or read.strip(_JS_SPACE).lower() != str(want_currency).strip(_JS_SPACE).lower()
        ):
            return _refuse("CURRENCY_MISMATCH", "The request's currency is not the one expected.")
        currency = read.strip(_JS_SPACE).lower()

    request_id = receipt["subject"]["requestId"]
    if seen_request_ids is not None and request_id in seen_request_ids:
        return _refuse("REPLAYED", "This receiver already acted on this request.")

    if status is not None:
        try:
            reply = status(receipt)
        except Exception:  # noqa: BLE001 — a failed check refuses
            reply = {"ok": False, "reasonCode": "SERVICE_UNAVAILABLE"}
        if not isinstance(reply, dict) or reply.get("ok") is not True:
            return _refuse(
                "STATUS_UNAVAILABLE", "Guardian could not confirm the authorization is still in force."
            )
        if reply.get("status") != "active":
            return _refuse(
                "STATUS_NOT_ACTIVE", f"Guardian reports this authorization as {reply.get('status')}."
            )

    return {
        "ok": True,
        "requestId": request_id,
        "receiptId": receipt["receiptId"],
        "materialDigest": action["materialDigest"],
        "decision": decision,
        "approvedByHuman": approved_by_human,
        "valueCents": value_cents,
        "merchantId": merchant_id,
        "currency": currency,
    }


def fetch_receipt_status(
    base_url: str,
    receipt: Any,
    *,
    transport: Optional[httpx.BaseTransport] = None,
    timeout: float = 15.0,
) -> dict:
    """Ask Guardian whether the authorization behind a receipt is still in force.

    Public: the receipt itself is the credential. Returns
    ``{"ok": True, "status": ...}`` (a status only, never identities) or
    ``{"ok": False, "reasonCode": ...}``.
    """
    try:
        with httpx.Client(transport=transport, timeout=timeout) as http:
            response = http.post(
                f"{base_url.rstrip('/')}/v1/receipts/status", json={"receipt": receipt}
            )
        body = response.json() if response.content else None
    except (httpx.HTTPError, ValueError, TypeError):
        # TypeError: the receipt could not be serialized as JSON.
        return {"ok": False, "reasonCode": "SERVICE_UNAVAILABLE"}
    if (
        response.is_success
        and isinstance(body, dict)
        and body.get("ok") is True
        and body.get("status") in RECEIPT_STATUSES
    ):
        return {"ok": True, "status": body["status"]}
    code = body.get("reasonCode") if isinstance(body, dict) else None
    return {"ok": False, "reasonCode": code if isinstance(code, str) else f"HTTP_{response.status_code}"}
