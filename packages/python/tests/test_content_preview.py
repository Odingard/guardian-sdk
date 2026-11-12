"""The opt-in file preview of a content pin (content_preview, file_args preview).

Golden cases come from the TypeScript ``contentPreview``
(tests/fixtures/content-preview.json, written by ``npm run fixtures:python``),
so both SDKs send the same preview for the same bytes.
"""

import base64
import json
import pathlib

import pytest

from odingard_guardian import (
    CONTENT_PIN_INVALID_ARGUMENT,
    CONTENT_PIN_KEY,
    PREVIEW_MAX_BYTES,
    PREVIEW_MAX_LINES,
    ContentPinError,
    Guard,
    GuardianApprovalPending,
    GuardianExecutionFailed,
    PinnedFile,
    RequestResult,
    PREVIEW_MAX_ROOTS,
    content_preview,
    normalize_file_arg_preview_roots,
    normalize_file_arg_previews,
)
from odingard_guardian import content_pins
from odingard_guardian.content_pins import (
    _Fs,
    _set_fs_for_tests,
    is_under_preview_roots,
    normalize_file_args_spec,
    pin_arguments,
)

from test_guard import ALLOW_PIN, ASK_TOOL, CONNECTION, FakeClient, RewritingClient, rewrite

GOLDEN = json.loads((pathlib.Path(__file__).parent / "fixtures" / "content-preview.json").read_text("utf-8"))
DECLARATIONS = json.loads(
    (pathlib.Path(__file__).parent / "fixtures" / "file-arg-declarations.json").read_text("utf-8")
)


@pytest.mark.parametrize("case", GOLDEN, ids=[c["case"] for c in GOLDEN])
def test_matches_the_typescript_preview(case):
    data = base64.b64decode(case["base64"])
    assert content_preview(case["name"], data) == case["preview"]


def test_golden_file_has_cases():
    assert len(GOLDEN) > 30


def test_caps_and_utf8_cut():
    assert PREVIEW_MAX_LINES == 20
    assert PREVIEW_MAX_BYTES == 2048
    preview = content_preview("notes.md", ("€" * 1000).encode())
    assert preview["text"] == "€" * 682
    assert len(preview["text"].encode()) == 2046
    assert preview["truncated"] is True
    lines = "\n".join(f"line {i}" for i in range(30))
    preview = content_preview("a.log", lines.encode())
    assert preview["text"].count("\n") == 20
    assert preview["truncated"] is True


def test_binary_and_sanitised():
    assert content_preview("r.pdf", b"%PDF-1.7") == {"kind": "binary", "mediaType": "application/pdf", "size": 8}
    assert content_preview("a.txt", b"a\x00b")["kind"] == "binary"
    assert content_preview("a.csv", b"caf\xe9")["kind"] == "binary"
    text = content_preview("a.txt", "x‮exe​\x07⁦y".encode())["text"]
    assert text == "x�exe���y"


@pytest.mark.parametrize(
    "file_args",
    [["attachment_path"], {"attachment_path": True}, {"attachment_path": "bytes"}, {"attachment_path": {"mode": "bytes"}}],
)
def test_opt_in_short_forms_send_no_preview(tmp_path, file_args):
    path = tmp_path / "q3.csv"
    path.write_bytes(b"a,b\n")
    client = FakeClient(ALLOW_PIN)
    Guard(client, connection_id=CONNECTION)("send_report", file_args=file_args)(lambda attachment_path: None)(
        str(path)
    )
    pin = client.last_invocation["arguments"][CONTENT_PIN_KEY][0]
    assert "preview" not in pin
    assert normalize_file_arg_previews("t", file_args) == []


def test_a_declared_preview_rides_inside_the_pin(tmp_path):
    path = tmp_path / "q3.csv"
    path.write_bytes(b"region,total\nnorth,120\n")
    client = FakeClient(ALLOW_PIN)
    seen = []
    send = Guard(client, connection_id=CONNECTION)(
        "send_report", file_args={"attachment_path": {"mode": "bytes", "preview": True}}
    )(lambda attachment_path: seen.append(attachment_path))
    send(str(path))
    pin = client.last_invocation["arguments"][CONTENT_PIN_KEY][0]
    assert pin["preview"] == {
        "kind": "text",
        "mediaType": "text/csv",
        "size": 23,
        "text": "region,total\nnorth,120\n",
        "truncated": False,
    }
    assert pin["mode"] == "bytes"
    assert isinstance(seen[0], PinnedFile) and seen[0].data == b"region,total\nnorth,120\n"


def test_the_same_shape_as_typescript_for_the_same_file(tmp_path):
    # The TypeScript test proposes exactly this pin for this file.
    path = tmp_path / "q3.csv"
    path.write_bytes(b"region,total\nnorth,120\n")
    proposed = pin_arguments({"attachmentPath": "bytes"}, {"attachmentPath": str(path)}, preview=["attachmentPath"])
    assert list(proposed[CONTENT_PIN_KEY][0]) == ["arg", "index", "mode", "name", "size", "sha256", "preview"]


def test_the_preview_is_computed_from_the_hashed_bytes(tmp_path):
    path = tmp_path / "r.txt"
    path.write_bytes(b"first read\n")
    opens = []

    class CountingFs(_Fs):
        def open(self, p, flags):
            opens.append(p)
            return super().open(p, flags)

    _set_fs_for_tests(CountingFs())
    try:
        proposed = pin_arguments({"a": "bytes"}, {"a": str(path)}, preview=["a"])
    finally:
        _set_fs_for_tests(None)
    assert len(opens) == 1
    pin = proposed[CONTENT_PIN_KEY][0]
    assert pin["preview"]["text"] == "first read\n"
    import hashlib

    assert pin["sha256"] == "sha256:" + hashlib.sha256(b"first read\n").hexdigest()


@pytest.mark.parametrize(
    "file_args, message",
    [
        ({"a": {"preview": "yes"}}, "preview must be True or False"),
        ({"a": {"preview": 1}}, "preview must be True or False"),
        ({"a": {"preview": None}}, "preview must be True or False"),
        ({"a": {"mode": "stream", "preview": True}}, "mode must be"),
        ({"a": {"mode": True}}, "mode must be"),
        ({"a": {"preview": True, "lines": 40}}, 'unknown key "lines"'),
        ({"a": {"mode": None, "preview": True}}, "mode must be"),
        ({"a": {"mode": None}}, "mode must be"),
        ({"a": {"previewRoots": ["/srv"]}}, "previewRoots needs preview: True"),
        ({"a": {"preview": True, "previewRoots": []}}, "previewRoots must be a list"),
        ({"a": {"preview": True, "previewRoots": "/srv"}}, "previewRoots must be a list"),
        ({"a": {"preview": True, "previewRoots": ["srv"]}}, "absolute folder paths"),
        ({"a": {"preview": True, "previewRoots": ["/srv/../etc"]}}, "absolute folder paths"),
    ],
)
def test_invalid_preview_values_are_refused_at_decoration_time(file_args, message):
    client = FakeClient(ALLOW_PIN)
    guard = Guard(client, connection_id=CONNECTION)
    with pytest.raises(ContentPinError) as info:
        guard("send_report", file_args=file_args)(lambda a: None)
    assert info.value.reason_code == CONTENT_PIN_INVALID_ARGUMENT
    assert message in str(info.value)
    with pytest.raises(ContentPinError):
        normalize_file_arg_previews("t", file_args)
    assert client.calls == []


def test_the_object_form_gives_its_mode():
    assert normalize_file_args_spec("t", {"a": {"preview": True}, "b": {"mode": "copy", "preview": True}, "c": {}}) == {
        "a": "bytes",
        "b": "copy",
        "c": "bytes",
    }
    assert normalize_file_arg_previews("t", {"b": {"preview": True}, "a": {"mode": "copy", "preview": True}}) == [
        "a",
        "b",
    ]


def test_guard_run_takes_a_preview_in_recheck_mode_only(tmp_path):
    path = tmp_path / "q3.txt"
    path.write_bytes(b"hello\n")
    client = FakeClient(ALLOW_PIN)
    guard = Guard(client, connection_id=CONNECTION)
    guard.run("send_report", {"a": str(path)}, lambda: "ok", file_args={"a": {"mode": "recheck", "preview": True}})
    assert client.last_invocation["arguments"][CONTENT_PIN_KEY][0]["preview"]["text"] == "hello\n"
    with pytest.raises(ContentPinError) as info:
        guard.run("send_report", {"a": str(path)}, lambda: "ok", file_args={"a": {"preview": True}})
    assert "without a mode" in str(info.value)


def test_approve_with_a_preview_then_run_once(tmp_path):
    path = tmp_path / "q3.txt"
    path.write_bytes(b"approved bytes\n")
    client = FakeClient(ASK_TOOL, claims=[ALLOW_PIN])
    ran = []
    send = Guard(client, connection_id=CONNECTION)("send_report", file_args={"a": {"preview": True}})(
        lambda a: ran.append(a.data)
    )
    with pytest.raises(GuardianApprovalPending) as info:
        send(str(path))
    assert client.last_invocation["arguments"][CONTENT_PIN_KEY][0]["preview"]["text"] == "approved bytes\n"
    info.value.resume()
    assert ran == [b"approved bytes\n"]


def test_a_changed_file_is_still_refused_by_the_hash(tmp_path):
    path = tmp_path / "q3.txt"
    path.write_bytes(b"approved bytes\n")
    client = RewritingClient(ALLOW_PIN, before_answer=rewrite(str(path)))
    ran = []
    send = Guard(client, connection_id=CONNECTION)("send_report", file_args={"a": {"preview": True}})(
        lambda a: ran.append(1)
    )
    with pytest.raises(GuardianExecutionFailed) as info:
        send(str(path))
    assert info.value.reason_code == "CONTENT_CHANGED_SINCE_APPROVAL"
    assert ran == []


def test_previews_over_the_arguments_limit_are_refused(tmp_path):
    paths = []
    for i in range(10):
        p = tmp_path / f"f{i}.txt"
        p.write_bytes(b"\t" * 2048)
        paths.append(str(p))
    with pytest.raises(ContentPinError) as info:
        pin_arguments({"files": "bytes"}, {"files": paths}, preview=["files"])
    assert info.value.reason_code == "CONTENT_PIN_TOO_MANY"
    assert "preview fewer files" in str(info.value)


def test_module_exports():
    assert content_pins.content_preview is content_preview
    assert RequestResult  # imported for the shared helpers


@pytest.mark.parametrize("case", DECLARATIONS["declarations"], ids=[c["case"] for c in DECLARATIONS["declarations"]])
def test_declarations_parse_as_in_typescript(case):
    declaration = case["declaration"]
    if "error" in case:
        with pytest.raises(ContentPinError) as info:
            normalize_file_args_spec("send_report", declaration)
        assert info.value.reason_code == case["error"]
        return
    assert (normalize_file_args_spec("send_report", declaration) or {}) == (case["spec"] or {})
    assert normalize_file_arg_previews("send_report", declaration) == case["preview"]
    assert normalize_file_arg_preview_roots("send_report", declaration) == case["previewRoots"]


@pytest.mark.parametrize("case", DECLARATIONS["under"], ids=[c["path"] + " " + ",".join(c["roots"]) for c in DECLARATIONS["under"]])
def test_preview_folders_match_as_in_typescript(case):
    assert is_under_preview_roots(case["path"], case["roots"]) is case["under"]


def test_the_declarations_golden_file_has_cases():
    assert len(DECLARATIONS["declarations"]) > 30
    assert PREVIEW_MAX_ROOTS == 16


def _send_with_roots(client, roots):
    return Guard(client, connection_id=CONNECTION)(
        "send_report",
        file_args={"attachment_path": {"mode": "bytes", "preview": True, "previewRoots": roots}},
    )(lambda attachment_path: None)


def test_a_file_outside_the_preview_folders_is_withheld(tmp_path):
    reports = tmp_path / "reports"
    reports.mkdir()
    inside = reports / "q3.csv"
    inside.write_bytes(b"region,total\n")
    secret = tmp_path / "credentials"
    secret.write_bytes(b"aws_secret_access_key=top-secret-value\n")
    client = FakeClient(ALLOW_PIN)
    _send_with_roots(client, [str(reports)])(str(inside))
    assert client.last_invocation["arguments"][CONTENT_PIN_KEY][0]["preview"]["text"] == "region,total\n"
    client = FakeClient(ALLOW_PIN)
    _send_with_roots(client, [str(reports)])(str(secret))
    pin = client.last_invocation["arguments"][CONTENT_PIN_KEY][0]
    assert pin["preview"] == {"kind": "withheld", "size": 39}
    assert "top-secret" not in json.dumps(client.last_invocation)


def test_a_directory_link_inside_a_folder_to_a_file_outside_is_withheld(tmp_path):
    reports = tmp_path / "reports"
    reports.mkdir()
    (tmp_path / "secret.txt").write_bytes(b"hidden-value\n")
    (reports / "up").symlink_to(tmp_path, target_is_directory=True)
    client = FakeClient(ALLOW_PIN)
    _send_with_roots(client, [str(reports)])(str(reports / "up" / "secret.txt"))
    assert client.last_invocation["arguments"][CONTENT_PIN_KEY][0]["preview"] == {"kind": "withheld", "size": 13}
    assert "hidden-value" not in json.dumps(client.last_invocation)


def test_a_folder_that_is_a_link_is_resolved(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    (real / "a.txt").write_bytes(b"shown\n")
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    client = FakeClient(ALLOW_PIN)
    _send_with_roots(client, [str(link)])(str(real.resolve() / "a.txt"))
    assert client.last_invocation["arguments"][CONTENT_PIN_KEY][0]["preview"]["text"] == "shown\n"


def test_a_missing_folder_or_an_unknown_path_previews_nothing(tmp_path):
    path = tmp_path / "a.txt"
    path.write_bytes(b"not-shown\n")
    client = FakeClient(ALLOW_PIN)
    _send_with_roots(client, [str(tmp_path / "missing")])(str(path))
    assert client.last_invocation["arguments"][CONTENT_PIN_KEY][0]["preview"] == {"kind": "withheld", "size": 10}

    class UnknownFs(_Fs):
        def resolved_path(self, fd, p):
            raise OSError("unknown")

    _set_fs_for_tests(UnknownFs())
    try:
        proposed = pin_arguments(
            {"a": "bytes"}, {"a": str(path)}, preview=["a"], preview_roots={"a": [str(tmp_path)]}
        )
    finally:
        _set_fs_for_tests(None)
    assert proposed[CONTENT_PIN_KEY][0]["preview"] == {"kind": "withheld", "size": 10}


def test_link_swapped_after_read_is_not_trusted(tmp_path):
    import os
    from odingard_guardian.content_pins import resolve_path_of_open_file

    inside = tmp_path / "allowed"
    outside = tmp_path / "secret"
    inside.mkdir()
    outside.mkdir()
    (inside / "report.txt").write_text("fine")
    (outside / "report.txt").write_text("secret")
    link = tmp_path / "link"
    link.symlink_to(outside)
    fd = os.open(link / "report.txt", os.O_RDONLY)
    try:
        link.unlink()
        link.symlink_to(inside)
        import pytest

        with pytest.raises(OSError, match="not the file read"):
            resolve_path_of_open_file(fd, str(link / "report.txt"))
    finally:
        os.close(fd)
    same = os.open(inside / "report.txt", os.O_RDONLY)
    try:
        assert resolve_path_of_open_file(same, str(link / "report.txt")).endswith(
            "allowed/report.txt"
        )
    finally:
        os.close(same)
