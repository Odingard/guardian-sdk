import contextlib
import io
import tarfile
import tempfile
import unittest
import zipfile
import runpy
from pathlib import Path
from unittest.mock import patch

checker = runpy.run_path(str(Path(__file__).with_name("check-dist.py")))
check_archive = checker["check_archive"]


class DistCheckTests(unittest.TestCase):
    def test_archive_contents(self):
        cases = [
            ("src/odingard_guardian/__init__.py", True),
            ("tests/test_guard.py", True),
            ("README.md", True),
            (".venv-x/lib/tests/foo.py", False),
            ("secrets.txt", False),
            ("src/../../secret", False),
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "odingard_guardian-0.5.0.tar.gz"
            for name, allowed in cases:
                with self.subTest(name=name):
                    with tarfile.open(path, "w:gz") as archive:
                        archive.addfile(tarfile.TarInfo("odingard_guardian-0.5.0/" + name))
                    if allowed:
                        with contextlib.redirect_stdout(io.StringIO()):
                            check_archive(path)
                    else:
                        with self.assertRaises(ValueError):
                            check_archive(path)

    def test_wheel_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "odingard_guardian-0.5.0-py3-none-any.whl"
            for name, allowed in [
                ("odingard_guardian/client.py", True),
                ("odingard_guardian-0.5.0.dist-info/METADATA", True),
                ("other.dist-info/METADATA", False),
                (".venv/lib/tests/foo.py", False),
                ("/odingard_guardian/client.py", False),
            ]:
                with self.subTest(name=name):
                    with zipfile.ZipFile(path, "w") as archive:
                        archive.writestr(name, "")
                    if allowed:
                        with contextlib.redirect_stdout(io.StringIO()):
                            check_archive(path)
                    else:
                        with self.assertRaises(ValueError):
                            check_archive(path)

    def test_empty_and_corrupt_archives(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "odingard_guardian-0.5.0-py3-none-any.whl"
            with zipfile.ZipFile(path, "w"):
                pass
            with self.assertRaisesRegex(ValueError, "empty"):
                check_archive(path)
            path.write_bytes(b"invalid")
            with self.assertRaises(zipfile.BadZipFile):
                check_archive(path)

    def test_size_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            for suffix in [".tar.gz", ".whl"]:
                path = Path(directory) / ("oversized" + suffix)
                path.write_bytes(b"x" * 1_000_001)
                with self.assertRaisesRegex(ValueError, "exceeds"):
                    check_archive(path)

    def test_missing_distributions(self):
        with patch.object(Path, "glob", return_value=iter(())):
            with contextlib.redirect_stderr(io.StringIO()) as output:
                self.assertEqual(checker["main"](), 1)
        self.assertIn("both an sdist and a wheel", output.getvalue())
