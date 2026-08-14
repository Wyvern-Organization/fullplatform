import os
from pathlib import Path

from mythos.install import finalize_install


def test_finalize_populates_recovery_and_protects_mount(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    target = tmp_path / "target"
    live = tmp_path / "medium"
    (target / "etc").mkdir(parents=True)
    (target / "recovery").mkdir()
    (target / "etc" / "os-release").write_text("NAME=MythOS\n", encoding="utf-8")
    (target / "etc" / "fstab").write_text(
        "UUID=root / btrfs defaults 0 0\nUUID=recovery /recovery ext4 defaults 0 2\n",
        encoding="utf-8",
    )
    (live / "live").mkdir(parents=True)
    for name in ("filesystem.squashfs", "initrd.img", "vmlinuz"):
        (live / "live" / name).write_bytes(name.encode())

    result = finalize_install(target, live)
    assert sorted(result["copied"]) == ["filesystem.squashfs", "initrd.img", "vmlinuz"]
    assert (target / "recovery/live/filesystem.squashfs").exists()
    fstab = (target / "etc/fstab").read_text(encoding="utf-8")
    assert "ro,nofail,x-systemd.automount" in fstab
    assert (target / "etc/mythos/release").exists()

