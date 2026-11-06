"""guardian-canonical-json.v1 — byte-identical to the TypeScript implementation.

Mirrors ``packages/sdk/src/contracts/canonical-json.ts``:

* object keys sorted by UTF-16 code units (JavaScript ``Array.prototype.sort``);
* strings escaped exactly like ``JSON.stringify``;
* numbers rendered exactly like JavaScript ``Number.prototype.toString``
  (``-0`` becomes ``0``, non-finite numbers are rejected);
* depth limit 64, node budget 100 000, cycles rejected.

Golden vectors generated from the TypeScript implementation live in
``tests/fixtures/canonical-json.json``.
"""

from __future__ import annotations

import hashlib
import math
from decimal import Decimal
from typing import Any

__all__ = ["canonical_json", "canonical_sha256", "sha256_text", "CanonicalJsonError"]

_MAX_NODES = 100_000
_MAX_DEPTH = 64


class CanonicalJsonError(TypeError):
    """The value cannot be represented in guardian-canonical-json.v1."""


_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def _js_string(value: str) -> str:
    out = ['"']
    for ch in value:
        code = ord(ch)
        if ch in _ESCAPES:
            out.append(_ESCAPES[ch])
        elif code < 0x20 or 0xD800 <= code <= 0xDFFF:
            # Control characters and lone surrogates: lowercase \\uXXXX.
            out.append(f"\\u{code:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _js_number(value: float | int) -> str:
    """ECMAScript Number::toString(10) for a finite double."""
    number = float(value)
    if not math.isfinite(number):
        raise CanonicalJsonError("Canonical JSON does not permit non-finite numbers")
    if number == 0:
        return "0"  # also normalizes -0
    sign = "-" if number < 0 else ""
    # repr() is the shortest round-trip representation — the same digits
    # JavaScript selects. Re-render them with JavaScript's layout rules.
    decimal = Decimal(repr(abs(number)))
    _, digit_tuple, exponent = decimal.as_tuple()
    digits = "".join(str(d) for d in digit_tuple).lstrip("0")
    trailing = len(digits) - len(digits.rstrip("0"))
    digits = digits.rstrip("0")
    exponent = int(exponent) + trailing
    k = len(digits)
    n = exponent + k  # value = 0.digits × 10^n
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        mantissa = digits if k == 1 else digits[0] + "." + digits[1:]
        body = f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"
    return sign + body


def _utf16_key(key: str) -> bytes:
    return key.encode("utf-16-be", "surrogatepass")


def _serialize(value: Any, ancestors: set[int], depth: int, budget: list[int]) -> str:
    budget[0] -= 1
    if budget[0] < 0:
        raise CanonicalJsonError("Canonical JSON exceeds maximum node count")
    if depth > _MAX_DEPTH:
        raise CanonicalJsonError("Canonical JSON exceeds maximum depth")
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _js_string(value)
    if isinstance(value, (int, float)):
        return _js_number(value)
    if isinstance(value, (list, tuple)):
        marker = id(value)
        if marker in ancestors:
            raise CanonicalJsonError("Canonical JSON rejects cycles")
        ancestors.add(marker)
        try:
            return "[" + ",".join(_serialize(v, ancestors, depth + 1, budget) for v in value) + "]"
        finally:
            ancestors.discard(marker)
    if isinstance(value, dict):
        marker = id(value)
        if marker in ancestors:
            raise CanonicalJsonError("Canonical JSON rejects cycles")
        if any(not isinstance(k, str) for k in value):
            raise CanonicalJsonError("Canonical JSON accepts only string keys")
        ancestors.add(marker)
        try:
            keys = sorted(value.keys(), key=_utf16_key)
            return (
                "{"
                + ",".join(
                    _js_string(k) + ":" + _serialize(value[k], ancestors, depth + 1, budget)
                    for k in keys
                )
                + "}"
            )
        finally:
            ancestors.discard(marker)
    raise CanonicalJsonError(f"Canonical JSON rejects {type(value).__name__}")


def canonical_json(value: Any) -> str:
    """Serialize ``value`` as guardian-canonical-json.v1."""
    return _serialize(value, set(), 0, [_MAX_NODES])


def canonical_sha256(value: Any) -> str:
    """Hex SHA-256 of the canonical JSON (UTF-8)."""
    return hashlib.sha256(canonical_json(value).encode("utf-8", "surrogatepass")).hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
