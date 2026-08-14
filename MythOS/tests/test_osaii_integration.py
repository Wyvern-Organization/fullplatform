from pathlib import Path

from mythos.features import OSAII_SHORTCUTS, _osaii_shortcut_status, _set_osaii_shortcuts


def test_osaii_shortcuts_are_opt_in_and_removable(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MYTHOS_ROOT", str(tmp_path))

    assert not any(_osaii_shortcut_status().values())
    _set_osaii_shortcuts(True)

    target = tmp_path / "usr/local/share/applications"
    assert all((target / name).is_file() for name in OSAII_SHORTCUTS)
    for name in OSAII_SHORTCUTS:
        content = (target / name).read_text(encoding="utf-8")
        assert "https://osaii.wyvernhub.net" in content
        assert "xdg-open" in content

    _set_osaii_shortcuts(False)
    assert not any(_osaii_shortcut_status().values())

