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
from .util import MythOSError, require_root, run


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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mythosctl", description="MythOS system control")
    parser.add_argument("--compact", action="store_true", help="print compact JSON")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("status", help="show system readiness")
    commands.add_parser("hardware", help="run the hardware support report")

    update = commands.add_parser("update", help="manage transactional system updates").add_subparsers(
        dest="update_command", required=True
    )
    update.add_parser("status")
    update.add_parser("history")
    check = update.add_parser("check")
    check.add_argument("--refresh", action="store_true")
    update.add_parser("stage")
    update.add_parser("cancel")
    update.add_parser("apply-offline")
    update.add_parser("bless")
    channel = update.add_parser("channel")
    channel.add_argument("name", choices=["stable", "current"])

    drivers = commands.add_parser("drivers", help="manage drivers and firmware").add_subparsers(
        dest="drivers_command", required=True
    )
    drivers.add_parser("recommend")
    drivers.add_parser("install-recommended")
    drivers.add_parser("firmware")
    drivers.add_parser("update-firmware")
    drivers.add_parser("generic-wifi")
    drivers.add_parser("generic-networking")

    snapshots = commands.add_parser("snapshots", help="manage restore points").add_subparsers(
        dest="snapshot_command", required=True
    )
    snapshots.add_parser("list")
    create = snapshots.add_parser("create")
    create.add_argument("--description", default="Manual restore point")
    rollback = snapshots.add_parser("rollback")
    rollback.add_argument("number", type=int)

    recovery = commands.add_parser("recovery", help="diagnose and repair an installation").add_subparsers(
        dest="recovery_command", required=True
    )
    recovery.add_parser("diagnostics")
    recovery.add_parser("discover")
    recovery.add_parser("repair-network")
    recovery.add_parser("reset-settings")
    bootloader = recovery.add_parser("repair-bootloader")
    bootloader.add_argument("root_device")
    bootloader.add_argument("--efi-device")

    features = commands.add_parser("feature", help="manage optional capability profiles").add_subparsers(
        dest="feature_command", required=True
    )
    features.add_parser("list")
    feature_enable = features.add_parser("enable")
    feature_enable.add_argument("name")
    feature_disable = features.add_parser("disable")
    feature_disable.add_argument("name")

    compatibility = commands.add_parser("compatibility", help="query application compatibility").add_subparsers(
        dest="compatibility_command", required=True
    )
    lookup = compatibility.add_parser("lookup")
    lookup.add_argument("value")
    search = compatibility.add_parser("search")
    search.add_argument("query", nargs="?", default="")

    macos = commands.add_parser("macos", help="inspect experimental macOS compatibility").add_subparsers(
        dest="macos_command", required=True
    )
    macos.add_parser("runtime")
    inspect = macos.add_parser("inspect")
    inspect.add_argument("bundle")
    macos.add_parser("setup")

    preference = commands.add_parser("preference", help="change a system-wide preference")
    preference.add_argument("key", choices=["diagnostics", "transparency", "macos-preview"])
    preference.add_argument("value", choices=["enabled", "disabled"])
    preference.add_argument("--acknowledge-compatibility-warning", action="store_true")

    ssh = commands.add_parser("ssh", help="enable or disable remote login")
    ssh.add_argument("state", choices=["enable", "disable"])

    finalize = commands.add_parser("install-finalize", help=argparse.SUPPRESS)
    finalize.add_argument("target")
    finalize.add_argument("--live-medium", default="/run/live/medium")
    commands.add_parser("initialize", help=argparse.SUPPRESS)
    return parser


def dispatch(args: argparse.Namespace) -> Any:
    if args.command == "status":
        return system_status()
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
    args = parser.parse_args(argv)
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


if __name__ == "__main__":
    raise SystemExit(main())
