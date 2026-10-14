#!/usr/bin/env python3
"""Trusted inventory gate for the per-job Cloudflare sandbox."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pwd
import shutil
import stat
import sys
from pathlib import Path
from typing import Any


WORKSPACE = Path("/workspace/ocpa-job")
RESETTABLE = {
    Path("/tmp/ocpa-home"),
    Path("/tmp/ocpa-job-modes.json"),
    Path("/tmp/ocpa-pycache"),
}


class GateError(Exception):
    pass


def require_workspace_root(value: str) -> Path:
    root = Path(value)
    if root != WORKSPACE:
        raise GateError("workspace root is not the assigned job directory")
    return root


def safe_relative_path(value: str, *, max_path_bytes: int, max_depth: int) -> str:
    if not value or len(value.encode("utf-8", errors="strict")) > max_path_bytes:
        raise GateError("unsafe or oversized path")
    if value.startswith("/") or "\\" in value or "\x00" in value or any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in value):
        raise GateError("unsafe path")
    parts = value.split("/")
    if len(parts) > max_depth or any(part in ("", ".", "..") for part in parts):
        raise GateError("unsafe path components")
    return value


def remove_owned_path(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
        shutil.rmtree(path)
    else:
        path.unlink()


def reset(root: Path) -> None:
    for path in (root, *RESETTABLE):
        remove_owned_path(path)
    root.mkdir(parents=True, mode=0o755)
    Path("/tmp/ocpa-pycache").mkdir(mode=0o700)
    Path("/tmp/ocpa-home").mkdir(mode=0o700)


def read_mode_manifest(path: Path, *, max_files: int, max_path_bytes: int, max_depth: int) -> dict[str, str]:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_size > 2_000_000:
        raise GateError("mode manifest is not a bounded regular file")
    with path.open("r", encoding="utf-8", errors="strict") as stream:
        raw: Any = json.load(stream)
    if not isinstance(raw, list) or len(raw) > max_files:
        raise GateError("mode manifest has an invalid shape")
    modes: dict[str, str] = {}
    for entry in raw:
        if not isinstance(entry, dict) or set(entry) != {"path", "mode"}:
            raise GateError("mode manifest entry is malformed")
        path_value, mode = entry["path"], entry["mode"]
        if not isinstance(path_value, str) or mode not in ("100644", "100755"):
            raise GateError("mode manifest entry is invalid")
        relative = safe_relative_path(path_value, max_path_bytes=max_path_bytes, max_depth=max_depth)
        if relative in modes:
            raise GateError("duplicate path in mode manifest")
        modes[relative] = mode
    return modes


def walk_workspace(root: Path, *, max_files: int, max_directories: int, max_file_bytes: int,
                   max_total_bytes: int, max_path_bytes: int, max_depth: int) -> tuple[list[dict[str, Any]], list[str]]:
    root_metadata = root.lstat()
    if not stat.S_ISDIR(root_metadata.st_mode) or stat.S_ISLNK(root_metadata.st_mode):
        raise GateError("workspace root is not a directory")

    files: list[dict[str, Any]] = []
    directories: set[str] = set()
    pending_directories = [root]
    total_bytes = 0

    while pending_directories:
        current = pending_directories.pop()
        try:
            entries = os.scandir(current)
        except OSError as error:
            raise GateError("workspace inventory could not be read") from error
        try:
            with entries:
                for entry in entries:
                    relative = safe_relative_path(
                        (Path(entry.path).relative_to(root)).as_posix(),
                        max_path_bytes=max_path_bytes,
                        max_depth=max_depth,
                    )
                    try:
                        metadata = entry.stat(follow_symlinks=False)
                    except OSError as error:
                        raise GateError("workspace entry could not be inspected") from error
                    if stat.S_ISLNK(metadata.st_mode):
                        raise GateError("workspace contains a symlink")
                    if stat.S_ISDIR(metadata.st_mode):
                        if relative in directories:
                            raise GateError("workspace directory was encountered more than once")
                        if len(directories) >= max_directories:
                            raise GateError("workspace exceeds its directory count limit")
                        directories.add(relative)
                        pending_directories.append(Path(entry.path))
                        continue
                    if not stat.S_ISREG(metadata.st_mode):
                        raise GateError("workspace contains a non-regular file")
                    if len(files) >= max_files:
                        raise GateError("workspace exceeds its file count limit")
                    mode_bits = stat.S_IMODE(metadata.st_mode)
                    if mode_bits == 0o644:
                        mode = "100644"
                    elif mode_bits == 0o755:
                        mode = "100755"
                    else:
                        raise GateError("workspace file mode is not permitted")
                    if metadata.st_size > max_file_bytes:
                        raise GateError("workspace file exceeds its byte limit")
                    try:
                        content = Path(entry.path).read_bytes()
                    except OSError as error:
                        raise GateError("workspace file could not be read") from error
                    if len(content) != metadata.st_size:
                        raise GateError("workspace file changed during inventory")
                    if b"\x00" in content:
                        raise GateError("workspace contains binary content")
                    try:
                        content.decode("utf-8", errors="strict")
                    except UnicodeDecodeError as error:
                        raise GateError("workspace contains non-UTF-8 content") from error
                    total_bytes += len(content)
                    if total_bytes > max_total_bytes:
                        raise GateError("workspace exceeds its total byte limit")
                    files.append({
                        "path": relative,
                        "sha256": hashlib.sha256(content).hexdigest(),
                        "mode": mode,
                        "sizeBytes": len(content),
                    })
        except OSError as error:
            raise GateError("workspace directory could not be scanned") from error

    files.sort(key=lambda item: item["path"])
    return files, sorted(directories)


def prepare(root: Path, manifest_path: Path, runner_user: str, *, max_files: int, max_directories: int,
            max_file_bytes: int, max_total_bytes: int, max_path_bytes: int, max_depth: int) -> None:
    modes = read_mode_manifest(manifest_path, max_files=max_files, max_path_bytes=max_path_bytes, max_depth=max_depth)
    files, _directories = walk_workspace(
        root,
        max_files=max_files,
        max_directories=max_directories,
        max_file_bytes=max_file_bytes,
        max_total_bytes=max_total_bytes,
        max_path_bytes=max_path_bytes,
        max_depth=max_depth,
    )
    if {item["path"] for item in files} != set(modes):
        raise GateError("materialized workspace does not match its mode manifest")

    account = pwd.getpwnam(runner_user)
    for writable_directory in (Path('/tmp/ocpa-home'), Path('/tmp/ocpa-pycache')):
        metadata = writable_directory.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise GateError('runner temporary directory is invalid')
        os.chown(writable_directory, account.pw_uid, account.pw_gid, follow_symlinks=False)
        os.chmod(writable_directory, 0o700, follow_symlinks=False)
    os.chown(manifest_path, 0, 0, follow_symlinks=False)
    os.chmod(manifest_path, 0o400, follow_symlinks=False)
    for directory, dirnames, filenames in os.walk(root, topdown=False, followlinks=False):
        directory_path = Path(directory)
        os.chown(directory_path, account.pw_uid, account.pw_gid, follow_symlinks=False)
        os.chmod(directory_path, 0o755, follow_symlinks=False)
        for filename in filenames:
            file_path = directory_path / filename
            relative = file_path.relative_to(root).as_posix()
            os.chown(file_path, account.pw_uid, account.pw_gid, follow_symlinks=False)
            os.chmod(file_path, 0o755 if modes[relative] == "100755" else 0o644, follow_symlinks=False)
    os.chown(root, account.pw_uid, account.pw_gid, follow_symlinks=False)
    os.chmod(root, 0o755, follow_symlinks=False)


def command() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="operation", required=True)

    reset_parser = subparsers.add_parser("reset")
    reset_parser.add_argument("--root", required=True)

    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--root", required=True)
    prepare_parser.add_argument("--manifest", required=True)
    prepare_parser.add_argument("--runner-user", required=True)

    inventory_parser = subparsers.add_parser("inventory")
    inventory_parser.add_argument("--root", required=True)
    inventory_parser.add_argument("--max-files", type=int, required=True)
    inventory_parser.add_argument("--max-directories", type=int, required=True)
    inventory_parser.add_argument("--max-file-bytes", type=int, required=True)
    inventory_parser.add_argument("--max-total-bytes", type=int, required=True)
    inventory_parser.add_argument("--max-path-bytes", type=int, required=True)
    inventory_parser.add_argument("--max-depth", type=int, required=True)

    args = parser.parse_args()
    try:
        root = require_workspace_root(args.root)
        if args.operation == "reset":
            reset(root)
        elif args.operation == "prepare":
            prepare(
                root,
                Path(args.manifest),
                args.runner_user,
                max_files=2_000,
                max_directories=10_000,
                max_file_bytes=2_000_000,
                max_total_bytes=20_000_000,
                max_path_bytes=1_024,
                max_depth=64,
            )
        else:
            files, directories = walk_workspace(
                root,
                max_files=args.max_files,
                max_directories=args.max_directories,
                max_file_bytes=args.max_file_bytes,
                max_total_bytes=args.max_total_bytes,
                max_path_bytes=args.max_path_bytes,
                max_depth=args.max_depth,
            )
            sys.stdout.write(json.dumps({"files": files, "directories": directories}, separators=(",", ":")))
        return 0
    except (GateError, OSError, ValueError, TypeError, json.JSONDecodeError, KeyError) as error:
        # Do not echo repository paths or untrusted process output into host logs.
        sys.stderr.write(f"verification inventory rejected: {type(error).__name__}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(command())
