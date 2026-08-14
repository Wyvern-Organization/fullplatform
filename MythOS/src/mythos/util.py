from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import subprocess
import tempfile
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

from .models import CommandResult


class MythOSError(RuntimeError):
    """An actionable error safe to show in the graphical interface."""


class CommandError(MythOSError):
    def __init__(self, result: CommandResult):
        detail = result.stderr.strip() or result.stdout.strip() or "no details returned"
        super().__init__(f"{result.argv[0]} failed: {detail}")
        self.result = result


def run(
    argv: Sequence[str | os.PathLike[str]],
    *,
    check: bool = False,
    timeout: int = 120,
    input_text: str | None = None,
    env: dict[str, str] | None = None,
) -> CommandResult:
    command = [os.fspath(item) for item in argv]
    command_env = os.environ.copy()
    command_env.setdefault("LANG", "C.UTF-8")
    command_env.setdefault("LC_ALL", "C.UTF-8")
    if env:
        command_env.update(env)
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            input=input_text,
            timeout=timeout,
            env=command_env,
        )
    except FileNotFoundError as exc:
        result = CommandResult(command, 127, "", f"command not installed: {command[0]}")
        if check:
            raise CommandError(result) from exc
        return result
    except subprocess.TimeoutExpired as exc:
        result = CommandResult(command, 124, exc.stdout or "", f"timed out after {timeout}s")
        if check:
            raise CommandError(result) from exc
        return result
    result = CommandResult(command, completed.returncode, completed.stdout, completed.stderr)
    if check and not result.ok:
        raise CommandError(result)
    return result


def require_root() -> None:
    if os.geteuid() != 0:
        raise MythOSError("Administrator approval is required for this action.")


def atomic_write(path: Path, content: str, *, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_path, mode)
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def read_json(path: Path, default: Any) -> Any:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def write_json(path: Path, value: Any, *, mode: int = 0o644) -> None:
    atomic_write(path, json.dumps(value, indent=2, sort_keys=True) + "\n", mode=mode)


@contextlib.contextmanager
def file_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise MythOSError("Another system operation is already running.") from exc
        yield


def safe_name(value: str, fallback: str = "application") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._ -]+", "", value).strip(" .")
    return cleaned[:100] or fallback


def bytes_to_human(value: int) -> str:
    amount = float(value)
    for suffix in ("B", "KiB", "MiB", "GiB", "TiB"):
        if amount < 1024 or suffix == "TiB":
            return f"{amount:.0f} {suffix}" if suffix == "B" else f"{amount:.1f} {suffix}"
        amount /= 1024
    return f"{amount:.1f} TiB"


def is_device_path(value: str) -> bool:
    return bool(re.fullmatch(r"/dev/[A-Za-z0-9._/+:-]+", value)) and ".." not in value

