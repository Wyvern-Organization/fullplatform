from __future__ import annotations

import datetime as dt
import os
import re
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .config import Config
from .constants import (
    SYSTEM_UPDATE_LINK,
    SYSTEM_UPDATE_TARGET,
    ROLLBACK_COMPLETE,
    ROLLBACK_REQUEST,
    UPDATE_HISTORY,
    UPDATE_STATE,
    rooted,
)
from .util import MythOSError, atomic_write, file_lock, read_json, require_root, run, write_json


CURRENT_SOURCES = """# Managed by MythOS. The stable base remains enabled in both channels.
Types: deb
URIs: https://deb.debian.org/debian
Suites: trixie-backports
Components: main contrib non-free non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
Enabled: {enabled}
"""


@dataclass(slots=True)
class PackageUpdate:
    name: str
    installed: str
    candidate: str
    security: bool


def _now() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")


def _state_path() -> Path:
    return rooted(UPDATE_STATE)


def _history_path() -> Path:
    return rooted(UPDATE_HISTORY)


def _lock_path() -> Path:
    return rooted("/run/lock/mythos-update.lock")


def consumer_layout_ready() -> bool:
    """Confirm that rollback state and snapshots live outside the root subvolume."""

    expected = {
        "/": "/@",
        "/.snapshots": "/@snapshots",
        "/var/lib/mythos": "/@state",
    }
    for mountpoint, fsroot in expected.items():
        result = run(["findmnt", "-nro", "FSTYPE,FSROOT", "--target", mountpoint], timeout=15)
        fields = result.stdout.strip().split()
        if not result.ok or len(fields) != 2 or fields != ["btrfs", fsroot]:
            return False
    return True


def snapshotter_ready() -> bool:
    return consumer_layout_ready() and rooted("/etc/snapper/configs/root").exists() and run(
        ["snapper", "-c", "root", "get-config"], timeout=30
    ).ok


def schedule_rollback(snapshot: int, transaction: str) -> Path:
    """Ask the early-boot Btrfs helper to atomically replace the fixed @ root."""

    require_root()
    if snapshot <= 0:
        raise MythOSError("Choose an existing system snapshot.")
    clean_transaction = re.sub(r"[^a-zA-Z0-9-]", "", transaction)[:64]
    if not clean_transaction:
        raise MythOSError("The rollback transaction identifier is invalid.")
    snapshot_path = rooted(f"/.snapshots/{snapshot}/snapshot")
    if not snapshot_path.is_dir():
        raise MythOSError("The selected system snapshot is no longer available.")
    request = rooted(ROLLBACK_REQUEST)
    atomic_write(request, f"snapshot={snapshot}\ntransaction={clean_transaction}\n", mode=0o600)
    rooted(ROLLBACK_COMPLETE).unlink(missing_ok=True)
    return request


def configure_channel(channel: str) -> dict[str, str]:
    require_root()
    if channel not in {"stable", "current"}:
        raise MythOSError("Update channel must be stable or current.")
    target = rooted("/etc/apt/sources.list.d/mythos-current.sources")
    atomic_write(target, CURRENT_SOURCES.format(enabled="yes" if channel == "current" else "no"))
    config = Config.load()
    config.channel = channel
    config.save()
    return {"channel": channel, "source": str(target)}


def parse_simulation(output: str) -> list[PackageUpdate]:
    updates: list[PackageUpdate] = []
    pattern = re.compile(r"^Inst\s+(\S+)(?:\s+\[([^\]]+)\])?\s+\((\S+)")
    for line in output.splitlines():
        match = pattern.match(line)
        if match:
            updates.append(
                PackageUpdate(
                    match.group(1),
                    match.group(2) or "not installed",
                    match.group(3),
                    "security" in line.casefold(),
                )
            )
    return updates


def check_updates(*, refresh: bool = False) -> dict[str, Any]:
    if refresh:
        require_root()
        run(["apt-get", "update"], check=True, timeout=900)
    result = run(
        ["apt-get", "-s", "-o", "Debug::NoLocking=1", "dist-upgrade"],
        check=True,
        timeout=300,
    )
    packages = parse_simulation(result.stdout)
    security = [item for item in packages if item.security]
    return {
        "checked_at": _now(),
        "count": len(packages),
        "security_count": len(security),
        "packages": [asdict(item) for item in packages],
        "channel": Config.load().channel,
        "atomic": snapshotter_ready(),
    }


def _create_snapshot(description: str, *, pre_number: int | None = None) -> int:
    command = ["snapper", "-c", "root", "create", "--print-number"]
    if pre_number is None:
        command.extend(
            [
                "--type",
                "pre",
                "--cleanup-algorithm",
                "number",
                "--userdata",
                "important=yes",
                "--description",
                description,
            ]
        )
    else:
        command.extend(
            [
                "--type",
                "post",
                "--pre-number",
                str(pre_number),
                "--cleanup-algorithm",
                "number",
                "--description",
                description,
            ]
        )
    result = run(command, check=True, timeout=180)
    try:
        return int(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError) as exc:
        raise MythOSError("The system snapshot was created but its identifier was not returned.") from exc


def _write_state(value: dict[str, Any]) -> None:
    value["updated_at"] = _now()
    write_json(_state_path(), value, mode=0o600)


def _append_history(value: dict[str, Any]) -> None:
    history = read_json(_history_path(), [])
    if not isinstance(history, list):
        history = []
    history.append(value)
    write_json(_history_path(), history[-50:], mode=0o600)


def _set_system_update_link() -> None:
    target = rooted(SYSTEM_UPDATE_TARGET)
    target.mkdir(parents=True, exist_ok=True)
    link = rooted(SYSTEM_UPDATE_LINK)
    if link.is_symlink():
        link.unlink()
    elif link.exists():
        raise MythOSError(f"{SYSTEM_UPDATE_LINK} exists and is not a symbolic link.")
    # The generator runs in the real root, so the link target must remain absolute.
    link.symlink_to(SYSTEM_UPDATE_TARGET)


def _system_update_requested() -> bool:
    link = rooted(SYSTEM_UPDATE_LINK)
    if not link.is_symlink():
        return False
    try:
        return os.readlink(link) == SYSTEM_UPDATE_TARGET
    except OSError:
        return False


def _remove_system_update_link() -> None:
    link = rooted(SYSTEM_UPDATE_LINK)
    if link.is_symlink():
        link.unlink()


def stage_update() -> dict[str, Any]:
    require_root()
    if rooted("/run/live/medium").exists():
        raise MythOSError("Install MythOS before applying system updates.")
    if not snapshotter_ready():
        raise MythOSError(
            "Atomic updates require the MythOS Btrfs layout and root snapshot configuration."
        )
    if rooted(ROLLBACK_REQUEST).exists():
        raise MythOSError("Restart to finish the pending rollback before staging another update.")
    with file_lock(_lock_path()):
        run(["apt-get", "update"], check=True, timeout=900)
        available = check_updates(refresh=False)
        if not available["packages"]:
            state = {
                "status": "current",
                "transaction": "",
                "message": "The system is up to date.",
                "packages": [],
            }
            _write_state(state)
            return state
        transaction = uuid.uuid4().hex
        snapshot = _create_snapshot(f"MythOS pre-update {transaction[:8]}")
        state = {
            "status": "downloading",
            "transaction": transaction,
            "started_at": _now(),
            "snapshot": snapshot,
            "channel": Config.load().channel,
            "packages": available["packages"],
            "message": "Downloading the update.",
        }
        _write_state(state)
        download = run(["apt-get", "-y", "--download-only", "dist-upgrade"], timeout=3600)
        if not download.ok:
            state.update(
                {"status": "failed", "message": "The update could not be downloaded.", "error": download.stderr[-4000:]}
            )
            _write_state(state)
            _append_history(dict(state))
            raise MythOSError(state["message"])
        state.update({"status": "staged", "message": "The update is ready. Restart to install it."})
        _write_state(state)
        _set_system_update_link()
        return state


def cancel_staged_update() -> dict[str, Any]:
    require_root()
    with file_lock(_lock_path()):
        state = read_json(_state_path(), {})
        if state.get("status") not in {"downloading", "staged"}:
            raise MythOSError("There is no staged update to cancel.")
        _remove_system_update_link()
        state.update({"status": "cancelled", "message": "The staged update was cancelled."})
        _write_state(state)
        _append_history(dict(state))
        return state


def apply_offline_update() -> dict[str, Any]:
    require_root()
    with file_lock(_lock_path()):
        if not _system_update_requested():
            return {"status": "ignored", "message": "This offline update belongs to another update provider."}
        state = read_json(_state_path(), {})
        if state.get("status") != "staged":
            _remove_system_update_link()
            raise MythOSError("No complete staged update is available.")
        snapshot = int(state["snapshot"])
        # Remove this before touching packages so a crash cannot create a boot loop.
        _remove_system_update_link()
        state.update({"status": "applying", "message": "Installing the system update."})
        _write_state(state)
        result = run(
            [
                "apt-get",
                "-y",
                "--no-download",
                "-o",
                "Dpkg::Options::=--force-confold",
                "dist-upgrade",
            ],
            timeout=7200,
        )
        if result.ok:
            post = _create_snapshot(f"MythOS post-update {state['transaction'][:8]}", pre_number=snapshot)
            state.update(
                {
                    "status": "applied",
                    "post_snapshot": post,
                    "finished_at": _now(),
                    "message": "The update was installed. Waiting for the desktop health check.",
                }
            )
            rooted(ROLLBACK_REQUEST).unlink(missing_ok=True)
            rooted(ROLLBACK_COMPLETE).unlink(missing_ok=True)
            _write_state(state)
            _append_history(dict(state))
            return state

        try:
            schedule_rollback(snapshot, state["transaction"])
            state.update(
                {
                    "status": "rollback-pending",
                    "finished_at": _now(),
                    "message": "The update failed. The previous system snapshot will be used after restart.",
                    "error": result.stderr[-4000:],
                }
            )
            _write_state(state)
            _append_history(dict(state))
            return state
        except MythOSError as rollback_error:
            rollback_detail = str(rollback_error)
        state.update(
            {
                "status": "failed",
                "finished_at": _now(),
                "message": "The update and automatic rollback both need attention. Start Recovery from the boot menu.",
                "error": f"update: {result.stderr[-2000:]}\nrollback: {rollback_detail}",
            }
        )
        _write_state(state)
        _append_history(dict(state))
        raise MythOSError(state["message"])


def bless_boot() -> dict[str, Any]:
    """Mark the first graphical boot after an update as healthy."""

    require_root()
    state = read_json(_state_path(), {})
    if state.get("status") == "applied":
        state.update({"status": "healthy", "message": "The updated system started successfully.", "healthy_at": _now()})
        _write_state(state)
        _append_history(dict(state))
    elif state.get("status") == "rollback-pending" and rooted(ROLLBACK_COMPLETE).exists():
        state.update({"status": "rolled-back", "message": "The previous system version was restored."})
        rooted(ROLLBACK_COMPLETE).unlink(missing_ok=True)
        _write_state(state)
        _append_history(dict(state))
    elif state.get("status") == "rollback-pending":
        state.update(
            {
                "status": "failed",
                "message": "Automatic rollback did not complete. Start MythOS Recovery from the boot menu.",
            }
        )
        _write_state(state)
        _append_history(dict(state))
    return state


def update_status() -> dict[str, Any]:
    state = read_json(_state_path(), {})
    if not state:
        state = {"status": "never", "message": "No MythOS update has run yet."}
    state["atomic_available"] = snapshotter_ready()
    state["channel"] = Config.load().channel
    state["system_update_pending"] = rooted(SYSTEM_UPDATE_LINK).is_symlink()
    return state


def update_history() -> list[dict[str, Any]]:
    history = read_json(_history_path(), [])
    return history if isinstance(history, list) else []
