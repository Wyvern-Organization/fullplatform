import os
from pathlib import Path

from mythos.constants import STATE_DIR, rooted
from mythos.upgrade import SCHEMA_VERSION, migrate, status


def test_release_migration_is_idempotent_and_preserves_newer_state(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MYTHOS_ROOT", str(tmp_path))
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    state_dir = tmp_path / STATE_DIR.removeprefix("/")
    state_dir.mkdir(parents=True)
    (state_dir / "update-state.json").write_text('{"status": "staged"}\n', encoding="utf-8")
    (state_dir / "updates.json").write_text('[]\n', encoding="utf-8")

    first = migrate()
    assert first["schema_version"] == SCHEMA_VERSION
    assert first["applied"] == [1]
    assert (state_dir / "update.json").exists()
    assert (state_dir / "update-history.json").exists()

    second = migrate()
    assert second["applied"] == []
    assert status()["schema_version"] == SCHEMA_VERSION
    assert rooted("/var/lib/mythos/upgrade.json").exists()
