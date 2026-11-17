"""Dollar amounts on tools: ``amount_args``.

A port of ``readToolAmount`` and the SDK's ``amountArgs`` handling
(``packages/sdk/src/contracts/tools.ts``, ``packages/sdk/src/guard.ts``).
The owner sets an amount declaration on a tool in the Guardian console; the
agent's integration echoes the same declaration on every call of that tool,
with the amount in cents when it can read it. Guardian reads the amount
itself and refuses the call unless the declaration equals the console's.
An amount the SDK cannot read is not sent, so Guardian refuses the call: it
is never read as zero.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Mapping, Optional, Tuple

from ._canonical import canonical_json
from .content_pins import CONTENT_PIN_KEY

__all__ = [
    "AMOUNT_CURRENCIES",
    "amount_facts",
    "amount_refusal_hint",
    "normalize_amount_args",
    "read_tool_amount",
]

#: Currencies a tool amount may be in (US dollars, counted in cents).
AMOUNT_CURRENCIES = ("usd",)
_ARGUMENT_NAME_MAX_LENGTH = 64
_ALLOWED_ARGUMENTS_MAX = 64
_CONTENT_PINS_MAX = 16
_MAX_SAFE_INTEGER = 9007199254740991
_MINOR_UNITS = re.compile(r"(0|[1-9][0-9]{0,15})")
_MAJOR_UNITS = re.compile(r"(0|[1-9][0-9]{0,12})(?:\.([0-9]{1,2}))?")
_PIN_SHA256 = re.compile(r"sha256:[0-9a-f]{64}")
_PIN_MODES = ("bytes", "copy", "recheck")
_KEYS = ("argument", "unit", "currency", "currencyArgument", "allowedArguments")


def _argument_name(value: Any) -> bool:
    return (
        isinstance(value, str)
        # Counted in UTF-16 code units, as the TypeScript schema counts them.
        and 0 < len(value.encode("utf-16-le")) // 2 <= _ARGUMENT_NAME_MAX_LENGTH
        and not any(ch in "./[]" or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value)
        and value != "__proto__"
    )


def _declaration(tool_name: str, value: Any) -> Dict[str, Any]:
    def bad() -> TypeError:
        return TypeError(
            f'amount_args for "{tool_name}" is not a valid amount declaration: use '
            '{"argument": ..., "unit": "minor" | "major", "currency": "usd"}, optionally with '
            '"currencyArgument" and "allowedArguments", exactly as set on the tool in the '
            "Guardian console."
        )

    if not isinstance(value, Mapping) or any(key not in _KEYS for key in value):
        raise bad()
    argument = value.get("argument")
    unit = value.get("unit")
    currency = value.get("currency")
    if not _argument_name(argument) or unit not in ("minor", "major") or currency != "usd":
        raise bad()
    declaration: Dict[str, Any] = {"argument": argument, "unit": unit, "currency": currency}
    if "currencyArgument" in value:
        currency_argument = value["currencyArgument"]
        if not _argument_name(currency_argument) or currency_argument == argument:
            raise bad()
        declaration["currencyArgument"] = currency_argument
    if "allowedArguments" in value:
        allowed = value["allowedArguments"]
        if (
            not isinstance(allowed, (list, tuple))
            or not 0 < len(allowed) <= _ALLOWED_ARGUMENTS_MAX
            or not all(_argument_name(name) for name in allowed)
            or len(set(allowed)) != len(allowed)
            or argument not in allowed
            or ("currencyArgument" in declaration and declaration["currencyArgument"] not in allowed)
        ):
            raise bad()
        declaration["allowedArguments"] = list(allowed)
    return declaration


def normalize_amount_args(amount_args: Any) -> Dict[str, Dict[str, Any]]:
    """Check every declaration once, when the guard is built, so a typo never reaches a call."""
    if amount_args is None:
        return {}
    if not isinstance(amount_args, Mapping):
        raise TypeError("amount_args must map tool names to declarations")
    return {str(name): _declaration(str(name), value) for name, value in amount_args.items()}


def _pins_within(value: Any, allowed: Any, args: Mapping[str, Any]) -> bool:
    """Valid content-pin metadata for listed arguments the call carries (never any other extra)."""
    if not isinstance(value, list) or not 0 < len(value) <= _CONTENT_PINS_MAX:
        return False
    for pin in value:
        if not isinstance(pin, Mapping):
            return False
        index, size = pin.get("index"), pin.get("size")
        if not (
            isinstance(pin.get("arg"), str)
            and isinstance(index, int)
            and not isinstance(index, bool)
            and index >= 0
            and pin.get("mode") in _PIN_MODES
            and isinstance(size, int)
            and not isinstance(size, bool)
            and size >= 0
            and isinstance(pin.get("sha256"), str)
            and _PIN_SHA256.fullmatch(pin["sha256"])
            and pin["arg"] != CONTENT_PIN_KEY
            and pin["arg"] in allowed
            and pin["arg"] in args
        ):
            return False
    return True


def read_tool_amount(declaration: Optional[Mapping[str, Any]], args: Mapping[str, Any]) -> Tuple[str, Any]:
    """Read a call's amount as Guardian does.

    Returns ``("none", None)`` without a declaration, ``("money", cents)`` or
    ``("refused", code)``. Anything that cannot be read exactly is refused,
    never read as zero: no sign, ``$``, commas, spaces or exponent, and
    dollars are read by text arithmetic, never floating point.
    """
    if declaration is None:
        return ("none", None)
    allowed = declaration.get("allowedArguments")
    if allowed is not None and any(
        name not in allowed and not (name == CONTENT_PIN_KEY and _pins_within(args[name], allowed, args))
        for name in args
    ):
        return ("refused", "AMOUNT_ARGUMENT_NOT_ALLOWED")
    raw = args.get(declaration["argument"])
    if raw is None:
        return ("refused", "AMOUNT_MISSING")
    cents: Optional[int] = None
    if isinstance(raw, bool):
        return ("refused", "AMOUNT_INVALID")
    if declaration["unit"] == "minor":
        if isinstance(raw, int):
            cents = raw if 0 <= raw <= _MAX_SAFE_INTEGER else None
        elif isinstance(raw, float):
            # A float like 100.0 is an integer in JSON, as in JavaScript.
            cents = int(raw) if raw.is_integer() and 0 <= raw <= _MAX_SAFE_INTEGER else None
        elif isinstance(raw, str) and _MINOR_UNITS.fullmatch(raw):
            cents = int(raw)
    else:
        if isinstance(raw, (int, float)):
            whole = raw
            if isinstance(raw, float):
                whole = int(raw) if raw.is_integer() else -1
            if 0 <= whole <= _MAX_SAFE_INTEGER and whole * 100 <= _MAX_SAFE_INTEGER:
                cents = int(whole) * 100
        elif isinstance(raw, str):
            match = _MAJOR_UNITS.fullmatch(raw)
            if match is not None:
                cents = int(match.group(1)) * 100 + int((match.group(2) or "").ljust(2, "0"))
    if cents is None or cents > _MAX_SAFE_INTEGER:
        return ("refused", "AMOUNT_INVALID")
    currency_argument = declaration.get("currencyArgument")
    if currency_argument is not None:
        currency = args.get(currency_argument)
        if currency is None:
            return ("refused", "CURRENCY_MISSING")
        if not isinstance(currency, str) or currency.lower() not in AMOUNT_CURRENCIES:
            return ("refused", "CURRENCY_NOT_ALLOWED")
    return ("money", cents)


def amount_facts(declaration: Optional[Mapping[str, Any]], args: Mapping[str, Any]) -> Dict[str, Any]:
    """What a ``tool.invoke`` carries for a declared amount: the declaration
    and, when the SDK can read the amount, its value in cents."""
    if declaration is None:
        return {}
    kind, value = read_tool_amount(declaration, args)
    facts: Dict[str, Any] = {"amount_argument": dict(declaration)}
    if kind == "money":
        facts["value_cents"] = value
    return facts


def amount_refusal_hint(
    tool_name: str,
    declaration: Optional[Mapping[str, Any]],
    args: Mapping[str, Any],
    reason_code: Optional[str],
) -> Optional[str]:
    """A plain explanation for a call with a declared amount that Guardian
    refused before deciding (``INVALID_REQUEST`` from hosted Guardian,
    ``ACTION_PARAMETERS_INVALID`` from the gateway)."""
    if declaration is None or reason_code not in ("ACTION_PARAMETERS_INVALID", "INVALID_REQUEST"):
        return None
    kind, code = read_tool_amount(declaration, args)
    if kind == "refused":
        form = (
            "a whole number of cents, like 2000 for $20.00"
            if declaration["unit"] == "minor"
            else 'dollars as text, like "19.99", or as a whole number of dollars'
        )
        allowed = declaration.get("allowedArguments")
        listed = "" if allowed is None else ", with no arguments other than " + ", ".join(allowed)
        return (
            f'Guardian blocked this call to "{tool_name}": the amount in its '
            f'"{declaration["argument"]}" argument could not be read ({code}). '
            f"Send the amount as {form}{listed}. Nothing was run."
        )
    return (
        f'Guardian refused this call to "{tool_name}" before deciding. This agent sends '
        f"the amount declaration {canonical_json(dict(declaration))} for it, and Guardian "
        "refuses the call unless that equals the declaration the owner set on this tool "
        "in the Guardian console (Connections → Dollar amounts). Make amount_args match "
        f'the console exactly, and check that "{tool_name}" is registered on this '
        "connection and allowed for this agent. Nothing was run."
    )
