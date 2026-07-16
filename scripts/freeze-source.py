#!/usr/bin/env python3
"""Create a deterministic archive of the exact Git working-tree source.

Tracked edits, tracked deletions, and nonignored untracked files are represented.
Ignored files (including local environment files and Vercel credentials) are not.
The canonical manifest is embedded in the archive so the deployed input can
always be tied back to its byte-for-byte source identity.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import stat
import subprocess
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

SCHEMA = 1
EMBEDDED_MANIFEST = ".silicon-source-manifest.json"
MAX_FILE_BYTES = 512 * 1024 * 1024


class FreezeError(RuntimeError):
    """The checkout cannot be represented as one safe immutable source tree."""


@dataclass(frozen=True)
class FrozenFile:
    path: str
    mode: int
    size: int
    sha256: str
    data: bytes
    stat_identity: tuple[int, int, int, int]

    def manifest_value(self) -> dict[str, object]:
        return {
            "path": self.path,
            "mode": f"{self.mode:04o}",
            "size": self.size,
            "sha256": self.sha256,
        }


def _git(root: Path, *args: str) -> bytes:
    try:
        return subprocess.check_output(
            ["git", "-C", str(root), *args],
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise FreezeError("source root is not a readable Git checkout") from exc


def _candidate_paths(root: Path) -> list[str]:
    if _git(root, "diff", "--name-only", "--diff-filter=U", "-z"):
        raise FreezeError("source checkout contains unresolved merges")
    raw = _git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
    paths: list[str] = []
    for encoded in raw.split(b"\0"):
        if not encoded:
            continue
        try:
            path = encoded.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise FreezeError("source path is not valid UTF-8") from exc
        pure = PurePosixPath(path)
        if (
            not path
            or path == EMBEDDED_MANIFEST
            or pure.is_absolute()
            or ".." in pure.parts
            or any(ord(character) < 0x20 or ord(character) == 0x7F for character in path)
        ):
            raise FreezeError("source path is unsafe")
        paths.append(path)
    if len(paths) != len(set(paths)):
        raise FreezeError("source checkout contains duplicate paths")
    return sorted(paths)


def _source_paths(root: Path) -> tuple[list[str], list[str]]:
    present: list[str] = []
    deleted: list[str] = []
    for relative in _candidate_paths(root):
        path = root / relative
        try:
            path.lstat()
        except FileNotFoundError:
            # A cached path missing from the working tree is an intentional
            # tracked deletion. Its absence is part of the snapshot.
            deleted.append(relative)
        except OSError as exc:
            raise FreezeError("release source path became unreadable") from exc
        else:
            present.append(relative)
    if not present:
        raise FreezeError("source checkout contains no release files")
    return present, deleted


def _identity(value: os.stat_result) -> tuple[int, int, int, int]:
    return (value.st_ino, value.st_size, value.st_mtime_ns, value.st_mode)


def _freeze_file(root: Path, relative: str) -> FrozenFile:
    path = root / relative
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or path.is_symlink():
        raise FreezeError("release source must contain regular non-symlink files only")
    if before.st_size < 0 or before.st_size > MAX_FILE_BYTES:
        raise FreezeError("release source file is outside the accepted size bound")
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise FreezeError("release source file became unreadable") from exc
    after = path.lstat()
    if _identity(before) != _identity(after) or len(data) != before.st_size:
        raise FreezeError("release source changed while it was being frozen")
    mode = 0o755 if before.st_mode & stat.S_IXUSR else 0o644
    return FrozenFile(
        path=relative,
        mode=mode,
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        data=data,
        stat_identity=_identity(after),
    )


def _canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def build_snapshot(root: Path) -> tuple[list[FrozenFile], dict[str, object], bytes]:
    root = root.resolve(strict=True)
    paths, deleted = _source_paths(root)
    files = [_freeze_file(root, relative) for relative in paths]

    # Re-list the checkout and recheck every identity. This catches additions,
    # removals, and edits that race the freeze instead of silently mixing states.
    final_paths, final_deleted = _source_paths(root)
    if final_paths != paths or final_deleted != deleted:
        raise FreezeError("release source changed while it was being frozen")
    for frozen in files:
        try:
            current = (root / frozen.path).lstat()
        except OSError as exc:
            raise FreezeError("release source changed while it was being frozen") from exc
        if _identity(current) != frozen.stat_identity:
            raise FreezeError("release source changed while it was being frozen")

    content = {
        "schema": SCHEMA,
        "files": [frozen.manifest_value() for frozen in files],
    }
    source_sha256 = hashlib.sha256(_canonical(content)).hexdigest()
    manifest = {
        **content,
        "source_sha256": source_sha256,
        "git_head": _git(root, "rev-parse", "HEAD").decode().strip(),
        "git_tree": _git(root, "rev-parse", "HEAD^{tree}").decode().strip(),
    }
    raw_manifest = _canonical(manifest)
    return files, manifest, raw_manifest


def _tar_entry(name: str, mode: int, data: bytes) -> tuple[tarfile.TarInfo, io.BytesIO]:
    info = tarfile.TarInfo(name=name)
    info.size = len(data)
    info.mode = mode
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    info.type = tarfile.REGTYPE
    return info, io.BytesIO(data)


def _atomic_write(path: Path, writer) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            writer(handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def write_snapshot(root: Path, archive: Path, manifest_path: Path) -> dict[str, object]:
    files, manifest, raw_manifest = build_snapshot(root)

    def write_archive(handle) -> None:
        with gzip.GzipFile(fileobj=handle, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as output:
                info, body = _tar_entry(EMBEDDED_MANIFEST, 0o600, raw_manifest)
                output.addfile(info, body)
                for frozen in files:
                    info, body = _tar_entry(frozen.path, frozen.mode, frozen.data)
                    output.addfile(info, body)

    _atomic_write(archive, write_archive)
    _atomic_write(manifest_path, lambda handle: handle.write(raw_manifest))
    return {
        "ok": True,
        "schema": SCHEMA,
        "file_count": len(files),
        "source_sha256": manifest["source_sha256"],
        "archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        result = write_snapshot(args.root, args.archive, args.manifest)
    except (FreezeError, OSError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, sort_keys=True))
        return 2
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
