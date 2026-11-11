"""Content pins: reading, hashing and verifying files (content_pins.py).

The same cases as the TypeScript SDK's content-pins tests, where they apply.
"""

import os
import stat

import pytest

from odingard_guardian import (
    CONTENT_CHANGED_SINCE_APPROVAL,
    CONTENT_PIN_INVALID_ARGUMENT,
    CONTENT_PIN_KEY,
    CONTENT_PIN_MISSING,
    CONTENT_PIN_NOT_REGULAR_FILE,
    CONTENT_PIN_TOO_LARGE,
    CONTENT_PIN_TOO_MANY,
    CONTENT_PIN_UNREADABLE,
    CONTENT_PIN_UNSTABLE,
    CONTENT_PIN_UNSUPPORTED_PLATFORM,
    ContentPinError,
    PinnedFile,
    canonical_json,
    pin_file,
    verify_pin,
)
from odingard_guardian import content_pins
from odingard_guardian.content_pins import (
    TOOL_ARGUMENTS_MAX_BYTES,
    _Fs,
    _set_fs_for_tests,
    pin_arguments,
    pin_display_name,
    utf16_length,
    verify_arguments,
)


@pytest.fixture
def report(tmp_path):
    path = tmp_path / "report.txt"
    path.write_bytes(b"approved bytes")
    return str(path)


def code_of(fn, *args, **kwargs):
    with pytest.raises(ContentPinError) as info:
        fn(*args, **kwargs)
    return info.value.reason_code


def test_pin_file_hashes_the_bytes(report):
    import hashlib

    pin = pin_file(report)
    assert pin == {
        "name": "report.txt",
        "size": 14,
        "sha256": "sha256:" + hashlib.sha256(b"approved bytes").hexdigest(),
    }


def test_verify_pin_returns_the_verified_bytes(report):
    pin = pin_file(report)
    file = verify_pin(report, pin)
    assert isinstance(file, PinnedFile)
    assert file.data == b"approved bytes"
    assert file.size == 14


def test_a_rewritten_file_is_refused_including_same_size_and_rename_swap(report, tmp_path):
    pin = pin_file(report)
    with open(report, "wb") as f:
        f.write(b"approved bytez")  # same size, one byte flipped
    assert code_of(verify_pin, report, pin) == CONTENT_CHANGED_SINCE_APPROVAL
    with open(report, "wb") as f:
        f.write(b"approved bytes")
    other = tmp_path / "other.txt"
    other.write_bytes(b"something else")
    os.replace(str(other), report)  # a new file renamed over the path
    assert code_of(verify_pin, report, pin) == CONTENT_CHANGED_SINCE_APPROVAL


def test_absent_and_appeared(tmp_path):
    path = str(tmp_path / "new.txt")
    pin = pin_file(path, allow_absent=True)
    assert pin == {"absent": True}
    assert verify_pin(path, pin) is None
    with open(path, "w") as f:
        f.write("x")
    assert code_of(verify_pin, path, pin) == CONTENT_CHANGED_SINCE_APPROVAL


def test_a_deleted_file_is_changed_since_approval(report):
    pin = pin_file(report)
    os.remove(report)
    assert code_of(verify_pin, report, pin) == CONTENT_CHANGED_SINCE_APPROVAL


def test_not_regular_files_are_refused(tmp_path, report):
    fifo = str(tmp_path / "fifo")
    os.mkfifo(fifo)  # no writer: O_NONBLOCK means the open does not wait
    link = str(tmp_path / "link")
    os.symlink(report, link)
    for path in (str(tmp_path), fifo, "/dev/zero", link):
        assert code_of(pin_file, path) == CONTENT_PIN_NOT_REGULAR_FILE, path
    if os.path.exists("/proc/self/status"):
        assert code_of(pin_file, "/proc/self/status") == CONTENT_PIN_NOT_REGULAR_FILE


def test_missing_or_unreadable_is_refused(tmp_path, report):
    assert code_of(pin_file, str(tmp_path / "missing")) == CONTENT_PIN_UNREADABLE
    # A path through a non-directory (the tests may run as root, where a
    # permission bit would not refuse the read).
    assert code_of(pin_file, report + "/inside") == CONTENT_PIN_UNREADABLE


def test_relative_tilde_and_empty_paths_are_refused():
    for path in ("report.txt", "~/report.txt", "", "./x"):
        assert code_of(pin_file, path) == CONTENT_PIN_INVALID_ARGUMENT


def test_a_declared_argument_that_is_none_is_refused_and_a_missing_one_is_absent():
    # Same rule as TypeScript, where null is refused and undefined is absent.
    spec = {"attachment_path": "recheck"}
    assert code_of(pin_arguments, spec, {"attachment_path": None}) == CONTENT_PIN_INVALID_ARGUMENT
    assert code_of(verify_arguments, spec, {"attachment_path": None}) == CONTENT_PIN_INVALID_ARGUMENT
    assert pin_arguments(spec, {"to": "ops@example.test"}) == {"to": "ops@example.test"}


def test_size_caps(tmp_path, report):
    assert code_of(pin_file, report, max_bytes=4) == CONTENT_PIN_TOO_LARGE
    second = tmp_path / "second.txt"
    second.write_bytes(b"0123456789")
    spec = {"files": "recheck"}
    assert (
        code_of(pin_arguments, spec, {"files": [report, str(second)]}, max_pin_total_bytes=20)
        == CONTENT_PIN_TOO_LARGE
    )


def test_at_most_16_pins_per_call(tmp_path):
    paths = []
    for i in range(17):
        p = tmp_path / f"f{i}"
        p.write_bytes(b"x")
        paths.append(str(p))
    assert code_of(pin_arguments, {"files": "recheck"}, {"files": paths}) == CONTENT_PIN_TOO_MANY
    assert len(pin_arguments({"files": "recheck"}, {"files": paths[:16]})[CONTENT_PIN_KEY]) == 16


def test_the_arguments_cap_counts_utf16_code_units(report):
    # One astral character is 4 UTF-8 bytes but 2 UTF-16 code units; one
    # "é" is 2 UTF-8 bytes but 1 code unit. The cap is the contracts' measure.
    base = {"path": report}
    pinned = pin_arguments({"path": "recheck"}, base)
    room = TOOL_ARGUMENTS_MAX_BYTES - utf16_length(canonical_json(pinned))
    # Fits in code units although its UTF-8 encoding is longer than the cap.
    fits = {"path": report, "note": "é" * (room - len(',"note":""'))}
    assert len(canonical_json(pin_arguments({"path": "recheck"}, fits)).encode("utf-8")) > TOOL_ARGUMENTS_MAX_BYTES
    # One more code unit is over.
    over = {"path": report, "note": "é" * (room - len(',"note":""') + 1)}
    assert code_of(pin_arguments, {"path": "recheck"}, over) == CONTENT_PIN_TOO_MANY
    # An astral character counts as 2 code units.
    astral = {"path": report, "note": "\U0001F600" * ((room - len(',"note":""')) // 2 + 1)}
    assert code_of(pin_arguments, {"path": "recheck"}, astral) == CONTENT_PIN_TOO_MANY


def test_the_name_is_stripped_of_controls_and_bidi_and_capped():
    name = pin_display_name("/tmp/" + "a‮bc\u0007‏⁦d" + "x" * 300)
    assert name.startswith("abcd")
    assert len(name) == 128
    for ch in ("‮", "\u0007", "‏", "⁦"):
        assert ch not in name


def test_pins_are_sorted_by_arg_then_index(tmp_path, report):
    other = tmp_path / "b.txt"
    other.write_bytes(b"b")
    proposed = pin_arguments(
        {"zeta": "bytes", "alpha": "recheck"}, {"zeta": report, "alpha": [str(other), report]}
    )
    assert [(p["arg"], p["index"]) for p in proposed[CONTENT_PIN_KEY]] == [
        ("alpha", 0),
        ("alpha", 1),
        ("zeta", 0),
    ]


def test_verify_arguments_is_driven_by_the_declaration(report):
    spec = {"path": "recheck"}
    proposed = pin_arguments(spec, {"path": report})
    verify_arguments(spec, proposed)
    for bad in (
        {"path": report},  # no pin
        {**proposed, CONTENT_PIN_KEY: proposed[CONTENT_PIN_KEY] * 2},  # duplicate
        {**proposed, CONTENT_PIN_KEY: [{**proposed[CONTENT_PIN_KEY][0], "mode": "bytes"}]},  # wrong mode
        {**proposed, CONTENT_PIN_KEY: [{**proposed[CONTENT_PIN_KEY][0], "arg": "other"}]},  # extra
        {**proposed, CONTENT_PIN_KEY: [{"arg": "path"}]},  # malformed
    ):
        assert code_of(verify_arguments, spec, bad) == CONTENT_PIN_MISSING
    # Pins for a tool that declares nothing are refused the same way.
    assert code_of(verify_arguments, None, proposed) == CONTENT_PIN_MISSING


def test_pinned_file_repr_and_str_do_not_leak_data_or_path(report):
    file = verify_pin(report, pin_file(report))
    assert "approved bytes" not in repr(file)
    assert report not in str(file)
    assert str(file).startswith("[PinnedFile report.txt sha256:")
    assert not hasattr(file, "__fspath__")
    with pytest.raises(TypeError):
        open(file)  # type: ignore[call-overload]


class _GrowingFs(_Fs):
    """The file grows while it is read (through the internal seam)."""

    def pread(self, fd, length, offset):
        data = super().pread(fd, length, offset)
        if offset >= os.fstat(fd).st_size - len(data) and length == 1:
            return b"!"  # the extra byte after the end: the file grew
        return data


def test_a_file_growing_during_the_read_is_unstable(report):
    _set_fs_for_tests(_GrowingFs())
    try:
        assert code_of(pin_file, report) == CONTENT_PIN_UNSTABLE
    finally:
        _set_fs_for_tests(None)


class _NoNoFollow(_Fs):
    def flags(self):
        return None


def test_without_o_nofollow_every_pin_is_refused(report):
    _set_fs_for_tests(_NoNoFollow())
    try:
        assert code_of(pin_file, report) == CONTENT_PIN_UNSUPPORTED_PLATFORM
    finally:
        _set_fs_for_tests(None)


def test_on_windows_every_pin_is_refused(report, monkeypatch):
    monkeypatch.setattr(content_pins.os, "name", "nt")
    assert code_of(pin_file, report) == CONTENT_PIN_UNSUPPORTED_PLATFORM


def test_copy_mode_makes_a_private_copy(report):
    spec = {"path": "copy"}
    verified = verify_arguments(spec, pin_arguments(spec, {"path": report}))
    path = verified.values[("path", 0)]
    try:
        assert path != report
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        assert stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode) == 0o700
        with open(path, "rb") as f:
            assert f.read() == b"approved bytes"
    finally:
        verified.cleanup()
    assert not os.path.exists(path)
