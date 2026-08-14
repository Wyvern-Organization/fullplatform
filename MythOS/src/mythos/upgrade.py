"""Idempotent state migrations for in-place MythOS releases.

This module intentionally changes only MythOS-owned state. Debian owns the
package transaction; the release installer creates a Btrfs snapshot before
that transaction and invokes this runner after the new package is unpacked.
"""

from __future__ import annotations

import argparse
import datetime as dt
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .constants import STATE_DIR, rooted
from .util import MythOSError, file_lock, read_json, require_root, write_json


SCHEMA_VERSION = 1
UPGRADE_STATE = f"{STATE_DIR}/upgrade.json"
UPGRADE_LOCK = f"{STATE_DIR}/upgrade.lock"


def _now() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")


def _move_if_needed(source: Path, destination: Path) -> bool:
    """Move a legacy MythOS state file without replacing a newer file."""

    if not source.exists() or destination.exists():
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(destination))
    return True


def _migration_1() -> list[str]:
    """Normalize early state filenames before later control-plane refactors."""

    state_dir = rooted(STATE_DIR)
    changes: list[str] = []
    for old_name, new_name in (
        ("update-state.json", "update.json"),
        ("updates.json", "update-history.json"),
    ):
        if _move_if_needed(state_dir / old_name, state_dir / new_name):
            changes.append(f"moved {old_name} to {new_name}")
    return changes


MIGRATIONS: dict[int, Callable[[], list[str]]] = {1: _migration_1}


def status() -> dict[str, Any]:
    value = read_json(rooted(UPGRADE_STATE), {})
    return value if isinstance(value, dict) else {}


def migrate() -> dict[str, Any]:
    """Apply all pending, monotonic MythOS-owned state migrations."""

    require_root()
    state_dir = rooted(STATE_DIR)
    state_dir.mkdir(parents=True, exist_ok=True)
    state_path = rooted(UPGRADE_STATE)
    with file_lock(rooted(UPGRADE_LOCK)):
        previous = status()
        try:
            completed = int(previous.get("schema_version", 0))
        except (TypeError, ValueError):
            completed = 0
        if completed < 0 or completed > SCHEMA_VERSION:
            raise MythOSError("The MythOS upgrade state has an unsupported schema version.")

        changes: list[str] = []
        applied: list[int] = []
        for version in range(completed + 1, SCHEMA_VERSION + 1):
            migration = MIGRATIONS.get(version)
            if migration is None:
                raise MythOSError(f"MythOS upgrade migration {version} is missing.")
            changes.extend(migration())
            applied.append(version)

        result = {
            "schema_version": SCHEMA_VERSION,
            "updated_at": _now(),
            "applied": applied,
            "changes": changes,
        }
        write_json(state_path, result, mode=0o600)
        return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m mythos.upgrade")
    parser.add_argument("--post-install", action="store_true", help="apply pending release migrations")
    parser.add_argument("--status", action="store_true", help="show migration state")
    args = parser.parse_args(argv)
    if args.status:
        print(status())
        return 0
    if not args.post_install:
        parser.error("choose --post-install or --status")
    migrate()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
