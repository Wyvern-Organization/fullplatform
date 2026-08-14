from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any

from .util import MythOSError, atomic_write, require_root, run


RECOVERY_FILES = (
    "filesystem.squashfs",
    "filesystem.packages",
    "filesystem.packages-remove",
    "filesystem.size",
    "initrd.img",
    "vmlinuz",
)


def _protect_recovery_fstab(fstab: Path) -> None:
    if not fstab.exists():
        return
    lines: list[str] = []
    for line in fstab.read_text(encoding="utf-8").splitlines():
        fields = line.split()
        if len(fields) >= 4 and fields[1] == "/recovery":
            options = fields[3].split(",")
            for value in ("ro", "nofail", "x-systemd.automount"):
                if value not in options:
                    options.append(value)
            fields[3] = ",".join(item for item in options if item != "defaults")
            line = "\t".join(fields)
        lines.append(line)
    atomic_write(fstab, "\n".join(lines) + "\n")


def finalize_install(
    target: str | os.PathLike[str], live_medium: str | os.PathLike[str] = "/run/live/medium"
) -> dict[str, Any]:
    """Populate the recovery partition and mark an installed target."""

    require_root()
    target_root = Path(target).resolve()
    source_root = Path(live_medium).resolve() / "live"
    if not target_root.is_absolute() or target_root == Path("/"):
        raise MythOSError("The installer target root is invalid.")
    if not (target_root / "etc/os-release").exists():
        raise MythOSError("The installer target does not contain an operating system.")
    if not source_root.is_dir():
        raise MythOSError("The live recovery files are not available.")
    recovery_mount = target_root / "recovery"
    if not recovery_mount.is_dir():
        raise MythOSError("The recovery partition is not mounted in the installer target.")

    recovery_live = recovery_mount / "live"
    recovery_live.mkdir(parents=True, exist_ok=True)
    copied: list[str] = []
    for name in RECOVERY_FILES:
        source = source_root / name
        if not source.exists():
            if name in {"filesystem.squashfs", "initrd.img", "vmlinuz"}:
                raise MythOSError(f"Required recovery file is missing: {name}")
            continue
        destination = recovery_live / name
        shutil.copy2(source, destination)
        copied.append(name)

    marker = target_root / "etc/mythos/release"
    marker.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(marker, "MythOS 1.0\n")
    atomic_write(
        recovery_mount / "mythos-recovery.json",
        '{\n  "schema": 1,\n  "product": "MythOS",\n  "version": "1.0.0"\n}\n',
    )
    _protect_recovery_fstab(target_root / "etc/fstab")
    return {"target": str(target_root), "recovery": str(recovery_mount), "copied": copied}


def initialize_system() -> dict[str, Any]:
    """Idempotent first-boot initialization for installed systems."""

    require_root()
    if Path("/run/live/medium").exists():
        return {"initialized": False, "reason": "live-session"}
    state_dir = Path("/var/lib/mythos")
    state_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(state_dir, 0o700)
    if Path("/etc/snapper/configs/root").exists():
        run(["systemctl", "enable", "--now", "snapper-cleanup.timer", "snapper-timeline.timer"], timeout=120)
    run(["systemctl", "enable", "--now", "ufw.service"], timeout=120)
    run(["ufw", "default", "deny", "incoming"], timeout=60)
    run(["ufw", "default", "allow", "outgoing"], timeout=60)
    run(["ufw", "--force", "enable"], timeout=60)
    atomic_write(state_dir / "initialized", "1\n", mode=0o600)
    return {"initialized": True}

