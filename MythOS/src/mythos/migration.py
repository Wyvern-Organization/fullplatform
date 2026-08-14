from __future__ import annotations

import os
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

from .util import MythOSError, safe_name


SKIP_PROFILES = {"all users", "default", "default user", "public", "defaultapppool"}
USER_CATEGORIES = {
    "documents": "Documents",
    "desktop": "Desktop",
    "pictures": "Pictures",
    "videos": "Videos",
    "music": "Music",
}


@dataclass(slots=True)
class WindowsProfile:
    installation: str
    username: str
    path: str


@dataclass(slots=True)
class MigrationItem:
    category: str
    source: str
    destination: str
    files: int
    bytes: int


def _candidate_roots(extra_roots: Iterable[Path] = ()) -> list[Path]:
    roots = [Path("/media"), Path("/mnt"), Path("/run/media"), *extra_roots]
    candidates: set[Path] = set()
    for base in roots:
        if not base.exists():
            continue
        if (base / "Users").is_dir() and (base / "Windows").is_dir():
            candidates.add(base.resolve())
        try:
            children = list(base.glob("*")) + list(base.glob("*/*"))
        except OSError:
            continue
        for child in children:
            try:
                if (child / "Users").is_dir() and (child / "Windows").is_dir():
                    candidates.add(child.resolve())
            except OSError:
                continue
    return sorted(candidates)


def discover_windows_profiles(extra_roots: Iterable[Path] = ()) -> list[WindowsProfile]:
    profiles: list[WindowsProfile] = []
    for root in _candidate_roots(extra_roots):
        try:
            users = list((root / "Users").iterdir())
        except OSError:
            continue
        for user in users:
            if not user.is_dir() or user.name.lower() in SKIP_PROFILES:
                continue
            profiles.append(WindowsProfile(str(root), user.name, str(user.resolve())))
    return profiles


def _tree_stats(path: Path) -> tuple[int, int]:
    if path.is_file():
        try:
            return 1, path.stat().st_size
        except OSError:
            return 0, 0
    count = 0
    size = 0
    for root, directories, files in os.walk(path, followlinks=False):
        directories[:] = [item for item in directories if not (Path(root) / item).is_symlink()]
        for name in files:
            item = Path(root) / name
            if item.is_symlink():
                continue
            try:
                size += item.stat().st_size
                count += 1
            except OSError:
                continue
    return count, size


def _unique_destination(path: Path) -> Path:
    if not path.exists():
        return path
    candidate = path.with_name(f"{path.stem} (from Windows){path.suffix}")
    number = 2
    while candidate.exists():
        candidate = path.with_name(f"{path.stem} (from Windows {number}){path.suffix}")
        number += 1
    return candidate


def _copy_file(source: Path, destination: Path) -> Path:
    if source.is_symlink():
        raise MythOSError(f"Skipped symbolic link: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    target = _unique_destination(destination)
    shutil.copy2(source, target, follow_symlinks=False)
    return target


def _copy_tree(source: Path, destination: Path) -> tuple[int, int, list[str]]:
    copied = 0
    total_bytes = 0
    warnings: list[str] = []
    if not source.exists():
        return copied, total_bytes, warnings
    for root, directories, files in os.walk(source, followlinks=False):
        base = Path(root)
        directories[:] = [item for item in directories if not (base / item).is_symlink()]
        relative = base.relative_to(source)
        for name in files:
            item = base / name
            if item.is_symlink():
                warnings.append(f"Skipped link: {item}")
                continue
            target = destination / relative / name
            try:
                actual = _copy_file(item, target)
                copied += 1
                total_bytes += actual.stat().st_size
            except OSError as exc:
                warnings.append(f"Could not copy {item.name}: {exc}")
    return copied, total_bytes, warnings


def _browser_sources(profile: Path) -> list[tuple[Path, str]]:
    sources: list[tuple[Path, str]] = []
    chromium_roots = {
        "Chrome": profile / "AppData/Local/Google/Chrome/User Data",
        "Edge": profile / "AppData/Local/Microsoft/Edge/User Data",
        "Brave": profile / "AppData/Local/BraveSoftware/Brave-Browser/User Data",
    }
    for browser, root in chromium_roots.items():
        for bookmark in root.glob("*/Bookmarks") if root.exists() else []:
            sources.append((bookmark, f"{browser}-{bookmark.parent.name}-Bookmarks.json"))
    firefox = profile / "AppData/Roaming/Mozilla/Firefox/Profiles"
    if firefox.exists():
        for browser_profile in firefox.glob("*"):
            places = browser_profile / "places.sqlite"
            if places.exists():
                sources.append((places, f"Firefox-{browser_profile.name}-places.sqlite"))
            backups = browser_profile / "bookmarkbackups"
            if backups.exists():
                for bookmark in backups.glob("*.jsonlz4"):
                    sources.append((bookmark, f"Firefox-{browser_profile.name}-{bookmark.name}"))
    return sources


def build_plan(profile: WindowsProfile, target_home: Path, categories: Iterable[str]) -> list[MigrationItem]:
    source_profile = Path(profile.path).resolve()
    installation = Path(profile.installation).resolve()
    requested = set(categories)
    items: list[MigrationItem] = []
    for category, folder in USER_CATEGORIES.items():
        source = source_profile / folder
        if category not in requested or not source.exists():
            continue
        files, size = _tree_stats(source)
        items.append(MigrationItem(category, str(source), str(target_home / folder), files, size))

    import_root = target_home / "MythOS Migration" / safe_name(profile.username)
    if "bookmarks" in requested:
        for source, name in _browser_sources(source_profile):
            files, size = _tree_stats(source)
            items.append(MigrationItem("bookmarks", str(source), str(import_root / "Browser Bookmarks" / name), files, size))
    if "fonts" in requested:
        fonts = installation / "Windows/Fonts"
        for source in fonts.glob("*") if fonts.exists() else []:
            if source.suffix.lower() in {".ttf", ".otf", ".ttc", ".woff", ".woff2"}:
                files, size = _tree_stats(source)
                items.append(MigrationItem("fonts", str(source), str(target_home / ".local/share/fonts" / source.name), files, size))
    if "wallpapers" in requested:
        sources = [installation / "Windows/Web/Wallpaper", source_profile / "AppData/Roaming/Microsoft/Windows/Themes"]
        for source in sources:
            if source.exists():
                files, size = _tree_stats(source)
                items.append(MigrationItem("wallpapers", str(source), str(import_root / "Wallpapers"), files, size))
    if "steam" in requested:
        sources = [
            installation / "Program Files (x86)/Steam/steamapps/libraryfolders.vdf",
            installation / "Program Files/Steam/steamapps/libraryfolders.vdf",
        ]
        for source in sources:
            if source.exists():
                files, size = _tree_stats(source)
                items.append(MigrationItem("steam", str(source), str(import_root / "Steam" / source.name), files, size))
    return items


def execute_plan(items: Iterable[MigrationItem]) -> dict[str, Any]:
    item_list = list(items)
    copied = 0
    total_bytes = 0
    warnings: list[str] = []
    categories: set[str] = set()
    for item in item_list:
        source = Path(item.source)
        destination = Path(item.destination)
        categories.add(item.category)
        try:
            if source.is_dir():
                count, size, item_warnings = _copy_tree(source, destination)
                copied += count
                total_bytes += size
                warnings.extend(item_warnings)
            elif source.is_file():
                actual = _copy_file(source, destination)
                copied += 1
                total_bytes += actual.stat().st_size
        except (OSError, MythOSError) as exc:
            warnings.append(str(exc))
    if "fonts" in categories:
        # Rebuild the current user's font cache; failure does not invalidate copied files.
        from .util import run

        run(["fc-cache", "-f"], timeout=180)
    return {
        "copied_files": copied,
        "copied_bytes": total_bytes,
        "warnings": warnings,
        "passwords_imported": False,
        "password_note": "Windows-protected browser passwords were not copied because they cannot be decrypted safely here.",
        "items": [asdict(item) for item in item_list],
    }
