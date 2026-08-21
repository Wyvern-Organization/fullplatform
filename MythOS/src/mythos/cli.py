from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

from .compat import CompatibilityDatabase
from .config import Config
from .features import enable_feature, list_features, mark_feature_disabled
from .hardware import firmware_updates, hardware_report, recommended_driver_packages
from .install import finalize_install, initialize_system
from .macos import assess_bundle, runtime_info
from .network_drivers import GenericNetworking, GenericWifi
from .recovery import (
    create_snapshot,
    diagnostic_report,
    discover_installations,
    list_snapshots,
    repair_bootloader,
    repair_network,
    reset_desktop_settings,
    rollback_snapshot,
)
from .system import system_status
from .updates import (
    apply_offline_update,
    bless_boot,
    cancel_staged_update,
    check_updates,
    configure_channel,
    stage_update,
    update_history,
    update_status,
)
from .constants import VERSION
from .util import MythOSError, require_root, run


def _version() -> str:
    try:
        # Prefer installed package metadata when available.
        from importlib.metadata import version as _pkg_version

        return _pkg_version("mythos")
    except Exception:
        return VERSION


def _print(value: Any, pretty: bool = True) -> None:
    print(json.dumps(value, indent=2 if pretty else None, sort_keys=pretty, default=str))


def _install_recommended_drivers() -> dict[str, Any]:
    require_root()
    packages = recommended_driver_packages()
    run(["apt-get", "update"], check=True, timeout=900)
    run(["apt-get", "install", "-y", *packages], check=True, timeout=3600)
    return {"installed": packages, "reboot_recommended": any("nvidia" in item for item in packages)}


def _apply_firmware_updates() -> dict[str, str]:
    require_root()
    run(["fwupdmgr", "refresh", "--force"], check=True, timeout=300)
    result = run(["fwupdmgr", "update", "-y"], check=True, timeout=1800)
    return {"message": "Firmware updates finished.", "detail": result.stdout.strip()}


def _set_preference(key: str, value: str, acknowledge: bool = False) -> dict[str, Any]:
    require_root()
    config = Config.load()
    if key == "diagnostics":
        config.diagnostics = value == "enabled"
    elif key == "transparency":
        config.transparency = value == "enabled"
    elif key == "macos-preview":
        if value == "enabled" and not acknowledge:
            raise MythOSError("Enabling the macOS research provider requires acknowledging its compatibility warning.")
        config.macos_preview = value == "enabled"
    else:
        raise MythOSError(f"Unknown preference: {key}")
    config.save()
    return {
        "key": key,
        "value": value,
        "diagnostics": config.diagnostics,
        "transparency": config.transparency,
        "macos_preview": config.macos_preview,
    }


def _ssh(enabled: bool) -> dict[str, Any]:
    require_root()
    if enabled:
        run(["apt-get", "update"], check=True, timeout=900)
        run(["apt-get", "install", "-y", "openssh-server"], check=True, timeout=1800)
        run(["systemctl", "enable", "--now", "ssh.service"], check=True, timeout=120)
        run(["ufw", "limit", "OpenSSH"], timeout=60)
    else:
        run(["systemctl", "disable", "--now", "ssh.service"], timeout=120)
        run(["ufw", "delete", "limit", "OpenSSH"], timeout=60)
    return {"ssh": "enabled" if enabled else "disabled"}


def _doctor(verbose: bool = False) -> dict[str, Any]:
    """Aggregate health checks without requiring root — mirrors `mythos doctor`."""

    from .recovery import diagnostic_report

    status = system_status()
    diagnostics = diagnostic_report()
    hardware = hardware_report()
    update = update_status()
    snapshots = list_snapshots()

    # Summarize failures for humans while keeping machine-readable detail.
    failing = [c for c in diagnostics.get("checks", []) if not c.get("ok")]
    issues: list[str] = list(status.get("concerns", []))
    if failing:
        issues.extend(f"diagnostics: {item['label']}" for item in failing)
    if status.get("firewall") == "disabled":
        issues.append("Firewall is disabled — enable with System Hub > Privacy or `mythosctl` via GUI.")
    if not status.get("atomic_updates"):
        issues.append("Transactional updates unavailable — Btrfs/Snapper layout not detected (expected on live/dev hosts).")

    result: dict[str, Any] = {
        "version": _version(),
        "healthy": status.get("health") == "ready" and not failing,
        "health": status.get("health"),
        "issues": issues,
        "system": status,
        "update": update,
        "diagnostics": diagnostics,
        "hardware": hardware,
        "snapshots": {"count": len(snapshots), "items": snapshots[:8] if not verbose else snapshots},
    }
    if verbose:
        result["verbose"] = True
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mythosctl",
        description="MythOS system control — JSON-first CLI that mirrors System Hub actions.",
        epilog="Examples: mythosctl status | mythosctl doctor | mythosctl hardware | mythosctl update check --refresh | mythosctl snapshots list",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s { _version() }")
    parser.add_argument("--compact", action="store_true", help="print compact JSON (no pretty indent)")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("status", help="show system readiness (product, channel, health, disk, secure-boot, firewall, encryption)")
    doc = commands.add_parser("doctor", help="aggregate health: system + diagnostics + hardware + updates + snapshots")
    doc.add_argument("--verbose", action="store_true", help="include full snapshot list and expanded detail")
    commands.add_parser("hardware", help="run the hardware support report (GPU/Wi-Fi/Bluetooth/etc.)")

    update = commands.add_parser("update", help="manage transactional system updates (offline, snapshotted, roll-back on failure)").add_subparsers(
        dest="update_command", required=True
    )
    update.add_parser("status", help="show staged/healthy/failed state and channel")
    update.add_parser("history", help="list recent update transactions (last 50)")
    check = update.add_parser("check", help="simulate dist-upgrade and list pending packages")
    check.add_argument("--refresh", action="store_true", help="apt-get update before check (requires root)")
    update.add_parser("stage", help="download update and create pre-snapshot (requires Btrfs/Snapper)")
    update.add_parser("cancel", help="cancel a staged update")
    update.add_parser("apply-offline", help="apply a staged update offline (systemd offline-update path)")
    update.add_parser("bless", help="bless the current boot as healthy after an offline update")
    channel = update.add_parser("channel", help="switch stable ↔ current (backports)")
    channel.add_argument("name", choices=["stable", "current"], help="channel name")

    drivers = commands.add_parser("drivers", help="manage drivers and firmware").add_subparsers(
        dest="drivers_command", required=True
    )
    drivers.add_parser("recommend", help="list recommended driver packages for this hardware")
    drivers.add_parser("install-recommended", help="install recommended driver packages (requires root, may recommend reboot)")
    drivers.add_parser("firmware", help="list firmware updates via fwupd")
    drivers.add_parser("update-firmware", help="apply firmware updates (requires root)")
    drivers.add_parser("generic-wifi", help="enable Linux wireless stack and unblock Wi-Fi (requires root)")
    drivers.add_parser("generic-networking", help="restart NetworkManager and refresh DNS (requires root)")

    snapshots = commands.add_parser("snapshots", help="manage Btrfs/Snapper restore points").add_subparsers(
        dest="snapshot_command", required=True
    )
    snapshots.add_parser("list", help="list available snapshots (empty if Snapper not configured)")
    create = snapshots.add_parser("create", help="create a manual restore point (requires root)")
    create.add_argument("--description", default="Manual restore point", help="snapshot description")
    rollback = snapshots.add_parser("rollback", help="schedule rollback to a snapshot (requires root, needs reboot)")
    rollback.add_argument("number", type=int, help="snapshot number to restore")

    recovery = commands.add_parser("recovery", help="diagnose and repair an installation").add_subparsers(
        dest="recovery_command", required=True
    )
    recovery.add_parser("diagnostics", help="run failed-services, boot errors, network, dns, firmware checks")
    recovery.add_parser("discover", help="discover block devices that look like MythOS installations")
    recovery.add_parser("repair-network", help="restart NetworkManager and flush DNS (requires root)")
    recovery.add_parser("reset-settings", help="backup and reset GNOME/desktop settings")
    bootloader = recovery.add_parser("repair-bootloader", help="repair GRUB for an explicit MythOS root device (requires root)")
    bootloader.add_argument("root_device", help="root block device, e.g. /dev/nvme0n1p2")
    bootloader.add_argument("--efi-device", help="EFI system partition device, e.g. /dev/nvme0n1p1")

    features = commands.add_parser("feature", help="manage optional capability profiles (see data/catalog/features.json)").add_subparsers(
        dest="feature_command", required=True
    )
    features.add_parser("list", help="list profiles with install status")
    feature_enable = features.add_parser("enable", help="install and enable a profile (requires root)")
    feature_enable.add_argument("name", help="profile key, e.g. gaming, windows-apps, osaii-web-apps")
    feature_disable = features.add_parser("disable", help="disable a profile without deleting app data (requires root)")
    feature_disable.add_argument("name", help="profile key to disable")

    compatibility = commands.add_parser("compatibility", help="query Windows/Bottles compatibility database").add_subparsers(
        dest="compatibility_command", required=True
    )
    lookup = compatibility.add_parser("lookup", help="lookup a single installer name")
    lookup.add_argument("value", help="installer filename, e.g. setup.exe")
    search = compatibility.add_parser("search", help="search the compatibility DB")
    search.add_argument("query", nargs="?", default="", help="search query")

    macos = commands.add_parser("macos", help="inspect experimental macOS compatibility (research preview)").add_subparsers(
        dest="macos_command", required=True
    )
    macos.add_parser("runtime", help="show Darling runtime info")
    inspect = macos.add_parser("inspect", help="inspect a .app bundle")
    inspect.add_argument("bundle", help="path to .app bundle")
    macos.add_parser("setup", help="install/build the pinned Darling runtime (requires root, ~25 GiB)")

    preference = commands.add_parser("preference", help="change a system-wide preference (requires root)")
    preference.add_argument("key", choices=["diagnostics", "transparency", "macos-preview"], help="preference key")
    preference.add_argument("value", choices=["enabled", "disabled"], help="desired value")
    preference.add_argument("--acknowledge-compatibility-warning", action="store_true", help="required when enabling macos-preview")

    ssh = commands.add_parser("ssh", help="enable or disable remote login (requires root, manages UFW)")
    ssh.add_argument("state", choices=["enable", "disable"], help="enable or disable the SSH server")

    finalize = commands.add_parser("install-finalize", help=argparse.SUPPRESS)
    finalize.add_argument("target")
    finalize.add_argument("--live-medium", default="/run/live/medium")
    commands.add_parser("initialize", help=argparse.SUPPRESS)
    return parser


def dispatch(args: argparse.Namespace) -> Any:
    if args.command == "status":
        return system_status()
    if args.command == "doctor":
        return _doctor(verbose=getattr(args, "verbose", False))
    if args.command == "hardware":
        return hardware_report()
    if args.command == "update":
        actions: dict[str, Callable[[], Any]] = {
            "status": update_status,
            "history": update_history,
            "stage": stage_update,
            "cancel": cancel_staged_update,
            "apply-offline": apply_offline_update,
            "bless": bless_boot,
        }
        if args.update_command == "check":
            return check_updates(refresh=args.refresh)
        if args.update_command == "channel":
            return configure_channel(args.name)
        return actions[args.update_command]()
    if args.command == "drivers":
        if args.drivers_command == "recommend":
            return {"packages": recommended_driver_packages()}
        if args.drivers_command == "install-recommended":
            return _install_recommended_drivers()
        if args.drivers_command == "generic-wifi":
            require_root()
            return GenericWifi().activate()
        if args.drivers_command == "generic-networking":
            require_root()
            return GenericNetworking().activate()
        if args.drivers_command == "firmware":
            return firmware_updates()
        return _apply_firmware_updates()
    if args.command == "snapshots":
        if args.snapshot_command == "list":
            return list_snapshots()
        if args.snapshot_command == "create":
            return create_snapshot(args.description)
        return rollback_snapshot(args.number)
    if args.command == "recovery":
        if args.recovery_command == "diagnostics":
            return diagnostic_report()
        if args.recovery_command == "discover":
            return discover_installations()
        if args.recovery_command == "repair-network":
            return repair_network()
        if args.recovery_command == "reset-settings":
            return reset_desktop_settings()
        return repair_bootloader(args.root_device, args.efi_device)
    if args.command == "feature":
        if args.feature_command == "list":
            return list_features()
        if args.feature_command == "enable":
            return enable_feature(args.name)
        return mark_feature_disabled(args.name)
    if args.command == "compatibility":
        database = CompatibilityDatabase()
        if args.compatibility_command == "lookup":
            return database.lookup(args.value).to_dict()
        return [entry.to_dict() for entry in database.search(args.query)]
    if args.command == "macos":
        if args.macos_command == "runtime":
            return runtime_info().to_dict()
        if args.macos_command == "inspect":
            return assess_bundle(Path(args.bundle))
        return enable_feature("macos-apps")
    if args.command == "preference":
        return _set_preference(args.key, args.value, args.acknowledge_compatibility_warning)
    if args.command == "ssh":
        return _ssh(args.state == "enable")
    if args.command == "install-finalize":
        return finalize_install(args.target, args.live_medium)
    if args.command == "initialize":
        return initialize_system()
    raise MythOSError("Unknown command.")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        # Argparse already printed help/error; preserve exit code but make
        # missing-command hint friendlier on interactive shells.
        if exc.code == 2 and not argv:
            print(json.dumps({"error": "No command given. Try: mythosctl --help or mythosctl doctor", "ok": False}), file=sys.stderr)
        raise
    try:
        value = dispatch(args)
    except MythOSError as exc:
        print(json.dumps({"error": str(exc), "ok": False}), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print(json.dumps({"error": "Operation cancelled.", "ok": False}), file=sys.stderr)
        return 130
    _print(value, pretty=not args.compact)
    return 0


def doctor_main(argv: list[str] | None = None) -> int:
    """Direct entry-point for `mythos-doctor` — equivalent to `mythosctl doctor`."""

    parser = argparse.ArgumentParser(prog="mythos-doctor", description="MythOS doctor — quick health check (equivalent to `mythosctl doctor`)")
    parser.add_argument("--version", action="version", version=f"%(prog)s { _version() }")
    parser.add_argument("--compact", action="store_true", help="print compact JSON")
    parser.add_argument("--verbose", action="store_true", help="include full snapshot list and expanded detail")
    args = parser.parse_args(argv)
    try:
        value = _doctor(verbose=args.verbose)
    except MythOSError as exc:
        print(json.dumps({"error": str(exc), "ok": False}), file=sys.stderr)
        return 1
    _print(value, pretty=not args.compact)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
