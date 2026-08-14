from __future__ import annotations

import csv
import datetime as dt
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .updates import schedule_rollback, snapshotter_ready
from .util import MythOSError, is_device_path, require_root, run


def list_snapshots() -> list[dict[str, Any]]:
    if not snapshotter_ready():
        return []
    result = run(["snapper", "-c", "root", "--csvout", "--no-headers", "list"], timeout=90)
    if not result.ok:
        return []
    snapshots: list[dict[str, Any]] = []
    for row in csv.reader(result.stdout.splitlines()):
        if len(row) < 7 or not row[0].strip().isdigit():
            continue
        snapshots.append(
            {
                "number": int(row[0]),
                "type": row[1].strip(),
                "pre_number": row[2].strip(),
                "date": row[3].strip(),
                "user": row[4].strip(),
                "cleanup": row[5].strip(),
                "description": row[6].strip(),
                "userdata": row[7].strip() if len(row) > 7 else "",
            }
        )
    return snapshots


def create_snapshot(description: str = "Manual restore point") -> dict[str, Any]:
    require_root()
    if not snapshotter_ready():
        raise MythOSError("System snapshots are unavailable on this installation.")
    clean = " ".join(description.split())[:120] or "Manual restore point"
    result = run(
        [
            "snapper",
            "-c",
            "root",
            "create",
            "--type",
            "single",
            "--cleanup-algorithm",
            "number",
            "--description",
            clean,
            "--print-number",
        ],
        check=True,
        timeout=180,
    )
    return {"number": int(result.stdout.strip().splitlines()[-1]), "description": clean}


def rollback_snapshot(number: int) -> dict[str, Any]:
    require_root()
    if number <= 0 or number not in {item["number"] for item in list_snapshots()}:
        raise MythOSError("Choose an existing system snapshot.")
    request = schedule_rollback(number, f"manual-{number}")
    return {
        "snapshot": number,
        "reboot_required": True,
        "message": "The restore point is selected. Restart to use it.",
        "detail": str(request),
    }


def discover_installations() -> list[dict[str, Any]]:
    result = run(
        ["lsblk", "--json", "--paths", "--output", "NAME,PATH,TYPE,FSTYPE,LABEL,UUID,SIZE,MOUNTPOINTS"],
        timeout=30,
    )
    if not result.ok:
        return []
    try:
        devices = json.loads(result.stdout).get("blockdevices", [])
    except json.JSONDecodeError:
        return []
    candidates: list[dict[str, Any]] = []

    def walk(items: list[dict[str, Any]]) -> None:
        for item in items:
            if item.get("fstype") in {"btrfs", "ext4", "xfs"}:
                mounts = [entry for entry in item.get("mountpoints") or [] if entry]
                label = item.get("label") or ""
                likely = label.upper() in {"MYTHOS", "COS_ROOT"} or any(
                    Path(mount, "etc", "mythos").exists() for mount in mounts
                )
                candidates.append(
                    {
                        "path": item.get("path") or item.get("name"),
                        "filesystem": item.get("fstype"),
                        "label": label,
                        "uuid": item.get("uuid") or "",
                        "size": item.get("size") or "",
                        "mountpoints": mounts,
                        "mythos": likely,
                    }
                )
            walk(item.get("children") or [])

    walk(devices)
    return candidates


def diagnostic_report() -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    def command_check(key: str, label: str, argv: list[str], timeout: int = 30) -> None:
        result = run(argv, timeout=timeout)
        checks.append(
            {
                "key": key,
                "label": label,
                "ok": result.ok,
                "detail": (result.stdout.strip() or result.stderr.strip())[-4000:],
            }
        )

    command_check("failed-services", "Failed background services", ["systemctl", "--failed", "--no-legend"])
    command_check("boot-errors", "Errors from this boot", ["journalctl", "-b", "-p", "err", "--no-pager", "-n", "80"])
    command_check("bootloader", "Boot files", ["grub-probe", "/"])
    command_check("network", "Internet connection", ["nmcli", "networking", "connectivity", "check"], timeout=60)
    command_check("dns", "Name lookup", ["getent", "ahosts", "deb.debian.org"])
    command_check("firmware", "Firmware service", ["fwupdmgr", "get-devices", "--json"], timeout=90)
    return {
        "schema": 1,
        "generated": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "healthy": all(item["ok"] for item in checks),
        "checks": checks,
    }


def reset_desktop_settings() -> dict[str, str]:
    """Back up and reset only MythOS and GNOME desktop presentation keys."""

    home = Path.home()
    backup_dir = home / ".local" / "share" / "mythos" / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = backup_dir / f"desktop-settings-{stamp}.dconf"
    dump = run(["dconf", "dump", "/org/gnome/"], check=True, timeout=60)
    backup.write_text(dump.stdout, encoding="utf-8")
    for prefix in (
        "/org/gnome/desktop/interface/",
        "/org/gnome/desktop/wm/preferences/",
        "/org/gnome/shell/extensions/dash-to-panel/",
        "/org/gnome/shell/extensions/arcmenu/",
        "/org/mythos/",
    ):
        run(["dconf", "reset", "-f", prefix], check=True, timeout=30)
    return {"message": "Desktop settings were reset.", "backup": str(backup)}


def repair_network() -> dict[str, str]:
    require_root()
    run(["systemctl", "restart", "NetworkManager.service"], check=True, timeout=120)
    run(["resolvectl", "flush-caches"], timeout=30)
    return {"message": "Networking was restarted and the DNS cache was cleared."}


def repair_bootloader(root_device: str, efi_device: str | None = None) -> dict[str, str]:
    """Repair GRUB only after validating an explicit MythOS root device."""

    require_root()
    if not is_device_path(root_device):
        raise MythOSError("The root target is not a valid device path.")
    if efi_device is not None and not is_device_path(efi_device):
        raise MythOSError("The EFI target is not a valid device path.")
    fstype = run(["lsblk", "-no", "FSTYPE", root_device], check=True, timeout=20).stdout.strip()
    if fstype not in {"btrfs", "ext4", "xfs"}:
        raise MythOSError("The selected root device does not contain a supported Linux filesystem.")

    mount_dir = Path(tempfile.mkdtemp(prefix="mythos-repair-", dir="/run"))
    mounted: list[Path] = []
    try:
        mount_command = ["mount"]
        if fstype == "btrfs":
            mount_command.extend(["-o", "subvol=@"])
        mount_command.extend([root_device, str(mount_dir)])
        run(mount_command, check=True, timeout=120)
        mounted.append(mount_dir)
        marker = mount_dir / "etc" / "mythos" / "release"
        os_release = mount_dir / "etc" / "os-release"
        if not marker.exists() and (not os_release.exists() or "MythOS" not in os_release.read_text(errors="replace")):
            raise MythOSError("The selected filesystem is not a MythOS installation.")

        for source in ("/dev", "/proc", "/sys", "/run"):
            destination = mount_dir / source.removeprefix("/")
            destination.mkdir(parents=True, exist_ok=True)
            run(["mount", "--rbind", source, str(destination)], check=True, timeout=120)
            run(["mount", "--make-rslave", str(destination)], check=True, timeout=30)
            mounted.append(destination)

        if efi_device:
            efi_mount = mount_dir / "boot" / "efi"
            efi_mount.mkdir(parents=True, exist_ok=True)
            run(["mount", efi_device, str(efi_mount)], check=True, timeout=120)
            mounted.append(efi_mount)
            install = [
                "chroot",
                str(mount_dir),
                "grub-install",
                "--target=x86_64-efi",
                "--efi-directory=/boot/efi",
                "--bootloader-id=MythOS",
                "--recheck",
            ]
        else:
            parent = run(["lsblk", "-no", "PKNAME", root_device], check=True, timeout=20).stdout.strip()
            if not parent:
                raise MythOSError("The parent disk for the BIOS bootloader could not be identified.")
            install = ["chroot", str(mount_dir), "grub-install", "--target=i386-pc", f"/dev/{parent}", "--recheck"]
        run(install, check=True, timeout=900)
        run(["chroot", str(mount_dir), "update-grub"], check=True, timeout=900)
        return {"message": "The MythOS bootloader was repaired.", "root": root_device}
    finally:
        for target in reversed(mounted):
            run(["umount", "-R", str(target)], timeout=120)
        try:
            mount_dir.rmdir()
        except OSError:
            pass
