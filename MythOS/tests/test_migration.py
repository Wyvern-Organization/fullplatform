from pathlib import Path

from mythos.migration import WindowsProfile, build_plan, discover_windows_profiles, execute_plan


def make_windows_tree(root: Path) -> WindowsProfile:
    profile = root / "Users" / "Axel"
    (root / "Windows" / "Fonts").mkdir(parents=True)
    (profile / "Documents").mkdir(parents=True)
    (profile / "Pictures").mkdir()
    (profile / "Documents" / "notes.txt").write_text("from Windows", encoding="utf-8")
    (profile / "Pictures" / "photo.jpg").write_bytes(b"jpeg")
    (root / "Windows" / "Fonts" / "family.ttf").write_bytes(b"font")
    bookmark = profile / "AppData" / "Local" / "Google" / "Chrome" / "User Data" / "Default"
    bookmark.mkdir(parents=True)
    (bookmark / "Bookmarks").write_text("{}", encoding="utf-8")
    return WindowsProfile(str(root), "Axel", str(profile))


def test_discovers_windows_profiles(tmp_path: Path) -> None:
    expected = make_windows_tree(tmp_path / "WindowsDrive")
    profiles = discover_windows_profiles([tmp_path])
    assert [(item.username, item.path) for item in profiles] == [(expected.username, expected.path)]


def test_plan_and_copy_never_overwrite(tmp_path: Path) -> None:
    profile = make_windows_tree(tmp_path / "WindowsDrive")
    home = tmp_path / "home"
    (home / "Documents").mkdir(parents=True)
    (home / "Documents" / "notes.txt").write_text("keep me", encoding="utf-8")
    plan = build_plan(profile, home, ["documents", "pictures", "bookmarks", "fonts"])
    result = execute_plan(plan)
    assert result["copied_files"] == 4
    assert (home / "Documents" / "notes.txt").read_text(encoding="utf-8") == "keep me"
    assert (home / "Documents" / "notes (from Windows).txt").read_text(encoding="utf-8") == "from Windows"
    assert (home / ".local/share/fonts/family.ttf").exists()
    assert result["passwords_imported"] is False


def test_copy_skips_source_symlinks(tmp_path: Path) -> None:
    profile = make_windows_tree(tmp_path / "WindowsDrive")
    outside = tmp_path / "secret"
    outside.write_text("do not copy", encoding="utf-8")
    (Path(profile.path) / "Documents" / "link.txt").symlink_to(outside)
    home = tmp_path / "home"
    result = execute_plan(build_plan(profile, home, ["documents"]))
    assert result["copied_files"] == 1
    assert not (home / "Documents" / "link.txt").exists()

