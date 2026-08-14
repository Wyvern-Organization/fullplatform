from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402

from .migration import MigrationItem, WindowsProfile, build_plan, discover_windows_profiles, execute_plan
from .util import bytes_to_human


APP_ID = "org.mythos.Migration"


class MigrationAssistant(Adw.Application):
    def __init__(self) -> None:
        super().__init__(application_id=APP_ID)
        self.window: Adw.ApplicationWindow | None = None
        self.toast: Adw.ToastOverlay | None = None
        self.profiles: list[WindowsProfile] = []
        self.profile_row: Adw.ComboRow | None = None
        self.checks: dict[str, Gtk.CheckButton] = {}
        self.summary: Gtk.Label | None = None
        self.import_button: Gtk.Button | None = None
        self.progress: Gtk.ProgressBar | None = None
        self.plan: list[MigrationItem] = []
        self.running = False

    def do_activate(self) -> None:
        if self.window:
            self.window.present()
            return
        self.window = Adw.ApplicationWindow(application=self, title="Move from Windows")
        self.window.set_default_size(820, 680)
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        root.append(Adw.HeaderBar())
        self.toast = Adw.ToastOverlay()
        scroll = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER)
        content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=22)
        content.set_margin_top(28)
        content.set_margin_bottom(38)
        content.set_margin_start(40)
        content.set_margin_end(40)
        title = Gtk.Label(label="Bring your things with you", xalign=0, wrap=True)
        title.add_css_class("title-1")
        subtitle = Gtk.Label(
            label="MythOS copies into your account, never deletes the Windows copy, and renames conflicts instead of overwriting files.",
            xalign=0,
            wrap=True,
        )
        subtitle.add_css_class("dim-label")
        content.append(title)
        content.append(subtitle)

        source = Adw.PreferencesGroup(title="Windows account")
        self.profiles = discover_windows_profiles()
        if self.profiles:
            model = Gtk.StringList.new([f"{item.username} — {item.installation}" for item in self.profiles])
            self.profile_row = Adw.ComboRow(title="Import from", subtitle="Only mounted Windows installations are shown.", model=model)
            self.profile_row.connect("notify::selected", lambda _row, _param: self._preview())
            source.add(self.profile_row)
        else:
            missing = Adw.ActionRow(
                title="No mounted Windows installation found",
                subtitle="Open Files, select the Windows drive, then scan again. BitLocker drives must be unlocked first.",
            )
            missing.add_prefix(Gtk.Image.new_from_icon_name("drive-harddisk-symbolic"))
            missing.add_suffix(self._button("Scan again", lambda _button: self._rescan()))
            source.add(missing)
        content.append(source)

        choose = Adw.PreferencesGroup(
            title="Choose what to copy",
            description="Browser passwords protected by Windows are not copied. Supported bookmarks are exported for import.",
        )
        categories = (
            ("documents", "Documents", True),
            ("desktop", "Desktop", True),
            ("pictures", "Pictures", True),
            ("videos", "Videos", True),
            ("music", "Music", True),
            ("bookmarks", "Browser bookmarks", True),
            ("wallpapers", "Wallpapers and themes", True),
            ("fonts", "Fonts", False),
            ("steam", "Steam library settings", True),
        )
        previous: Gtk.CheckButton | None = None
        for key, label, active in categories:
            row = Adw.ActionRow(title=label)
            check = Gtk.CheckButton(active=active, valign=Gtk.Align.CENTER)
            if previous:
                check.set_group(None)
            check.connect("toggled", lambda _check: self._preview())
            row.add_prefix(check)
            choose.add(row)
            self.checks[key] = check
            previous = check
        content.append(choose)

        review = Adw.PreferencesGroup(title="Review")
        review_row = Adw.ActionRow(title="Copy estimate")
        self.summary = Gtk.Label(label="Choose a Windows account to preview.", xalign=1, wrap=True)
        self.summary.add_css_class("dim-label")
        review_row.add_suffix(self.summary)
        review.add(review_row)
        self.progress = Gtk.ProgressBar(show_text=True, visible=False)
        content.append(review)
        content.append(self.progress)
        actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12, halign=Gtk.Align.END)
        cancel = Gtk.Button(label="Close")
        cancel.connect("clicked", lambda _button: self.window.close() if self.window else None)
        self.import_button = Gtk.Button(label="Copy to MythOS", sensitive=bool(self.profiles))
        self.import_button.add_css_class("suggested-action")
        self.import_button.connect("clicked", self._start)
        actions.append(cancel)
        actions.append(self.import_button)
        content.append(actions)

        scroll.set_child(content)
        self.toast.set_child(scroll)
        root.append(self.toast)
        self.toast.set_vexpand(True)
        self.window.set_content(root)
        self.window.present()
        self._preview()

    @staticmethod
    def _button(label: str, callback: Any) -> Gtk.Button:
        button = Gtk.Button(label=label, valign=Gtk.Align.CENTER)
        button.connect("clicked", callback)
        return button

    def _selected_categories(self) -> list[str]:
        return [key for key, check in self.checks.items() if check.get_active()]

    def _preview(self) -> None:
        if not self.profiles or not self.profile_row or not self.summary:
            return
        selected = min(self.profile_row.get_selected(), len(self.profiles) - 1)
        self.plan = build_plan(self.profiles[selected], Path.home(), self._selected_categories())
        files = sum(item.files for item in self.plan)
        size = sum(item.bytes for item in self.plan)
        self.summary.set_label(f"{files:,} files · {bytes_to_human(size)}")
        if self.import_button:
            self.import_button.set_sensitive(files > 0 and not self.running)

    def _rescan(self) -> None:
        self.profiles = discover_windows_profiles()
        if self.profiles:
            self._notify("Windows installation found. Reopen Move from Windows to select it.")
        else:
            self._notify("No mounted Windows installation was found.")

    def _start(self, button: Gtk.Button) -> None:
        if self.running or not self.plan:
            return
        self.running = True
        button.set_sensitive(False)
        if self.progress:
            self.progress.set_visible(True)
            self.progress.set_text("Copying…")
            GLib.timeout_add(180, self._pulse)
        plan = list(self.plan)

        def worker() -> None:
            result = execute_plan(plan)
            GLib.idle_add(self._complete, result)

        threading.Thread(target=worker, daemon=True).start()

    def _pulse(self) -> bool:
        if not self.running or not self.progress:
            return False
        self.progress.pulse()
        return True

    def _complete(self, result: dict[str, Any]) -> bool:
        self.running = False
        if self.progress:
            self.progress.set_fraction(1)
            self.progress.set_text(f"Copied {result['copied_files']:,} files")
        if self.import_button:
            self.import_button.set_sensitive(True)
            self.import_button.set_label("Copy again")
        warning = f" · {len(result['warnings'])} items need review" if result["warnings"] else ""
        self._notify(f"Move complete{warning}")
        return False

    def _notify(self, message: str) -> None:
        if self.toast:
            self.toast.add_toast(Adw.Toast(title=message, timeout=7))


def main() -> int:
    return MigrationAssistant().run(None)


if __name__ == "__main__":
    raise SystemExit(main())

