from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .util import MythOSError, run


CommandRunner = Callable[..., object]


def _network_interfaces(sys_root: Path) -> list[str]:
    try:
        return sorted(path.name for path in sys_root.iterdir() if path.name != "lo")
    except OSError:
        return []


def _wireless_interfaces(sys_root: Path) -> list[str]:
    return [name for name in _network_interfaces(sys_root) if (sys_root / name / "wireless").exists()]


@dataclass(slots=True)
class GenericNetworking:
    """Generic Linux networking recovery; vendor NIC drivers remain kernel-owned."""

    sys_root: Path = Path("/sys/class/net")

    def status(self) -> dict[str, object]:
        interfaces = _network_interfaces(self.sys_root)
        state = run(["nmcli", "networking"], timeout=20)
        return {
            "driver": "GenericNetworking",
            "interfaces": interfaces,
            "networking": state.stdout.strip() or "unknown",
            "ready": bool(interfaces) and state.stdout.strip().lower() == "enabled",
        }

    def activate(self) -> dict[str, object]:
        interfaces = _network_interfaces(self.sys_root)
        if not interfaces:
            raise MythOSError("No network interface was detected.")
        run(["systemctl", "enable", "--now", "NetworkManager.service"], check=True, timeout=120)
        run(["nmcli", "networking", "on"], check=True, timeout=30)
        for interface in interfaces:
            run(["nmcli", "device", "set", interface, "managed", "yes"], timeout=20)
            run(["ip", "link", "set", "dev", interface, "up"], timeout=20)
        run(["resolvectl", "flush-caches"], timeout=30)
        value = self.status()
        value["message"] = "GenericNetworking activated NetworkManager and available interfaces."
        return value


@dataclass(slots=True)
class GenericWifi:
    """Generic cfg80211/mac80211 recovery; chipset modules stay upstream-owned."""

    sys_root: Path = Path("/sys/class/net")

    def status(self) -> dict[str, object]:
        interfaces = _wireless_interfaces(self.sys_root)
        radio = run(["nmcli", "radio", "wifi"], timeout=20)
        return {
            "driver": "GenericWifi",
            "interfaces": interfaces,
            "radio": radio.stdout.strip() or "unknown",
            "ready": bool(interfaces) and radio.stdout.strip().lower() == "enabled",
        }

    def activate(self) -> dict[str, object]:
        networking = GenericNetworking(self.sys_root)
        interfaces = _wireless_interfaces(self.sys_root)
        if not interfaces:
            raise MythOSError("No wireless interface was detected. Install chipset firmware from Recommended drivers first.")
        for module in ("cfg80211", "mac80211"):
            run(["modprobe", module], timeout=30)
        run(["rfkill", "unblock", "wlan"], timeout=30)
        networking.activate()
        run(["nmcli", "radio", "wifi", "on"], check=True, timeout=30)
        value = self.status()
        value["message"] = "GenericWifi enabled Linux wireless services and Wi-Fi radio."
        return value
