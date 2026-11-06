import json
from pathlib import Path

import pytest

from odingard_guardian import CanonicalJsonError, canonical_json, canonical_sha256

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "canonical-json.json").read_text("utf-8"))


@pytest.mark.parametrize("case", VECTORS, ids=lambda c: repr(c["value"])[:40])
def test_matches_typescript_canonical_json(case):
    assert canonical_json(case["value"]) == case["canonical"]
    assert canonical_sha256(case["value"]) == case["sha256"]


def test_negative_zero_is_zero():
    assert canonical_json(-0.0) == "0"


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), {1: "x"}, object()])
def test_rejects_non_json(bad):
    with pytest.raises(CanonicalJsonError):
        canonical_json(bad)


def test_rejects_cycles_and_depth():
    cyclic = []
    cyclic.append(cyclic)
    with pytest.raises(CanonicalJsonError):
        canonical_json(cyclic)
    deep = []
    for _ in range(70):
        deep = [deep]
    with pytest.raises(CanonicalJsonError):
        canonical_json(deep)
