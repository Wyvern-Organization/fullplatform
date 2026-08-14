from pathlib import Path

from mythos.config import Config


def test_config_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    expected = Config(
        channel="current",
        diagnostics=True,
        macos_preview=True,
        transparency=True,
        enabled_features=["gaming", "developer"],
    )
    expected.save(path)
    actual = Config.load(path)
    assert actual == expected
    assert path.stat().st_mode & 0o777 == 0o644


def test_invalid_config_uses_safe_defaults(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text("this is not toml = [", encoding="utf-8")
    assert Config.load(path) == Config()

