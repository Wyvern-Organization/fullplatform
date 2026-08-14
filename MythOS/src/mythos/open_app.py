from __future__ import annotations

import hashlib
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib  # noqa: E402

from .compat import CompatibilityDatabase
from .config import Config
from .macos import assess_bundle, launch_command
from .models import CompatibilityRating
from .util import MythOSError, safe_name


APP_ID = "org.mythos.Open"


RATING_LABELS = {
    CompatibilityRating.KNOWN_WORKING: "Known to work",
    CompatibilityRating.MINOR_FIXES: "Works with minor fixes",
    CompatibilityRating.MAY_HAVE_ISSUES: "May have issues",
    CompatibilityRating.UNTESTED: "Untested",
    CompatibilityRating.KNOWN_BROKEN: "Known broken",
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def _desktop_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("`", "\\`").replace("$", "\\$")
    escaped = escaped.replace("%", "%%")
    return f'"{escaped}"'


def integrate_appimage(source: Path, applications_dir: Path | None = None) -> dict[str, str]:
    source = source.resolve(strict=True)
    if not source.is_file() or source.is_symlink():
        raise MythOSError("Choose a regular AppImage file.")
    with source.open("rb") as handle:
        header = handle.read(12)
    if len(header) < 11 or header[:4] != b"\x7fELF" or header[8:10] != b"AI":
        raise MythOSError("This file does not contain a recognized AppImage header.")

    app_dir = Path.home() / ".local" / "share" / "mythos" / "appimages"
    desktop_dir = applications_dir or Path.home() / ".local" / "share" / "applications"
    app_dir.mkdir(parents=True, exist_ok=True)
    desktop_dir.mkdir(parents=True, exist_ok=True)
    digest = _sha256(source)[:12]
    display_name = safe_name(source.stem.replace(".AppImage", ""), "Portable app")
    destination = app_dir / f"{display_name}-{digest}.AppImage"
    if not destination.exists():
        shutil.copy2(source, destination, follow_symlinks=False)
    destination.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    desktop = desktop_dir / f"mythos-appimage-{digest}.desktop"
    content = (
        "[Desktop Entry]\n"
        "Type=Application\n"
        f"Name={display_name}\n"
        f"Comment=Portable application imported from {source.name}\n"
        f"Exec={_desktop_quote(str(destination))} %U\n"
        f"TryExec={destination}\n"
        "Icon=application-x-executable\n"
        "Terminal=false\n"
        "Categories=Utility;\n"
        "X-MythOS-Source=AppImage\n"
    )
    desktop.write_text(content, encoding="utf-8")
    desktop.chmod(stat.S_IRUSR | stat.S_IWUSR)
    subprocess.run(["update-desktop-database", str(desktop_dir)], check=False, capture_output=True)
    return {"name": display_name, "path": str(destination), "desktop": str(desktop)}


class OpenApplication(Adw.Application):
    def __init__(self) -> None:
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.HANDLES_OPEN)
        self.window: Adw.ApplicationWindow | None = None

    def do_activate(self) -> None:
        if not self.window:
            self.window = Adw.ApplicationWindow(application=self, title="Open application")
            self.window.set_default_size(1, 1)
        self.window.present()

    def do_open(self, files: list[Gio.File], _count: int, _hint: str) -> None:
        self.activate()
        if not files:
            self._message("Nothing to open", "Choose a Windows installer, AppImage, or supported application bundle.")
            return
        path = files[0].get_path()
        if not path:
            self._message("Local file required", "Download the file first, then open it from Files.")
            return
        self._dispatch(Path(path))

    def _dispatch(self, path: Path) -> None:
        suffix = path.suffix.lower()
        if suffix in {".exe", ".msi"}:
            self._windows(path)
        elif suffix == ".appimage":
            self._appimage(path)
        elif suffix == ".app" or (path.is_dir() and path.name.lower().endswith(".app")):
            self._macos(path)
        else:
            self._message("Unsupported portable format", "Software Center can open supported Linux application packages.")

    def _windows(self, path: Path) -> None:
        entry = CompatibilityDatabase().lookup(path.name)
        rating = RATING_LABELS[entry.rating]
        details = [f"Compatibility: {rating}"]
        if entry.anti_cheat not in {"Not applicable", "Unknown"}:
            details.append(f"Anti-cheat: {entry.anti_cheat}")
        details.extend(entry.known_bugs[:3])
        if entry.rating == CompatibilityRating.KNOWN_BROKEN:
            details.append("MythOS will not start an app marked known broken unless its report is updated.")
        if not self.window:
            return
        dialog = Adw.AlertDialog(heading=entry.name, body="\n\n".join(details))
        dialog.add_response("cancel", "Cancel")
        if entry.rating != CompatibilityRating.KNOWN_BROKEN:
            dialog.add_response("run", "Continue in Windows Apps")
            dialog.set_response_appearance("run", Adw.ResponseAppearance.SUGGESTED)
        dialog.set_default_response("cancel")
        dialog.set_close_response("cancel")
        dialog.connect("response", lambda _dialog, response: self._launch_windows(path) if response == "run" else None)
        dialog.present(self.window)

    def _launch_windows(self, path: Path) -> None:
        installed = subprocess.run(
            ["flatpak", "info", "com.usebottles.bottles"], capture_output=True, check=False
        ).returncode == 0
        if not installed:
            self._offer_windows_setup()
            return
        try:
            Gio.Subprocess.new(
                ["flatpak", "run", "com.usebottles.bottles", "-e", str(path)],
                Gio.SubprocessFlags.NONE,
            )
        except GLib.Error as exc:
            self._message("Windows Apps could not start", exc.message)

    def _offer_windows_setup(self) -> None:
        if not self.window:
            return
        dialog = Adw.AlertDialog(
            heading="Set up Windows Apps first",
            body="MythOS uses Bottles to isolate each app and manage Wine, DXVK, VKD3D, registry settings, and runtimes.",
        )
        dialog.add_response("cancel", "Not now")
        dialog.add_response("install", "Set up")
        dialog.set_response_appearance("install", Adw.ResponseAppearance.SUGGESTED)
        dialog.connect("response", lambda _dialog, response: self._install_windows() if response == "install" else None)
        dialog.present(self.window)

    def _install_windows(self) -> None:
        try:
            Gio.Subprocess.new(
                ["mythos-privileged", "feature", "enable", "windows-apps"],
                Gio.SubprocessFlags.NONE,
            )
        except GLib.Error as exc:
            self._message("Setup could not start", exc.message)

    def _appimage(self, path: Path) -> None:
        if not self.window:
            return
        dialog = Adw.AlertDialog(
            heading=f"Add {path.stem}?",
            body="Portable apps are not reviewed by MythOS. Only continue if you trust where this file came from. It will appear in the application launcher.",
        )
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("add", "Add and open")
        dialog.set_response_appearance("add", Adw.ResponseAppearance.SUGGESTED)

        def response(_dialog: Adw.AlertDialog, name: str) -> None:
            if name != "add":
                return
            try:
                result = integrate_appimage(path)
                Gio.Subprocess.new([result["path"]], Gio.SubprocessFlags.NONE)
            except (MythOSError, OSError, GLib.Error) as exc:
                self._message("Portable app could not be added", str(exc))

        dialog.connect("response", response)
        dialog.present(self.window)

    def _macos(self, path: Path) -> None:
        config = Config.load()
        if not config.macos_preview:
            self._message("macOS preview is off", "Enable the research preview in System Hub after reading its compatibility warning.")
            return
        assessment = assess_bundle(path)
        verdict = assessment["verdict"]
        if verdict == "invalid-bundle":
            self._message("macOS bundle could not be inspected", str(assessment["summary"]))
            return
        if verdict in {"runtime-not-installed", "metal-build-required"}:
            self._message("macOS runtime setup needed", str(assessment["summary"]) + " Use System Hub > Apps > macOS Apps to set it up.")
            return
        if not self.window:
            return
        dialog = Adw.AlertDialog(
            heading=f"Run {assessment['bundle']['display_name']}?",
            body=str(assessment["summary"]) + "\n\nApple services, DRM, App Store, DriverKit, kernel extensions, and Continuity remain unsupported.",
        )
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("run", "Try anyway")
        dialog.connect(
            "response",
            lambda _dialog, response: Gio.Subprocess.new(launch_command(path), Gio.SubprocessFlags.NONE)
            if response == "run"
            else None,
        )
        dialog.present(self.window)

    def _message(self, heading: str, body: str) -> None:
        if not self.window:
            return
        dialog = Adw.AlertDialog(heading=heading, body=body)
        dialog.add_response("close", "Close")
        dialog.present(self.window)


def main() -> int:
    return OpenApplication().run(sys.argv)


if __name__ == "__main__":
    raise SystemExit(main())
