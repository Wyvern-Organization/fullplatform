from pathlib import Path
from types import SimpleNamespace

import pytest

from mythos.network_drivers import GenericNetworking, GenericWifi
from mythos.util import MythOSError


def make_interfaces(root: Path) -> None:
    (root / "enp1s0").mkdir(parents=True)
    (root / "wlp2s0" / "wireless").mkdir(parents=True)


def test_generic_networking_activates_interfaces(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sys_root = tmp_path / "net"
    make_interfaces(sys_root)
    calls: list[list[str]] = []

    def fake_run(argv: list[str], **_kwargs: object) -> SimpleNamespace:
        calls.append(argv)
        output = "enabled\n" if argv == ["nmcli", "networking"] else ""
        return SimpleNamespace(ok=True, stdout=output, stderr="")

    monkeypatch.setattr("mythos.network_drivers.run", fake_run)
    result = GenericNetworking(sys_root).activate()

    assert result["ready"] is True
    assert ["nmcli", "device", "set", "enp1s0", "managed", "yes"] in calls
    assert ["ip", "link", "set", "dev", "wlp2s0", "up"] in calls


def test_generic_wifi_enables_wireless_stack(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sys_root = tmp_path / "net"
    make_interfaces(sys_root)
    calls: list[list[str]] = []

    def fake_run(argv: list[str], **_kwargs: object) -> SimpleNamespace:
        calls.append(argv)
        output = "enabled\n" if argv in (["nmcli", "networking"], ["nmcli", "radio", "wifi"]) else ""
        return SimpleNamespace(ok=True, stdout=output, stderr="")

    monkeypatch.setattr("mythos.network_drivers.run", fake_run)
    result = GenericWifi(sys_root).activate()

    assert result["ready"] is True
    assert ["modprobe", "cfg80211"] in calls
    assert ["modprobe", "mac80211"] in calls
    assert ["rfkill", "unblock", "wlan"] in calls
    assert ["nmcli", "radio", "wifi", "on"] in calls


def test_generic_wifi_requires_an_interface(tmp_path: Path) -> None:
    sys_root = tmp_path / "net"
    sys_root.mkdir()

    with pytest.raises(MythOSError, match="No wireless interface"):
        GenericWifi(sys_root).activate()
