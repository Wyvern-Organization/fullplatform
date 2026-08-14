from __future__ import annotations

import json
import os
import plistlib
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .util import MythOSError, run


DARLING_SOURCE = "https://github.com/darlinghq/darling.git"
DARLING_REVISION = "e471d067655f887a22b6ae6cedbc224f40c037cf"
DARLING_METAL_SOURCE = "https://github.com/darlinghq/darling-metal.git"
DARLING_METAL_REVISION = "f815654533fe0515f709bf4def29ae523b09414c"
RUNTIME_INFO = Path("/opt/mythos/darling/share/mythos/runtime.json")

_MACHO_MAGICS = {
    b"\xce\xfa\xed\xfe",  # MH_MAGIC
    b"\xcf\xfa\xed\xfe",  # MH_MAGIC_64
    b"\xfe\xed\xfa\xce",  # MH_CIGAM
    b"\xfe\xed\xfa\xcf",  # MH_CIGAM_64
    b"\xca\xfe\xba\xbe",  # FAT_MAGIC
    b"\xbe\xba\xfe\xca",  # FAT_CIGAM
    b"\xca\xfe\xba\xbf",  # FAT_MAGIC_64
    b"\xbf\xba\xfe\xca",  # FAT_CIGAM_64
}
_METAL_MARKERS = (
    b"/System/Library/Frameworks/Metal.framework",
    b"/System/Library/Frameworks/MetalKit.framework",
    b"MTLCreateSystemDefaultDevice",
    b"CAMetalLayer",
    b"MetalPerformanceShaders",
)


@dataclass(frozen=True, slots=True)
class BundleInspection:
    bundle: str
    executable: str | None
    display_name: str
    mach_o: bool
    metal_indicators: tuple[str, ...]
    error: str | None = None

    @property
    def uses_metal(self) -> bool:
        return bool(self.metal_indicators)

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["uses_metal"] = self.uses_metal
        return value


@dataclass(frozen=True, slots=True)
class RuntimeInfo:
    binary: str | None
    installed: bool
    metal_enabled: bool
    revision: str | None
    metal_revision: str | None
    source: str | None
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _runtime_info_path() -> Path:
    return Path(os.environ.get("MYTHOS_DARLING_RUNTIME_INFO", RUNTIME_INFO))


def _runtime_binary() -> Path | None:
    override = os.environ.get("MYTHOS_DARLING_BIN")
    candidates = [Path(override)] if override else []
    candidates.extend((Path("/opt/mythos/darling/bin/darling"), Path("/usr/bin/darling")))
    discovered = shutil.which("darling")
    if discovered:
        candidates.append(Path(discovered))
    return next((item for item in candidates if item.is_file() and os.access(item, os.X_OK)), None)


def runtime_info() -> RuntimeInfo:
    binary = _runtime_binary()
    metadata_path = _runtime_info_path()
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        metadata = {}

    metal_enabled = bool(metadata.get("metal_enabled", False))
    installed = binary is not None
    if not installed:
        detail = "Darling runtime is not installed."
    elif not metadata:
        detail = "Darling runtime found, but MythOS cannot verify its Metal build profile."
    elif not metal_enabled:
        detail = "Darling runtime found without MythOS's Metal build profile."
    else:
        detail = "Darling runtime found with experimental Metal-over-Vulkan enabled."
    return RuntimeInfo(
        binary=str(binary) if binary else None,
        installed=installed,
        metal_enabled=metal_enabled,
        revision=metadata.get("darling_revision"),
        metal_revision=metadata.get("darling_metal_revision"),
        source=metadata.get("source"),
        detail=detail,
    )


def _find_executable(bundle: Path, metadata: dict[str, Any]) -> Path | None:
    executable = metadata.get("CFBundleExecutable")
    if not isinstance(executable, str) or not executable or "/" in executable or "\\" in executable:
        return None
    candidate = bundle / "Contents" / "MacOS" / executable
    return candidate if candidate.is_file() and not candidate.is_symlink() else None


def _marker_hits(path: Path) -> tuple[str, ...]:
    hits: set[bytes] = set()
    overlap = max(len(marker) for marker in _METAL_MARKERS) - 1
    previous = b""
    try:
        with path.open("rb") as handle:
            while block := handle.read(1024 * 1024):
                sample = previous + block
                hits.update(marker for marker in _METAL_MARKERS if marker in sample)
                if len(hits) == len(_METAL_MARKERS):
                    break
                previous = sample[-overlap:]
    except OSError:
        return ()
    return tuple(marker.decode("ascii") for marker in _METAL_MARKERS if marker in hits)


def inspect_bundle(path: Path) -> BundleInspection:
    bundle = path.expanduser().resolve()
    if not bundle.is_dir() or bundle.suffix.lower() != ".app":
        return BundleInspection(str(bundle), None, bundle.stem, False, (), "Choose a macOS .app bundle.")
    plist_path = bundle / "Contents" / "Info.plist"
    try:
        with plist_path.open("rb") as handle:
            metadata = plistlib.load(handle)
    except (OSError, plistlib.InvalidFileException):
        return BundleInspection(str(bundle), None, bundle.stem, False, (), "Bundle has no readable Contents/Info.plist.")
    if not isinstance(metadata, dict):
        return BundleInspection(str(bundle), None, bundle.stem, False, (), "Bundle metadata is invalid.")
    executable = _find_executable(bundle, metadata)
    display_name = metadata.get("CFBundleDisplayName") or metadata.get("CFBundleName") or bundle.stem
    display_name = str(display_name)
    if executable is None:
        return BundleInspection(str(bundle), None, display_name, False, (), "Bundle has no safe executable entry.")
    try:
        with executable.open("rb") as handle:
            mach_o = handle.read(4) in _MACHO_MAGICS
    except OSError:
        mach_o = False
    if not mach_o:
        return BundleInspection(str(bundle), str(executable), display_name, False, (), "Bundle executable is not Mach-O.")
    return BundleInspection(str(bundle), str(executable), display_name, True, _marker_hits(executable))


def assess_bundle(path: Path, runtime: RuntimeInfo | None = None) -> dict[str, Any]:
    inspection = inspect_bundle(path)
    active_runtime = runtime or runtime_info()
    value: dict[str, Any] = {"bundle": inspection.to_dict(), "runtime": active_runtime.to_dict()}
    if inspection.error:
        value.update(verdict="invalid-bundle", summary=inspection.error)
    elif not active_runtime.installed:
        value.update(verdict="runtime-not-installed", summary="Install MythOS macOS Apps before trying this bundle.")
    elif inspection.uses_metal and not active_runtime.metal_enabled:
        value.update(
            verdict="metal-build-required",
            summary="Metal use detected. Install a MythOS-built Darling runtime with Metal-over-Vulkan enabled.",
        )
    elif inspection.uses_metal:
        value.update(
            verdict="metal-experimental",
            summary="Metal use detected. Experimental Metal-over-Vulkan path is available; app compatibility remains unverified.",
        )
    else:
        value.update(
            verdict="launch-candidate",
            summary="Bundle has a runnable Mach-O entry point. Darling compatibility remains per-app and unverified.",
        )
    return value


def launch_command(path: Path) -> list[str]:
    assessment = assess_bundle(path)
    if assessment["verdict"] in {"invalid-bundle", "runtime-not-installed", "metal-build-required"}:
        raise MythOSError(str(assessment["summary"]))
    runtime = assessment["runtime"]["binary"]
    executable = assessment["bundle"]["executable"]
    if not runtime or not executable:
        raise MythOSError("Darling could not find a runnable macOS executable.")
    return [runtime, executable]


def install_runtime() -> dict[str, Any]:
    helper = os.environ.get("MYTHOS_DARLING_BUILD_HELPER", "/usr/libexec/mythos/build-darling-runtime")
    result = run([helper], check=True, timeout=14_400)
    return {"message": "Darling runtime installed.", "runtime": runtime_info().to_dict(), "detail": result.stdout.strip()}
