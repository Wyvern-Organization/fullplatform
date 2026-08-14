from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .models import HardwareCheck, Support
from .util import run


def _pci_blocks() -> list[str]:
    result = run(["lspci", "-nnk"], timeout=20)
    if not result.ok:
        return []
    return [block.strip() for block in re.split(r"\n(?=\S)", result.stdout) if block.strip()]


def _devices_matching(*needles: str) -> list[str]:
    lowered = tuple(value.lower() for value in needles)
    return [block for block in _pci_blocks() if any(value in block.lower() for value in lowered)]


def _device_names(blocks: list[str]) -> list[str]:
    return [block.splitlines()[0].strip() for block in blocks]


def _driver_loaded(block: str) -> bool:
    return "Kernel driver in use:" in block


def check_gpu() -> HardwareCheck:
    devices = _devices_matching("vga compatible controller", "3d controller", "display controller")
    if not devices:
        return HardwareCheck("gpu", "Graphics", Support.NOT_DETECTED, "No graphics adapter was detected.")
    loaded = all(_driver_loaded(device) for device in devices)
    renderer = run(["glxinfo", "-B"], timeout=15)
    software = "llvmpipe" in renderer.stdout.lower() or "softpipe" in renderer.stdout.lower()
    if loaded and not software:
        detail = "Hardware acceleration and a kernel driver are available."
        status = Support.SUPPORTED
    elif loaded:
        detail = "A driver is loaded, but this session is using software rendering."
        status = Support.PARTIAL
    else:
        detail = "The adapter is visible, but no active kernel driver was found."
        status = Support.PARTIAL
    return HardwareCheck("gpu", "Graphics", status, detail, _device_names(devices))


def check_wifi() -> HardwareCheck:
    wireless = [path for path in Path("/sys/class/net").glob("*") if (path / "wireless").exists()]
    devices = _devices_matching("network controller", "wireless")
    names = [item.name for item in wireless] + _device_names(devices)
    if wireless:
        return HardwareCheck("wifi", "Wi-Fi", Support.SUPPORTED, "A wireless interface is ready.", names)
    if devices:
        loaded = any(_driver_loaded(device) for device in devices)
        detail = "A wireless adapter is present but is not ready. Check firmware or airplane mode."
        return HardwareCheck("wifi", "Wi-Fi", Support.PARTIAL if loaded else Support.UNSUPPORTED, detail, names)
    return HardwareCheck("wifi", "Wi-Fi", Support.NOT_DETECTED, "No wireless adapter was detected.")


def check_bluetooth() -> HardwareCheck:
    controllers = list(Path("/sys/class/bluetooth").glob("hci*"))
    result = run(["bluetoothctl", "list"], timeout=10)
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if controllers or lines:
        return HardwareCheck(
            "bluetooth",
            "Bluetooth",
            Support.SUPPORTED,
            "A Bluetooth controller is available.",
            [path.name for path in controllers] + lines,
        )
    usb = run(["lsusb"], timeout=10)
    if "bluetooth" in usb.stdout.lower():
        return HardwareCheck(
            "bluetooth", "Bluetooth", Support.PARTIAL, "The controller is visible but not ready.", []
        )
    return HardwareCheck("bluetooth", "Bluetooth", Support.NOT_DETECTED, "No Bluetooth controller was detected.")


def check_audio() -> HardwareCheck:
    cards = Path("/proc/asound/cards")
    text = cards.read_text(encoding="utf-8", errors="replace") if cards.exists() else ""
    wpctl = run(["wpctl", "status"], timeout=10)
    if text.strip() and "no soundcards" not in text.lower() and wpctl.ok:
        names = [line.strip() for line in text.splitlines() if re.match(r"\s*\d+\s+\[", line)]
        return HardwareCheck("audio", "Audio", Support.SUPPORTED, "PipeWire can see an audio device.", names)
    if text.strip() and "no soundcards" not in text.lower():
        return HardwareCheck("audio", "Audio", Support.PARTIAL, "Audio hardware is present but the session is not ready.")
    return HardwareCheck("audio", "Audio", Support.NOT_DETECTED, "No audio device was detected.")


def check_camera() -> HardwareCheck:
    devices = sorted(Path("/dev").glob("video*"))
    if devices:
        return HardwareCheck(
            "camera", "Webcam", Support.SUPPORTED, "A video capture device is available.", [str(item) for item in devices]
        )
    return HardwareCheck("camera", "Webcam", Support.NOT_DETECTED, "No webcam was detected.")


def check_controllers() -> HardwareCheck:
    joystick = sorted(Path("/dev/input").glob("js*"))
    names: list[str] = []
    for item in Path("/sys/class/input").glob("event*/device/name"):
        try:
            name = item.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if re.search(r"gamepad|controller|joystick|xbox|dualsense|dualshock", name, re.I):
            names.append(name)
    if joystick or names:
        return HardwareCheck(
            "controllers", "Game controllers", Support.SUPPORTED, "A game controller is available.", names
        )
    return HardwareCheck("controllers", "Game controllers", Support.NOT_DETECTED, "No controller is connected.")


def check_printing() -> HardwareCheck:
    result = run(["lpstat", "-v"], timeout=10)
    printers = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    service = run(["systemctl", "is-active", "cups.service"], timeout=10)
    if printers:
        return HardwareCheck("printing", "Printing", Support.SUPPORTED, "A configured printer is available.", printers)
    if service.stdout.strip() == "active":
        return HardwareCheck("printing", "Printing", Support.SUPPORTED, "Printing is ready; no printer is configured.")
    return HardwareCheck("printing", "Printing", Support.PARTIAL, "The printing service is not running.")


def hardware_report() -> dict[str, Any]:
    checks = [
        check_gpu(),
        check_wifi(),
        check_bluetooth(),
        check_audio(),
        check_camera(),
        check_controllers(),
        check_printing(),
    ]
    summary = Support.SUPPORTED
    if any(item.status == Support.UNSUPPORTED for item in checks):
        summary = Support.UNSUPPORTED
    elif any(item.status == Support.PARTIAL for item in checks):
        summary = Support.PARTIAL
    return {
        "schema": 1,
        "summary": summary.value,
        "checks": [item.to_dict() for item in checks],
    }


def recommended_driver_packages() -> list[str]:
    """Return a conservative, repository-backed driver package recommendation."""

    text = "\n".join(_pci_blocks()).lower()
    packages: set[str] = {"firmware-linux", "firmware-misc-nonfree"}
    if "nvidia" in text:
        detection = run(["nvidia-detect"], timeout=20)
        match = re.search(r"(nvidia-(?:tesla-\d+-)?driver)", detection.stdout + detection.stderr)
        packages.add(match.group(1) if match else "nvidia-driver")
    if "amd" in text or "advanced micro devices" in text or "ati technologies" in text:
        packages.update({"firmware-amd-graphics", "mesa-vulkan-drivers"})
    if "intel corporation" in text:
        packages.update({"firmware-intel-graphics", "firmware-iwlwifi", "intel-media-va-driver"})
    if "realtek" in text:
        packages.add("firmware-realtek")
    if "qualcomm atheros" in text or "atheros" in text:
        packages.add("firmware-atheros")
    if "broadcom" in text:
        packages.add("firmware-brcm80211")
    return sorted(packages)


def firmware_updates() -> dict[str, Any]:
    result = run(["fwupdmgr", "get-updates", "--json"], timeout=90)
    if result.ok:
        try:
            payload = json.loads(result.stdout)
            return {"available": True, "updates": payload, "error": ""}
        except json.JSONDecodeError:
            pass
    message = result.stderr.strip() or result.stdout.strip()
    no_updates = "no upgrades" in message.lower() or "no updates" in message.lower()
    return {"available": no_updates, "updates": {}, "error": "" if no_updates else message}

