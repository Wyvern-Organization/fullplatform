import json
import os
import plistlib
import stat
from pathlib import Path

import pytest

from mythos.macos import assess_bundle, inspect_bundle, launch_command, runtime_info
from mythos.util import MythOSError


def make_bundle(root: Path, *, metal: bool = False) -> Path:
    bundle = root / "Example.app"
    contents = bundle / "Contents"
    executable = contents / "MacOS" / "Example"
    executable.parent.mkdir(parents=True)
    with (contents / "Info.plist").open("wb") as handle:
        plistlib.dump({"CFBundleExecutable": "Example", "CFBundleName": "Example"}, handle)
    executable.write_bytes(b"\xcf\xfa\xed\xfe" + (b"MTLCreateSystemDefaultDevice" if metal else b"plain program"))
    executable.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    return bundle


def make_runtime(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, metal: bool) -> Path:
    binary = tmp_path / "darling"
    binary.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    binary.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    metadata = tmp_path / "runtime.json"
    metadata.write_text(
        json.dumps(
            {
                "source": "https://github.com/darlinghq/darling.git",
                "darling_revision": "test-revision",
                "darling_metal_revision": "test-metal-revision",
                "metal_enabled": metal,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MYTHOS_DARLING_BIN", str(binary))
    monkeypatch.setenv("MYTHOS_DARLING_RUNTIME_INFO", str(metadata))
    return binary


def test_inspect_bundle_resolves_macho_and_metal(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path, metal=True)

    result = inspect_bundle(bundle)

    assert result.display_name == "Example"
    assert result.mach_o is True
    assert result.uses_metal is True
    assert result.executable == str(bundle / "Contents/MacOS/Example")


def test_metal_bundle_requires_verified_metal_build(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    bundle = make_bundle(tmp_path, metal=True)
    make_runtime(tmp_path, monkeypatch, metal=False)

    result = assess_bundle(bundle)

    assert result["verdict"] == "metal-build-required"


def test_launch_command_uses_resolved_executable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    bundle = make_bundle(tmp_path, metal=True)
    binary = make_runtime(tmp_path, monkeypatch, metal=True)

    assert launch_command(bundle) == [str(binary), str(bundle / "Contents/MacOS/Example")]
    assert assess_bundle(bundle)["verdict"] == "metal-experimental"


def test_invalid_bundle_never_launches(tmp_path: Path) -> None:
    bundle = tmp_path / "Broken.app"
    bundle.mkdir()

    assert assess_bundle(bundle)["verdict"] == "invalid-bundle"
    with pytest.raises(MythOSError):
        launch_command(bundle)


def test_runtime_without_metadata_is_not_metal_verified(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    binary = tmp_path / "darling"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    binary.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    monkeypatch.setenv("MYTHOS_DARLING_BIN", str(binary))
    monkeypatch.setenv("MYTHOS_DARLING_RUNTIME_INFO", str(tmp_path / "missing.json"))
    monkeypatch.delenv("PATH", raising=False)

    result = runtime_info()

    assert result.installed is True
    assert result.metal_enabled is False
    assert "cannot verify" in result.detail
