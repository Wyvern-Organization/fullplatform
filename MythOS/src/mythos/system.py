from __future__ import annotations

import glob
import os
import platform
import shutil
from pathlib import Path
from typing import Any

from .config import Config
from .constants import UPDATE_STATE, rooted
from .models import Health
from .util import bytes_to_human, read_json, run


def _os_release() -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        for line in rooted("/etc/os-release").read_text(encoding="utf-8").splitlines():
            if "=" not in line or line.startswith("#"):
                continue
            key, value = line.split("=", 1)
            values[key] = value.strip().strip('"')
    except OSError:
        pass
    return values


def _memory() -> dict[str, Any]:
    fields: dict[str, int] = {}
    try:
        for line in rooted("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            key, value = line.split(":", 1)
            fields[key] = int(value.strip().split()[0]) * 1024
    except (OSError, ValueError):
        return {"total": 0, "available": 0, "used": 0, "label": "Unknown"}
    total = fields.get("MemTotal", 0)
    available = fields.get("MemAvailable", 0)
    return {
        "total": total,
        "available": available,
        "used": max(0, total - available),
        "label": bytes_to_human(total),
    }


def _root_filesystem() -> dict[str, str]:
    result = run(["findmnt", "--json", "--target", "/"], timeout=10)
    if not result.ok:
        return {"source": "unknown", "type": "unknown", "options": ""}
    import json

    try:
        entry = json.loads(result.stdout)["filesystems"][0]
    except (KeyError, IndexError, TypeError, json.JSONDecodeError):
        return {"source": "unknown", "type": "unknown", "options": ""}
    return {
        "source": entry.get("source", "unknown"),
        "type": entry.get("fstype", "unknown"),
        "options": entry.get("options", ""),
    }


def secure_boot_state() -> str:
    result = run(["mokutil", "--sb-state"], timeout=10)
    text = f"{result.stdout}\n{result.stderr}".lower()
    if "enabled" in text:
        return "enabled"
    if "disabled" in text:
        return "disabled"
    variables = glob.glob("/sys/firmware/efi/efivars/SecureBoot-*")
    if variables:
        try:
            data = Path(variables[0]).read_bytes()
            return "enabled" if len(data) > 4 and data[4] == 1 else "disabled"
        except OSError:
            pass
    return "unavailable" if not Path("/sys/firmware/efi").exists() else "unknown"


def encryption_state() -> str:
    source = _root_filesystem()["source"]
    if source.startswith("/dev/mapper/"):
        result = run(["cryptsetup", "status", source.removeprefix("/dev/mapper/")], timeout=10)
        if result.ok and "type:" in result.stdout.lower():
            return "enabled"
    ancestry = run(["lsblk", "-sno", "TYPE", source], timeout=10)
    return "enabled" if "crypt" in ancestry.stdout.split() else "not-enabled"


def firewall_state() -> str:
    result = run(["ufw", "status"], timeout=10)
    if not result.ok:
        nft = run(["systemctl", "is-active", "nftables.service"], timeout=10)
        return "enabled" if nft.stdout.strip() == "active" else "unknown"
    return "enabled" if "Status: active" in result.stdout else "disabled"


def system_status() -> dict[str, Any]:
    release = _os_release()
    config = Config.load()
    update = read_json(rooted(UPDATE_STATE), {})
    filesystem = _root_filesystem()
    try:
        disk = shutil.disk_usage(rooted("/"))
        disk_value = {
            "total": disk.total,
            "free": disk.free,
            "used": disk.used,
            "free_label": bytes_to_human(disk.free),
        }
    except OSError:
        disk_value = {"total": 0, "free": 0, "used": 0, "free_label": "Unknown"}

    concerns: list[str] = []
    if update.get("status") == "failed":
        concerns.append("The last system update did not complete.")
    if disk_value["total"] and disk_value["free"] / disk_value["total"] < 0.08:
        concerns.append("System storage is almost full.")
    if firewall_state() == "disabled":
        concerns.append("The firewall is turned off.")

    from .updates import snapshotter_ready

    return {
        "product": release.get("PRETTY_NAME", "MythOS"),
        "version": release.get("VERSION_ID", "1"),
        "kernel": platform.release(),
        "architecture": platform.machine(),
        "session": os.environ.get("XDG_SESSION_TYPE", "unknown"),
        "desktop": os.environ.get("XDG_CURRENT_DESKTOP", "unknown"),
        "channel": config.channel,
        "health": Health.READY.value if not concerns else Health.ATTENTION.value,
        "concerns": concerns,
        "memory": _memory(),
        "disk": disk_value,
        "root_filesystem": filesystem,
        "atomic_updates": snapshotter_ready(),
        "secure_boot": secure_boot_state(),
        "encryption": encryption_state(),
        "firewall": firewall_state(),
        "diagnostics": "enabled" if config.diagnostics else "disabled",
        "update": update,
    }
