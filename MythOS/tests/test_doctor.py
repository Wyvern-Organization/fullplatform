from pathlib import Path

import pytest

from mythos.cli import build_parser, _doctor, _version
from mythos.constants import VERSION


def test_version_matches_package_metadata() -> None:
    v = _version()
    assert isinstance(v, str) and v
    assert v == VERSION  # package metadata fallback matches constants


def test_cli_help_shows_doctor_and_version() -> None:
    parser = build_parser()
    help_text = parser.format_help()
    assert "doctor" in help_text
    assert "--version" in help_text
    assert "mythosctl doctor" in help_text or "aggregate health" in help_text.lower()


def test_doctor_output_schema(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MYTHOS_ROOT", str(tmp_path))
    result = _doctor(verbose=False)
    assert "version" in result and result["version"] == VERSION
    assert "healthy" in result
    assert "system" in result and isinstance(result["system"], dict)
    assert "diagnostics" in result and "hardware" in result and "update" in result
    assert "snapshots" in result and "count" in result["snapshots"]
    assert "issues" in result and isinstance(result["issues"], list)


def test_doctor_verbose_includes_snapshots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MYTHOS_ROOT", str(tmp_path))
    result = _doctor(verbose=True)
    assert result.get("verbose") is True
    assert "snapshots" in result


def test_version_file_matches_constants_and_pyproject() -> None:
    root = Path(__file__).resolve().parents[1]
    version_txt = (root / "VERSION").read_text(encoding="utf-8").strip()
    assert version_txt == VERSION
    pyproject = (root / "pyproject.toml").read_text(encoding="utf-8")
    assert f'version = "{VERSION}"' in pyproject or f"version = '{VERSION}'" in pyproject
    # __init__.py should also match
    init_txt = (root / "src/mythos/__init__.py").read_text(encoding="utf-8")
    assert VERSION in init_txt
    # MYTHOS_RELEASE in worker should match
    # check API/mythos.ts if present in parent repo
    mythos_ts = root.parent / "API" / "mythos.ts"
    if mythos_ts.is_file():
        ts_text = mythos_ts.read_text(encoding="utf-8")
        assert f'version: "{VERSION}"' in ts_text or f"version: '{VERSION}'" in ts_text or f'"{VERSION}"' in ts_text
