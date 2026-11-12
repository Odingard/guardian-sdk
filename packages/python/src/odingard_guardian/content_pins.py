"""Content pins: the bytes behind a file-path argument, bound into the approval.

Approval binds the exact arguments. A file path is an argument; the file's
contents are not, unless the argument is declared in ``file_args``. For a
declared argument the SDK on the agent's machine reads the file, puts its
SHA-256 in the proposed arguments (under ``guardianContentPins``) and checks
it again just before the tool runs. Guardian's servers never see the file.

A port of the TypeScript SDK's ``content-pins.ts``: the same reserved key,
the same pin record and the same refusal codes, so a pin reads the same in
the console and in receipts. POSIX only: on Windows every pin attempt is
refused (``CONTENT_PIN_UNSUPPORTED_PLATFORM``).
"""

from __future__ import annotations

import copy as _copy
import hashlib
import os
import shutil
import stat as _stat
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple, Union

from ._canonical import CanonicalJsonError, canonical_json

__all__ = [
    "CONTENT_PIN_KEY",
    "CONTENT_CHANGED_SINCE_APPROVAL",
    "CONTENT_PIN_MISSING",
    "CONTENT_PIN_UNREADABLE",
    "CONTENT_PIN_NOT_REGULAR_FILE",
    "CONTENT_PIN_TOO_LARGE",
    "CONTENT_PIN_TOO_MANY",
    "CONTENT_PIN_UNSTABLE",
    "CONTENT_PIN_INVALID_ARGUMENT",
    "CONTENT_PIN_KEY_RESERVED",
    "CONTENT_PIN_REMOTE_MODE",
    "CONTENT_PIN_REMOTE_UPSTREAM",
    "CONTENT_PIN_UNSUPPORTED_PLATFORM",
    "ContentPinError",
    "PinnedFile",
    "PREVIEW_MAX_BYTES",
    "PREVIEW_MAX_LINES",
    "PREVIEW_MAX_ROOTS",
    "content_preview",
    "is_under_preview_roots",
    "normalize_file_arg_preview_roots",
    "normalize_file_arg_previews",
    "pin_file",
    "verify_pin",
]

#: The reserved argument key that carries the pins.
CONTENT_PIN_KEY = "guardianContentPins"

CONTENT_CHANGED_SINCE_APPROVAL = "CONTENT_CHANGED_SINCE_APPROVAL"
CONTENT_PIN_MISSING = "CONTENT_PIN_MISSING"
CONTENT_PIN_UNREADABLE = "CONTENT_PIN_UNREADABLE"
CONTENT_PIN_NOT_REGULAR_FILE = "CONTENT_PIN_NOT_REGULAR_FILE"
CONTENT_PIN_TOO_LARGE = "CONTENT_PIN_TOO_LARGE"
CONTENT_PIN_TOO_MANY = "CONTENT_PIN_TOO_MANY"
CONTENT_PIN_UNSTABLE = "CONTENT_PIN_UNSTABLE"
CONTENT_PIN_INVALID_ARGUMENT = "CONTENT_PIN_INVALID_ARGUMENT"
CONTENT_PIN_KEY_RESERVED = "CONTENT_PIN_KEY_RESERVED"
CONTENT_PIN_REMOTE_MODE = "CONTENT_PIN_REMOTE_MODE"
CONTENT_PIN_REMOTE_UPSTREAM = "CONTENT_PIN_REMOTE_UPSTREAM"
CONTENT_PIN_UNSUPPORTED_PLATFORM = "CONTENT_PIN_UNSUPPORTED_PLATFORM"

#: The contracts' cap on ``tool.invoke`` arguments, measured as the length
#: of the canonical JSON in UTF-16 code units (as the TypeScript contracts do).
TOOL_ARGUMENTS_MAX_BYTES = 16_384
#: At most this many pins per call.
MAX_CONTENT_PINS = 16
#: Default cap per pinned file (25 MiB).
DEFAULT_MAX_PIN_BYTES = 25 * 1024 * 1024
#: Default cap for all pinned files of one call (64 MiB).
DEFAULT_MAX_PIN_TOTAL_BYTES = 64 * 1024 * 1024
_MAX_NAME_LENGTH = 128
#: A text preview holds at most this many lines.
PREVIEW_MAX_LINES = 20
#: A text preview holds at most this many UTF-8 bytes.
PREVIEW_MAX_BYTES = 2048
#: At most this many ``previewRoots`` per file argument.
PREVIEW_MAX_ROOTS = 16
_VALID_MODES = ("bytes", "copy", "recheck")
_CHUNK = 1024 * 1024


class ContentPinError(ValueError):
    """Raised by every content-pin check; ``reason_code`` says which."""

    def __init__(self, reason_code: str, message: str) -> None:
        self.reason_code = reason_code
        super().__init__(message)


@dataclass(frozen=True)
class PinnedFile:
    """The verified bytes of a pinned file.

    ``data`` is left out of ``repr`` so logs never dump the bytes, and
    ``__fspath__`` is deliberately not defined, so a ``PinnedFile`` cannot be
    reopened by accident: the bytes that run are the bytes that were hashed.
    ``str()`` is a label, never the path.
    """

    path: str
    name: str
    data: bytes = field(repr=False)
    size: int
    sha256: str

    def __str__(self) -> str:
        return f"[PinnedFile {self.name} {_short(self.sha256)}…]"


# --- file-system seam (internal: tests only) ---------------------------------



def resolve_path_of_open_file(fd: int, path: str) -> str:
    """Resolve ``path`` again; return it only if it is the file open as ``fd``."""
    target = os.path.realpath(path)
    by_path = os.stat(target)
    by_fd = os.fstat(fd)
    if (by_path.st_dev, by_path.st_ino) != (by_fd.st_dev, by_fd.st_ino):
        raise OSError("resolved path is not the file read")
    return target

class _Fs:
    """The calls a pin makes, so a test can replace them. Not public API."""

    def flags(self) -> Optional[int]:
        nofollow = getattr(os, "O_NOFOLLOW", None)
        nonblock = getattr(os, "O_NONBLOCK", None)
        if nofollow is None or nonblock is None:
            return None
        return os.O_RDONLY | nofollow | nonblock | getattr(os, "O_CLOEXEC", 0)

    def open(self, path: str, flags: int) -> int:
        return os.open(path, flags)

    def fstat(self, fd: int) -> os.stat_result:
        return os.fstat(fd)

    def pread(self, fd: int, length: int, offset: int) -> bytes:
        return os.pread(fd, length, offset)

    def close(self, fd: int) -> None:
        os.close(fd)

    def resolved_path(self, fd: int, path: str) -> str:
        """The resolved path of the open file (asked for only with ``previewRoots``).

        On Linux, the kernel's own name for the descriptor that was read: the
        file the bytes came from, whatever happened to the path since.
        Elsewhere, the path resolved again, trusted only when it is the very
        file that was read (same device and inode as the open descriptor), so
        a link swapped after the read withholds the preview.
        """
        if sys.platform.startswith("linux"):
            return os.readlink(f"/proc/self/fd/{fd}")
        return resolve_path_of_open_file(fd, path)

    def realpath(self, path: str) -> str:
        """The resolved path of a ``previewRoots`` folder."""
        return os.path.realpath(path)


_real_fs = _Fs()
_active_fs: _Fs = _real_fs


def _set_fs_for_tests(fs: Optional[_Fs]) -> None:
    """Tests only: replace the file-system calls (``None`` restores them)."""
    global _active_fs
    _active_fs = fs if fs is not None else _real_fs


# --- reading and hashing -------------------------------------------------------


def _hidden(ch: str) -> bool:
    cp = ord(ch)
    return (
        cp <= 0x1F
        or 0x7F <= cp <= 0x9F
        or cp in (0x200E, 0x200F)
        or 0x202A <= cp <= 0x202E
        or 0x2066 <= cp <= 0x2069
    )


def pin_display_name(path: str) -> str:
    """The basename, without control and bidi characters, cut to 128 characters."""
    base = path[path.rfind("/") + 1 :]
    return "".join(ch for ch in base if not _hidden(ch))[:_MAX_NAME_LENGTH]


def _short(sha256: str) -> str:
    return f"sha256:{sha256[7:19]}"


def _assert_platform(fs: _Fs) -> int:
    if os.name == "nt" or sys.platform == "win32":
        raise ContentPinError(
            CONTENT_PIN_UNSUPPORTED_PLATFORM,
            "Content pinning is not supported on Windows; the file argument was refused",
        )
    flags = fs.flags()
    if flags is None:
        raise ContentPinError(
            CONTENT_PIN_UNSUPPORTED_PLATFORM,
            "This platform does not provide O_NOFOLLOW; the file argument was refused",
        )
    return flags


def _assert_absolute(path: Any) -> str:
    if not isinstance(path, str) or not path.startswith("/"):
        raise ContentPinError(
            CONTENT_PIN_INVALID_ARGUMENT,
            "A pinned file path must be an absolute path (the SDK does not resolve relative paths or ~)",
        )
    return path


class _Budget:
    def __init__(self, remaining: int) -> None:
        self.remaining = remaining


def _read_for_pin(
    path: str,
    max_bytes: int,
    budget: Optional[_Budget] = None,
    expected_size: Optional[int] = None,
    resolved: Optional[List[Optional[str]]] = None,
) -> Tuple[bytes, int, str]:
    """Open (never following a final symlink, never blocking on a FIFO),
    require a regular file, read it whole while hashing, and require the size
    to be stable. Any other failure is ``CONTENT_PIN_UNREADABLE``: no path
    from an exception leads to running unpinned."""
    fs = _active_fs
    flags = _assert_platform(fs)
    _assert_absolute(path)
    if sys.platform.startswith("linux") and (
        path in ("/proc", "/sys") or path.startswith("/proc/") or path.startswith("/sys/")
    ):
        raise ContentPinError(CONTENT_PIN_NOT_REGULAR_FILE, "A file under /proc or /sys cannot be pinned")
    try:
        fd = fs.open(path, flags)
    except OSError as err:
        import errno

        if err.errno in (errno.ELOOP, errno.EMLINK):
            raise ContentPinError(
                CONTENT_PIN_NOT_REGULAR_FILE, "A pinned file must not be a symbolic link"
            ) from None
        raise ContentPinError(
            CONTENT_PIN_UNREADABLE,
            f"The pinned file could not be opened ({errno.errorcode.get(err.errno or 0, 'error')})",
        ) from None
    except Exception:  # noqa: BLE001 — never run unpinned
        raise ContentPinError(CONTENT_PIN_UNREADABLE, "The pinned file could not be opened") from None
    try:
        try:
            first = fs.fstat(fd)
        except Exception:  # noqa: BLE001
            raise ContentPinError(CONTENT_PIN_UNREADABLE, "The pinned file could not be read") from None
        if not _stat.S_ISREG(first.st_mode):
            raise ContentPinError(
                CONTENT_PIN_NOT_REGULAR_FILE,
                "A pinned file must be a regular file (not a directory, FIFO, socket or device)",
            )
        size = first.st_size
        if expected_size is not None and size != expected_size:
            raise ContentPinError(
                CONTENT_CHANGED_SINCE_APPROVAL,
                f"The file changed since approval (size {expected_size} → {size})",
            )
        if size > max_bytes:
            raise ContentPinError(CONTENT_PIN_TOO_LARGE, f"The pinned file is larger than the {max_bytes}-byte cap")
        if budget is not None:
            if size > budget.remaining:
                raise ContentPinError(
                    CONTENT_PIN_TOO_LARGE, "The pinned files of this call are larger than the per-call cap"
                )
            budget.remaining -= size
        hasher = hashlib.sha256()
        parts: List[bytes] = []
        filled = 0
        try:
            while filled < size:
                chunk = fs.pread(fd, min(_CHUNK, size - filled), filled)
                if not chunk:
                    break
                hasher.update(chunk)
                parts.append(chunk)
                filled += len(chunk)
            # One more byte: a file that grew while it was read is unstable.
            extra = fs.pread(fd, 1, size)
        except Exception:  # noqa: BLE001
            raise ContentPinError(CONTENT_PIN_UNREADABLE, "The pinned file could not be read") from None
        if filled != size or len(extra) != 0:
            raise ContentPinError(CONTENT_PIN_UNSTABLE, "The pinned file changed size while it was read")
        try:
            second = fs.fstat(fd)
        except Exception:  # noqa: BLE001
            raise ContentPinError(CONTENT_PIN_UNREADABLE, "The pinned file could not be read") from None
        if second.st_size != first.st_size or second.st_mtime_ns != first.st_mtime_ns:
            raise ContentPinError(CONTENT_PIN_UNSTABLE, "The pinned file was modified while it was read")
        if resolved is not None:
            # Asked for only with previewRoots; unknown means "not in a folder".
            resolver = getattr(fs, "resolved_path", None)
            try:
                resolved.append(resolver(fd, path) if resolver is not None else None)
            except Exception:  # noqa: BLE001
                resolved.append(None)
        return b"".join(parts), size, f"sha256:{hasher.hexdigest()}"
    except ContentPinError:
        raise
    except Exception:  # noqa: BLE001
        raise ContentPinError(CONTENT_PIN_UNREADABLE, "The pinned file could not be read") from None
    finally:
        try:
            fs.close(fd)
        except Exception:  # noqa: BLE001 — closing a read-only descriptor changes nothing checked
            pass


def _is_absent(path: str) -> bool:
    fs = _active_fs
    try:
        fd = fs.open(path, _assert_platform(fs))
    except FileNotFoundError:
        return True
    except Exception:  # noqa: BLE001
        return False
    try:
        fs.close(fd)
    except Exception:  # noqa: BLE001
        pass
    return False


def pin_file(
    path: str, *, max_bytes: int = DEFAULT_MAX_PIN_BYTES, allow_absent: bool = False
) -> Dict[str, Any]:
    """Read and hash one file for a pin: ``{"name", "size", "sha256"}``.

    The path must be absolute. A symlink, directory, FIFO, socket, device,
    unreadable, unstable or oversized file raises :class:`ContentPinError`.
    With ``allow_absent`` a missing file gives ``{"absent": True}``. The bytes
    are not kept.
    """
    try:
        _, size, sha256 = _read_for_pin(path, max_bytes)
    except ContentPinError as err:
        if allow_absent and err.reason_code == CONTENT_PIN_UNREADABLE and _is_absent(path):
            return {"absent": True}
        raise
    return {"name": pin_display_name(path), "size": size, "sha256": sha256}


def _verify_against(
    path: str, pin: Mapping[str, Any], max_bytes: int, budget: Optional[_Budget] = None
) -> PinnedFile:
    try:
        data, size, sha256 = _read_for_pin(path, max_bytes, budget, expected_size=pin["size"])
    except ContentPinError as err:
        if err.reason_code == CONTENT_PIN_UNREADABLE and _is_absent(path):
            raise ContentPinError(
                CONTENT_CHANGED_SINCE_APPROVAL, "The file changed since approval (it no longer exists)"
            ) from None
        raise
    if size != pin["size"] or sha256 != pin["sha256"]:
        raise ContentPinError(
            CONTENT_CHANGED_SINCE_APPROVAL,
            f"The file changed since approval (approved {_short(pin['sha256'])}…, now {_short(sha256)}…)",
        )
    return PinnedFile(path=path, name=pin_display_name(path), data=data, size=size, sha256=sha256)


def verify_pin(
    path: str, pin: Mapping[str, Any], *, max_bytes: int = DEFAULT_MAX_PIN_BYTES
) -> Optional[PinnedFile]:
    """Check a file against its pin just before it is used.

    Returns the verified :class:`PinnedFile` (``None`` when the pin says
    absent and the file is still absent). A difference in size or digest,
    or a file that appeared or disappeared, raises
    ``CONTENT_CHANGED_SINCE_APPROVAL``.
    """
    if pin.get("absent") is True:
        _assert_platform(_active_fs)
        _assert_absolute(path)
        if _is_absent(path):
            return None
        raise ContentPinError(
            CONTENT_CHANGED_SINCE_APPROVAL,
            "The file changed since approval (it did not exist then and exists now)",
        )
    return _verify_against(path, pin, max(max_bytes, int(pin.get("size", 0))))


# --- declarations, proposal and re-check (used by guard.py) ----------------------

FileArgsSpec = Mapping[str, str]
#: What a developer may write for one tool: the full form (a mode per
#: argument), ``True`` in place of a mode, or a list of argument names. The
#: short forms mean ``"bytes"``.
FileArgsDeclaration = Union[Mapping[str, Union[str, bool, Mapping[str, Any]]], Sequence[str]]


# --- preview (display data for the approver, opt-in per argument) -------------

_TEXT_MEDIA_TYPES: Dict[str, str] = {
    "txt": "text/plain",
    "text": "text/plain",
    "log": "text/plain",
    "csv": "text/csv",
    "tsv": "text/tab-separated-values",
    "json": "application/json",
    "jsonl": "application/jsonl",
    "ndjson": "application/x-ndjson",
    "md": "text/markdown",
    "markdown": "text/markdown",
    "yaml": "application/yaml",
    "yml": "application/yaml",
    "toml": "application/toml",
    "ini": "text/plain",
    "cfg": "text/plain",
    "conf": "text/plain",
    "env": "text/plain",
    "xml": "application/xml",
    "html": "text/html",
    "htm": "text/html",
    "css": "text/css",
    "svg": "image/svg+xml",
    "js": "text/javascript",
    "mjs": "text/javascript",
    "cjs": "text/javascript",
    "jsx": "text/javascript",
    "ts": "text/x-typescript",
    "tsx": "text/x-typescript",
    "py": "text/x-python",
    "rb": "text/x-ruby",
    "go": "text/x-go",
    "rs": "text/x-rust",
    "java": "text/x-java",
    "kt": "text/x-kotlin",
    "swift": "text/x-swift",
    "c": "text/x-c",
    "h": "text/x-c",
    "cc": "text/x-c++",
    "cpp": "text/x-c++",
    "hpp": "text/x-c++",
    "cs": "text/x-csharp",
    "php": "text/x-php",
    "sh": "text/x-shellscript",
    "bash": "text/x-shellscript",
    "zsh": "text/x-shellscript",
    "sql": "application/sql",
}

_BINARY_MEDIA_TYPES: Dict[str, str] = {
    "pdf": "application/pdf",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "bmp": "image/bmp",
    "tif": "image/tiff",
    "tiff": "image/tiff",
    "ico": "image/vnd.microsoft.icon",
    "heic": "image/heic",
    "zip": "application/zip",
    "gz": "application/gzip",
    "tgz": "application/gzip",
    "tar": "application/x-tar",
    "bz2": "application/x-bzip2",
    "xz": "application/x-xz",
    "7z": "application/x-7z-compressed",
    "rar": "application/vnd.rar",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "odt": "application/vnd.oasis.opendocument.text",
    "ods": "application/vnd.oasis.opendocument.spreadsheet",
    "odp": "application/vnd.oasis.opendocument.presentation",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "mp4": "video/mp4",
    "mov": "video/quicktime",
    "wasm": "application/wasm",
    "exe": "application/vnd.microsoft.portable-executable",
    "bin": "application/octet-stream",
}

_OCTET_STREAM = "application/octet-stream"


def _extension_of(name: str) -> str:
    dot = name.rfind(".")
    if dot <= 0 or dot == len(name) - 1:
        return ""
    return name[dot + 1 :].lower()


def _preview_hidden(cp: int) -> bool:
    """Characters a preview never shows as themselves (tab and newline are kept)."""
    return (
        (cp <= 0x1F and cp not in (0x09, 0x0A))
        or 0x7F <= cp <= 0x9F
        or cp in (0x061C, 0x180E, 0xFEFF)
        or 0x200B <= cp <= 0x200F
        or 0x2028 <= cp <= 0x202E
        or 0x2060 <= cp <= 0x2069
    )


def _utf8_length(cp: int) -> int:
    return 1 if cp < 0x80 else 2 if cp < 0x800 else 3 if cp < 0x10000 else 4


def content_preview(name: str, data: bytes) -> Dict[str, Any]:
    """The preview of a file's bytes, the same bytes that were hashed.

    ``name`` is the file's display name, used only for its extension. A
    text file (valid UTF-8, no NUL byte, not a known binary extension) gets
    ``{"kind": "text", "mediaType", "size", "text", "truncated"}``: its first
    20 lines, at most 2,048 UTF-8 bytes, cut on a character boundary, with
    control characters other than tab and newline, bidi and zero-width
    characters replaced by U+FFFD, CRLF read as LF and a leading byte-order
    mark dropped. Anything else gets ``{"kind": "binary", "mediaType",
    "size"}`` and no content. The TypeScript SDK computes the same preview.
    """
    size = len(data)
    ext = _extension_of(name)
    if ext in _BINARY_MEDIA_TYPES:
        return {"kind": "binary", "mediaType": _BINARY_MEDIA_TYPES[ext], "size": size}
    if b"\x00" in data:
        return {"kind": "binary", "mediaType": _OCTET_STREAM, "size": size}
    try:
        decoded = bytes(data).decode("utf-8", "strict")
    except UnicodeDecodeError:
        return {"kind": "binary", "mediaType": _OCTET_STREAM, "size": size}
    media_type = _TEXT_MEDIA_TYPES.get(ext, "text/plain")
    if decoded.startswith("\ufeff"):
        decoded = decoded[1:]
    out: List[str] = []
    used = 0
    lines = 0
    truncated = False
    count = len(decoded)
    for i, ch in enumerate(decoded):
        # CRLF counts as one line end.
        if ch == "\r" and i + 1 < count and decoded[i + 1] == "\n":
            continue
        shown = "\ufffd" if _preview_hidden(ord(ch)) else ch
        length = _utf8_length(ord(shown))
        if used + length > PREVIEW_MAX_BYTES:
            truncated = True
            break
        out.append(shown)
        used += length
        if ch == "\n":
            lines += 1
            if lines == PREVIEW_MAX_LINES:
                truncated = i + 1 < count
                break
    return {
        "kind": "text",
        "mediaType": media_type,
        "size": size,
        "text": "".join(out),
        "truncated": truncated,
    }


#: The mode a declared file argument gets when no mode is named: ``"bytes"``,
#: because the function then receives the verified bytes themselves and there
#: is no gap between the check and the read.
DEFAULT_FILE_ARG_MODE = "bytes"


def _invalid_declaration(tool_name: str, detail: str) -> ContentPinError:
    return ContentPinError(
        CONTENT_PIN_INVALID_ARGUMENT,
        f'file_args for "{tool_name}" {detail}. Name each file argument with "bytes" (the default, '
        'also written as True or as a list of names), "copy" or "recheck", or with '
        '{"mode": ..., "preview": True} for a preview.',
    )


def normalize_file_args_spec(
    tool_name: str, spec: Any, *, allowed_modes: Tuple[str, ...] = _VALID_MODES
) -> Optional[Dict[str, str]]:
    """One tool's declaration in the full form (decoration time).

    The short forms mean ``"bytes"``: a list of names (``["attachment_path"]``)
    or ``True`` in place of a mode (``{"attachment_path": True}``). Explicit
    modes are kept as written; the object form
    (``{"attachment_path": {"mode": "bytes", "preview": True}}``) gives its
    mode, ``"bytes"`` when none is named. Anything else is refused with
    ``CONTENT_PIN_INVALID_ARGUMENT``. Returns ``None`` for no declaration.
    A preview is not part of the full form: see
    :func:`normalize_file_arg_previews`.
    """
    parsed = _parse_declaration(tool_name, spec, allowed_modes)
    return None if parsed is None else parsed[0]


def normalize_file_arg_previews(tool_name: str, spec: Any) -> List[str]:
    """The arguments declared with ``{"preview": True}`` (the object form only), sorted.

    Raises like :func:`normalize_file_args_spec` for an invalid declaration.
    """
    parsed = _parse_declaration(tool_name, spec, _VALID_MODES)
    return [] if parsed is None else parsed[1]


def normalize_file_arg_preview_roots(tool_name: str, spec: Any) -> Dict[str, List[str]]:
    """The ``previewRoots`` of one tool's declaration, per argument that names them.

    Absolute, normalized and sorted. Raises like
    :func:`normalize_file_args_spec` for an invalid declaration.
    """
    parsed = _parse_declaration(tool_name, spec, _VALID_MODES)
    return {} if parsed is None else parsed[2]


def _normalize_preview_root(root: Any) -> Optional[str]:
    """One ``previewRoots`` entry in its normal form, or None when it is not valid.

    Absolute, no ``.`` or ``..`` segment, no NUL, repeated slashes collapsed
    and no trailing slash (except for ``/`` itself). The TypeScript SDK
    applies the same rule.
    """
    if not isinstance(root, str) or not root.startswith("/"):
        return None
    if "\0" in root or len(root) > 4096:
        return None
    segments = [segment for segment in root.split("/") if segment != ""]
    if any(segment in (".", "..") for segment in segments):
        return None
    return "/" + "/".join(segments)


def _parse_preview_roots(tool_name: str, arg: str, roots: Any) -> List[str]:
    if not isinstance(roots, (list, tuple)) or not 1 <= len(roots) <= PREVIEW_MAX_ROOTS:
        raise ContentPinError(
            CONTENT_PIN_INVALID_ARGUMENT,
            f'file_args for "{tool_name}.{arg}" previewRoots must be a list of 1 to '
            f"{PREVIEW_MAX_ROOTS} absolute folder paths",
        )
    out: Set[str] = set()
    for root in roots:
        normal = _normalize_preview_root(root)
        if normal is None:
            raise ContentPinError(
                CONTENT_PIN_INVALID_ARGUMENT,
                f'file_args for "{tool_name}.{arg}" previewRoots must hold absolute folder paths '
                "(no . or .. segments)",
            )
        out.add(normal)
    return sorted(out)


def is_under_preview_roots(resolved_path: str, roots: Sequence[str]) -> bool:
    """True when ``resolved_path`` is one of ``roots`` or inside one (whole path segments)."""
    return any(
        root == "/" or resolved_path == root or resolved_path.startswith(root + "/") for root in roots
    )


def _parse_declaration(
    tool_name: str, spec: Any, allowed_modes: Tuple[str, ...]
) -> Optional[Tuple[Dict[str, str], List[str], Dict[str, List[str]]]]:
    if spec is None:
        return None
    full: Dict[str, str] = {}
    preview: List[str] = []
    preview_roots: Dict[str, List[str]] = {}
    implicit: Set[str] = set()
    if isinstance(spec, (list, tuple)):
        for arg in spec:
            if not isinstance(arg, str):
                raise _invalid_declaration(tool_name, "lists a name that is not a string")
            _check_arg_name(tool_name, arg)
            if arg in full:
                raise _invalid_declaration(tool_name, f'lists "{arg}" twice')
            full[arg] = DEFAULT_FILE_ARG_MODE
            implicit.add(arg)
    elif isinstance(spec, Mapping):
        for arg, mode in spec.items():
            _check_arg_name(tool_name, arg)
            if mode is True:
                full[arg] = DEFAULT_FILE_ARG_MODE
                implicit.add(arg)
            elif isinstance(mode, str) and mode in _VALID_MODES:
                full[arg] = mode
            elif isinstance(mode, Mapping):
                unknown = [key for key in mode if key not in ("mode", "preview", "previewRoots")]
                if unknown:
                    raise ContentPinError(
                        CONTENT_PIN_INVALID_ARGUMENT,
                        f'file_args for "{tool_name}.{arg}" has an unknown key "{unknown[0]}" '
                        '(only "mode", "preview" and "previewRoots")',
                    )
                # A present "mode" must name a mode: None is refused, as
                # TypeScript refuses null (leave the key out for "bytes").
                named = mode["mode"] if "mode" in mode else None
                if "mode" in mode and not (isinstance(named, str) and named in _VALID_MODES):
                    raise ContentPinError(
                        CONTENT_PIN_INVALID_ARGUMENT,
                        f'file_args for "{tool_name}.{arg}" mode must be "bytes", "copy" or "recheck"',
                    )
                if "preview" in mode and not isinstance(mode["preview"], bool):
                    raise ContentPinError(
                        CONTENT_PIN_INVALID_ARGUMENT,
                        f'file_args for "{tool_name}.{arg}" preview must be True or False',
                    )
                if "previewRoots" in mode:
                    if mode.get("preview") is not True:
                        raise ContentPinError(
                            CONTENT_PIN_INVALID_ARGUMENT,
                            f'file_args for "{tool_name}.{arg}" previewRoots needs preview: True',
                        )
                    preview_roots[arg] = _parse_preview_roots(tool_name, arg, mode["previewRoots"])
                if named is None:
                    full[arg] = DEFAULT_FILE_ARG_MODE
                    implicit.add(arg)
                else:
                    full[arg] = named
                if mode.get("preview") is True:
                    preview.append(arg)
            else:
                raise ContentPinError(
                    CONTENT_PIN_INVALID_ARGUMENT,
                    f'file_args for "{tool_name}.{arg}" must be "bytes", "copy" or "recheck" '
                    '(or True, which means "bytes", or {"mode": ..., "preview": True})',
                )
    else:
        raise _invalid_declaration(tool_name, "must be a list of argument names or map argument names to modes")
    for arg, mode in full.items():
        if mode not in allowed_modes:
            how = (
                'is declared without a mode, which means "bytes"'
                if arg in implicit
                else f'is "{mode}"'
            )
            raise ContentPinError(
                CONTENT_PIN_INVALID_ARGUMENT,
                f'file_args for "{tool_name}.{arg}" {how}, but Guard.run supports "recheck" only: '
                "its fn takes no arguments, so it cannot be handed the bytes or a copy. Use the @guard "
                'decorator for "bytes" and "copy", or name "recheck" here.',
            )
    return full, sorted(preview), preview_roots


def _check_arg_name(tool_name: str, arg: Any) -> None:
    if not isinstance(arg, str) or not arg or "." in arg or arg == CONTENT_PIN_KEY:
        raise ContentPinError(
            CONTENT_PIN_INVALID_ARGUMENT,
            f'file_args for "{tool_name}" names "{arg}": only top-level argument names are supported',
        )


def assert_file_args_spec(tool_name: str, spec: Any, *, allowed_modes: Tuple[str, ...] = _VALID_MODES) -> None:
    """Configuration check for one tool's declaration (decoration time)."""
    normalize_file_args_spec(tool_name, spec, allowed_modes=allowed_modes)


def carries_reserved_key(args: Any) -> bool:
    return isinstance(args, Mapping) and CONTENT_PIN_KEY in args


def _declared_paths(spec: FileArgsSpec, args: Mapping[str, Any]) -> Dict[str, List[str]]:
    present: Dict[str, List[str]] = {}
    for arg in sorted(spec):
        # Absent means not in the record. A present None is not a path
        # (TypeScript refuses null the same way).
        if arg not in args:
            continue
        value = args[arg]
        if isinstance(value, str):
            present[arg] = [value]
        elif isinstance(value, (list, tuple)) and all(isinstance(v, str) for v in value):
            present[arg] = list(value)
        else:
            raise ContentPinError(
                CONTENT_PIN_INVALID_ARGUMENT,
                f'The file argument "{arg}" must be a path string or a list of path strings'
                + (" (it is None; leave it out to send no file)" if value is None else ""),
            )
    return present


def utf16_length(text: str) -> int:
    """Length in UTF-16 code units, the contracts' measure for the arguments cap."""
    return len(text.encode("utf-16-le")) // 2


def _resolve_roots(roots: Sequence[str]) -> List[str]:
    """The roots with their symbolic links resolved; a root that fails is dropped."""
    fs = _active_fs
    resolver = getattr(fs, "realpath", None)
    out: List[str] = []
    for root in roots:
        if resolver is None:
            continue
        try:
            out.append(resolver(root))
        except Exception:  # noqa: BLE001 — a folder that cannot be resolved holds no previewed file
            pass
    return out


def pin_arguments(
    spec: FileArgsSpec,
    args: Mapping[str, Any],
    *,
    max_pin_bytes: int = DEFAULT_MAX_PIN_BYTES,
    max_pin_total_bytes: int = DEFAULT_MAX_PIN_TOTAL_BYTES,
    preview: Sequence[str] = (),
    preview_roots: Optional[Mapping[str, Sequence[str]]] = None,
) -> Dict[str, Any]:
    """Pin every declared, present file argument: read, hash and drop the bytes.

    Returns the proposed arguments with the pins added (sorted by arg, then
    index), or a copy of the arguments when nothing declared is present. An
    argument in ``preview`` also gets a ``preview`` in its pin, computed
    from the same bytes that were hashed; when it also has ``previewRoots``
    (in ``preview_roots``), a file that is not in one of them (symbolic
    links resolved) gets ``{"kind": "withheld", "size": ...}`` instead.
    """
    present = _declared_paths(spec, args)
    if sum(len(paths) for paths in present.values()) > MAX_CONTENT_PINS:
        raise ContentPinError(CONTENT_PIN_TOO_MANY, f"A call can pin at most {MAX_CONTENT_PINS} files")
    for paths in present.values():
        for path in paths:
            _assert_absolute(path)
    if not present:
        return dict(args)
    budget = _Budget(max_pin_total_bytes)
    pins: List[Dict[str, Any]] = []
    roots_of = preview_roots or {}
    for arg, paths in present.items():
        roots = roots_of.get(arg) if arg in preview else None
        resolved_roots = _resolve_roots(roots) if roots is not None else []
        for index, path in enumerate(paths):
            resolved: Optional[List[Optional[str]]] = [] if roots is not None else None
            data, size, sha256 = _read_for_pin(path, max_pin_bytes, budget, resolved=resolved)
            name = pin_display_name(path)
            pin: Dict[str, Any] = {
                "arg": arg,
                "index": index,
                "mode": spec[arg],
                "name": name,
                "size": size,
                "sha256": sha256,
            }
            if arg in preview:
                real = resolved[0] if resolved else None
                if roots is None or (real is not None and is_under_preview_roots(real, resolved_roots)):
                    pin["preview"] = content_preview(name, data)
                else:
                    pin["preview"] = {"kind": "withheld", "size": size}
            pins.append(pin)
    proposed = {**dict(args), CONTENT_PIN_KEY: pins}
    try:
        measured = utf16_length(canonical_json(proposed))
    except (CanonicalJsonError, TypeError, ValueError):
        raise ContentPinError(CONTENT_PIN_INVALID_ARGUMENT, "The arguments are not canonical JSON") from None
    if measured > TOOL_ARGUMENTS_MAX_BYTES:
        raise ContentPinError(
            CONTENT_PIN_TOO_MANY,
            "The arguments with their content pins and previews exceed the tool arguments limit; "
            "preview fewer files"
            if any("preview" in pin for pin in pins)
            else "The arguments with their content pins exceed the tool arguments limit",
        )
    return proposed


def without_pins(args: Mapping[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in args.items() if k != CONTENT_PIN_KEY}


def _is_pin_record(value: Any) -> bool:
    if not isinstance(value, Mapping):
        return False
    index = value.get("index")
    size = value.get("size")
    sha = value.get("sha256")
    return (
        isinstance(value.get("arg"), str)
        and isinstance(index, int)
        and not isinstance(index, bool)
        and index >= 0
        and value.get("mode") in _VALID_MODES
        and isinstance(size, int)
        and not isinstance(size, bool)
        and size >= 0
        and isinstance(sha, str)
        and len(sha) == 71
        and sha.startswith("sha256:")
        and all(c in "0123456789abcdef" for c in sha[7:])
    )


@dataclass
class VerifiedArguments:
    """The re-check's result: the value for each pinned argument, and cleanup."""

    #: (arg, index) → PinnedFile ("bytes"), private copy path ("copy"), or
    #: the original path ("recheck").
    values: Dict[Tuple[str, int], Any]
    copy_dirs: List[str]

    def cleanup(self) -> None:
        while self.copy_dirs:
            shutil.rmtree(self.copy_dirs.pop(), ignore_errors=True)

    def substitute(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Replace each pinned argument in ``args`` (changed in place, returned)."""
        for (arg, index), value in self.values.items():
            original = args.get(arg)
            if isinstance(original, list):
                original[index] = value
            elif isinstance(original, tuple):
                items = list(original)
                items[index] = value
                args[arg] = items
            else:
                args[arg] = value
        return args


def verify_arguments(
    spec: Optional[FileArgsSpec],
    args: Mapping[str, Any],
    *,
    max_pin_bytes: int = DEFAULT_MAX_PIN_BYTES,
    max_pin_total_bytes: int = DEFAULT_MAX_PIN_TOTAL_BYTES,
) -> VerifiedArguments:
    """The execute-time re-check, driven by the declaration, not by what the
    arguments happen to carry. Every declared, present argument needs exactly
    one matching pin per path, and nothing else may be pinned; otherwise
    ``CONTENT_PIN_MISSING``. Each pinned file is read again and compared; a
    difference is ``CONTENT_CHANGED_SINCE_APPROVAL``."""
    spec = spec or {}
    present = _declared_paths(spec, args)
    supplied = args.get(CONTENT_PIN_KEY)
    pins: List[Any] = [] if supplied is None else (list(supplied) if isinstance(supplied, list) else [None])

    def missing(detail: str) -> ContentPinError:
        return ContentPinError(
            CONTENT_PIN_MISSING, f"A declared file argument has no matching content pin ({detail}); nothing ran"
        )

    expected = {(arg, index) for arg, paths in present.items() for index in range(len(paths))}
    matched: Dict[Tuple[str, int], Mapping[str, Any]] = {}
    for pin in pins:
        if not _is_pin_record(pin):
            raise missing("malformed pin")
        key = (pin["arg"], pin["index"])
        if key not in expected:
            raise missing(f'unexpected pin for "{pin["arg"]}"')
        if key in matched:
            raise missing(f'duplicate pin for "{pin["arg"]}"')
        if spec.get(pin["arg"]) != pin["mode"]:
            raise missing(f'mode of "{pin["arg"]}" differs')
        matched[key] = pin
    if len(matched) != len(expected):
        absent = next(key for key in sorted(expected) if key not in matched)
        raise missing(f'no pin for "{absent[0]}"')
    budget = _Budget(max(max_pin_total_bytes, sum(p["size"] for p in matched.values())))
    verified: Dict[Tuple[str, int], PinnedFile] = {}
    for key, pin in matched.items():
        path = present[key[0]][key[1]]
        verified[key] = _verify_against(path, pin, max(max_pin_bytes, pin["size"]), budget)
    result = VerifiedArguments(values={}, copy_dirs=[])
    try:
        for key, pin in matched.items():
            file = verified[key]
            if pin["mode"] == "bytes":
                result.values[key] = file
            elif pin["mode"] == "copy":
                result.values[key] = _private_copy(file, result.copy_dirs)
            else:
                result.values[key] = file.path
    except BaseException:
        result.cleanup()
        raise
    return result


def _private_copy(file: PinnedFile, copy_dirs: List[str]) -> str:
    """Write the verified bytes to a private copy (a 0700 directory, a 0600
    file created exclusively), check the copy's digest, and return its path."""
    directory = tempfile.mkdtemp(prefix="guardian-pin-")
    copy_dirs.append(directory)
    os.chmod(directory, 0o700)
    name = file.name if file.name not in ("", ".", "..") else "file"
    path = os.path.join(directory, name)
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    fd = os.open(path, flags, 0o600)
    try:
        view = memoryview(file.data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
    finally:
        os.close(fd)
    _verify_against(path, {"size": file.size, "sha256": file.sha256}, max(file.size, 1))
    return path


def deep_copy_arguments(tool_name: str, value: Any, what: str) -> Any:
    """``copy.deepcopy`` for a ``file_args`` tool's arguments, refused when it fails."""
    try:
        return _copy.deepcopy(value)
    except Exception:  # noqa: BLE001
        raise ContentPinError(
            CONTENT_PIN_INVALID_ARGUMENT,
            f'"{tool_name}" declares file_args, so its arguments are copied when proposed, '
            f"but {what} cannot be copied (copy.deepcopy failed). Nothing was proposed or run.",
        ) from None

