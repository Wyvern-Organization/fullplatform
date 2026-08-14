import os
from pathlib import Path

from mythos.constants import ROLLBACK_COMPLETE, ROLLBACK_REQUEST, SYSTEM_UPDATE_LINK, SYSTEM_UPDATE_TARGET
from mythos.models import CommandResult
from mythos.updates import (
    _system_update_requested,
    bless_boot,
    consumer_layout_ready,
    parse_simulation,
    schedule_rollback,
)
from mythos.util import read_json, write_json


def test_parse_apt_simulation() -> None:
    output = """Reading package lists... Done
Inst systemd [257.5-2] (257.6-1 Debian:13.1/stable [amd64])
Inst new-package (1.2.3 Debian-Security:13/stable-security [amd64])
Conf systemd (257.6-1 Debian:13.1/stable [amd64])
"""
    updates = parse_simulation(output)
    assert [(item.name, item.installed, item.candidate) for item in updates] == [
        ("systemd", "257.5-2", "257.6-1"),
        ("new-package", "not installed", "1.2.3"),
    ]
    assert [item.security for item in updates] == [False, True]


def test_parse_apt_simulation_ignores_noise() -> None:
    assert parse_simulation("0 upgraded, 0 newly installed, 0 to remove") == []


def test_consumer_layout_requires_separate_state_and_snapshots(monkeypatch) -> None:
    roots = {"/": "/@", "/.snapshots": "/@snapshots", "/var/lib/mythos": "/@state"}

    def fake_run(argv, **_kwargs):
        mountpoint = argv[-1]
        return CommandResult(list(argv), 0, f"btrfs {roots[mountpoint]}\n", "")

    monkeypatch.setattr("mythos.updates.run", fake_run)
    assert consumer_layout_ready()
    roots["/var/lib/mythos"] = "/@"
    assert not consumer_layout_ready()


def test_schedule_and_bless_rollback(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MYTHOS_ROOT", str(tmp_path))
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    (tmp_path / ".snapshots/7/snapshot").mkdir(parents=True)

    request = schedule_rollback(7, "test-transaction")
    assert request == tmp_path / ROLLBACK_REQUEST.removeprefix("/")
    assert request.read_text(encoding="utf-8") == "snapshot=7\ntransaction=test-transaction\n"

    state_path = tmp_path / "var/lib/mythos/update.json"
    write_json(state_path, {"status": "rollback-pending"})
    incomplete = bless_boot()
    assert incomplete["status"] == "failed"

    write_json(state_path, {"status": "rollback-pending"})
    complete = tmp_path / ROLLBACK_COMPLETE.removeprefix("/")
    complete.write_text("snapshot=7\n", encoding="utf-8")
    restored = bless_boot()
    assert restored["status"] == "rolled-back"
    assert not complete.exists()
    assert read_json(state_path, {})["status"] == "rolled-back"


def test_offline_update_link_must_target_mythos(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MYTHOS_ROOT", str(tmp_path))
    link = tmp_path / SYSTEM_UPDATE_LINK.removeprefix("/")
    link.symlink_to(SYSTEM_UPDATE_TARGET)
    assert _system_update_requested()
    link.unlink()
    link.symlink_to("/var/lib/another-updater")
    assert not _system_update_requested()
