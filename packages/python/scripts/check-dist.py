"""Check Python release archives before upload."""

import sys
import tarfile
import zipfile
from pathlib import Path, PurePosixPath


MAX_BYTES = 1_000_000
SDIST_FILES = {"README.md", "LICENSE", "pyproject.toml", "PKG-INFO", ".gitignore"}


def parts(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError(f"unsafe path: {name}")
    return path.parts


def check_archive(path):
    size = path.stat().st_size
    if size > MAX_BYTES:
        raise ValueError(f"{path.name}: {size} bytes exceeds {MAX_BYTES}")
    count = 0
    if path.name.endswith(".tar.gz"):
        root = path.name[:-7]
        with tarfile.open(path) as archive:
            for member in archive:
                entry = parts(member.name)
                if not entry or entry[0] != root:
                    raise ValueError(f"unexpected sdist root: {member.name}")
                relative = entry[1:]
                allowed = (
                    not relative and member.isdir()
                    or relative and relative[0] in {"src", "tests"}
                    or len(relative) == 1 and relative[0] in SDIST_FILES and member.isfile()
                )
                if not allowed or not (member.isfile() or member.isdir()):
                    raise ValueError(f"unexpected sdist entry: {member.name}")
                count += member.isfile()
    else:
        dist_info = "-".join(path.stem.split("-")[:2]) + ".dist-info"
        with zipfile.ZipFile(path) as archive:
            for member in archive.infolist():
                entry = parts(member.filename)
                if not entry or entry[0] not in {"odingard_guardian", dist_info}:
                    raise ValueError(f"unexpected wheel entry: {member.filename}")
                if member.external_attr >> 16 & 0o170000 == 0o120000:
                    raise ValueError(f"wheel symlink: {member.filename}")
                count += not member.is_dir()
    if not count:
        raise ValueError(f"{path.name}: archive is empty")
    print(f"PASS: {path.name}: {count} files, {size} bytes")


def main():
    dist = Path(__file__).resolve().parents[1] / "dist"
    try:
        sdists = sorted(dist.glob("*.tar.gz"))
        wheels = sorted(dist.glob("*.whl"))
        if not sdists or not wheels:
            raise ValueError("dist must contain both an sdist and a wheel; run python -m build")
        for path in sdists + wheels:
            check_archive(path)
    except (OSError, ValueError, tarfile.TarError, zipfile.BadZipFile) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
