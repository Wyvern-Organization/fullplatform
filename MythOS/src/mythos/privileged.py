from __future__ import annotations

import json
import subprocess
from collections.abc import Sequence
from typing import Any

from .features import load_profiles
from .util import MythOSError


_ACTIONS = {
    ("update", "check"): "org.mythos.control.update-check",
    ("update", "stage"): "org.mythos.control.update-stage",
    ("update", "channel"): "org.mythos.control.update-channel",
    ("drivers", "install-recommended"): "org.mythos.control.drivers-install",
    ("drivers", "generic-wifi"): "org.mythos.control.wifi-activate",
    ("drivers", "generic-networking"): "org.mythos.control.networking-activate",
    ("drivers", "update-firmware"): "org.mythos.control.firmware-update",
    ("snapshots", "create"): "org.mythos.control.snapshot-create",
    ("snapshots", "rollback"): "org.mythos.control.snapshot-rollback",
    ("recovery", "repair-network"): "org.mythos.control.network-repair",
    ("preference",): "org.mythos.control.preference-set",
    ("ssh",): "org.mythos.control.remote-login",
}


def action_for(argv: Sequence[str]) -> str:
    """Validate an operation before it reaches the root command dispatcher."""

    values = tuple(argv)
    if values in {("update", "check"), ("update", "check", "--refresh")}:
        return _ACTIONS[("update", "check")]
    if values == ("update", "stage"):
        return _ACTIONS[("update", "stage")]
    if len(values) == 3 and values[:2] == ("update", "channel") and values[2] in {"stable", "current"}:
        return _ACTIONS[("update", "channel")]
    if len(values) == 2 and values[:1] == ("drivers",) and values[1] in {
        "install-recommended",
        "generic-wifi",
        "generic-networking",
        "update-firmware",
    }:
        return _ACTIONS[values]
    if values == ("snapshots", "create"):
        return _ACTIONS[("snapshots", "create")]
    if len(values) == 3 and values[:2] == ("snapshots", "rollback") and values[2].isdigit() and int(values[2]) > 0:
        return _ACTIONS[("snapshots", "rollback")]
    if values == ("recovery", "repair-network"):
        return _ACTIONS[("recovery", "repair-network")]
    if len(values) == 3 and values[0] == "feature" and values[1] in {"enable", "disable"} and values[2] in load_profiles():
        return f"org.mythos.control.feature-{values[2]}"
    if len(values) in {3, 4} and values[:1] == ("preference",):
        key, value = values[1:3]
        acknowledged = values[3:] == ("--acknowledge-compatibility-warning",)
        valid = key in {"diagnostics", "transparency", "macos-preview"} and value in {"enabled", "disabled"}
        if valid and (len(values) == 3 or (key == "macos-preview" and value == "enabled" and acknowledged)):
            return _ACTIONS[("preference",)]
    if len(values) == 2 and values[0] == "ssh" and values[1] in {"enable", "disable"}:
        return _ACTIONS[("ssh",)]
    raise MythOSError("This privileged operation is not allowed.")


def authorize_sender(sender: str, action: str) -> None:
    result = subprocess.run(
        ["pkcheck", "--action-id", action, "--system-bus-name", sender, "--allow-user-interaction"],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    if result.returncode != 0:
        raise MythOSError("Administrator authorization was not granted.")


def execute(argv: Sequence[str]) -> dict[str, Any]:
    action_for(argv)
    result = subprocess.run(
        ["/usr/bin/mythosctl", "--compact", *argv],
        capture_output=True,
        text=True,
        check=False,
        timeout=7200,
    )
    stream = result.stdout if result.returncode == 0 else result.stderr
    try:
        payload = json.loads(stream.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        payload = {"error": stream.strip() or "Privileged operation failed.", "ok": False}
    if result.returncode != 0:
        raise MythOSError(str(payload.get("error", "Privileged operation failed.")))
    return payload
