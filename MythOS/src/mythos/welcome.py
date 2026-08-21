from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Any

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gdk, Gio, GLib, Gtk  # noqa: E402


APP_ID = "org.mythos.Welcome"
WALLPAPERS = (
    ("Velvet Rays", "velvet-rays.png"),
    ("Neon Circuit", "neon-circuit.png"),
    ("Neon Spectrum", "neon-spectrum.png"),
    ("Aurora Glass", "aurora-glass.png"),
)
WALLPAPER_ROOT = "file:///usr/share/backgrounds/mythos/"


class Welcome(Adw.Application):
    def __init__(self) -> None:
        super().__init__(application_id=APP_ID)
        self.window: Adw.ApplicationWindow | None = None
        self.toast: Adw.ToastOverlay | None = None
        self.live = Path("/run/live/medium").exists()
        try:
            cmdline = Path("/proc/cmdline").read_text(encoding="utf-8")
        except OSError:
            cmdline = ""
        self.boot_action = next(
            (
                item.partition("=")[2]
                for item in cmdline.split()
                if item.startswith("mythos.action=")
            ),
            "",
        )
        self.recovery = "mythos.recovery=1" in cmdline or self.boot_action == "repair"
        self.boot_action_started = False

    @staticmethod
    def marker() -> Path:
        return Path.home() / ".config" / "mythos" / "welcome-complete"

    def do_activate(self) -> None:
        if not self.live and self.marker().exists() and "--force" not in os.sys.argv:
            self.quit()
            return
        if self.live and not self.boot_action_started:
            self.boot_action_started = True
            launched = False
            if self.boot_action == "install":
                launched = self._launch(["calamares-install-debian"])
            elif self.boot_action == "repair":
                launched = self._launch_hub_recovery()
            if launched:
                self.quit()
                return
        if self.window:
            self.window.present()
            return
        self.window = Adw.ApplicationWindow(application=self, title="Welcome to MythOS")
        self.window.set_default_size(1020, 700)
        self._install_css()
        self.toast = Adw.ToastOverlay()
        self.toast.set_child(self._live_page() if self.live else self._installed_page())
        self.window.set_content(self.toast)
        self.window.present()

    def _install_css(self) -> None:
        provider = Gtk.CssProvider()
        provider.load_from_data(
            """
            /* -- MythOS Welcome -- design-system consistency -- */
            window { background-color: #080b13; color: #eaf1ff; }
            headerbar { min-height: 52px; background-color: alpha(#0d1220, 0.96); border-bottom: 1px solid alpha(#dce7ff, 0.10); }
            .welcome-content { margin: 36px 54px 48px 54px; }
            .welcome-title { font-family: 'Manrope', Cantarell, sans-serif; font-weight: 800; font-size: 36pt; letter-spacing: -0.7px; color: #f7f9ff; }
            .welcome-copy { font-size: 13pt; line-height: 1.6; color: alpha(#dce7ff, 0.70); }
            .horizon-band { min-height: 6px; margin-top: 8px; border-radius: 999px; background-image: linear-gradient(to right, #7587ff, #6ae7ff 52%, #d86cff); box-shadow: 0 0 18px alpha(#6ae7ff, 0.30); }
            .choice-card { padding: 14px; border-radius: 18px; background-color: alpha(#111827, 0.72); border: 1px solid alpha(#dce7ff, 0.10); transition: border-color 150ms ease, background-color 150ms ease; }
            .choice-card:hover { border-color: alpha(#6ae7ff, 0.22); background-color: alpha(#111827, 0.84); }
            .choice-card:focus-within { outline: 2px solid #6ae7ff; outline-offset: 2px; }
            button { border-radius: 999px; min-height: 32px; padding: 0 14px; font-family: 'Manrope', sans-serif; font-weight: 600; transition: background-color 150ms ease, border-color 150ms ease, transform 150ms ease; }
            button:hover { transform: translateY(-1px); }
            button:active { transform: scale(0.97); }
            button:focus-visible { outline: 2px solid #6ae7ff; outline-offset: 2px; }
            .suggested-action { background-color: #667cff; color: #ffffff; box-shadow: 0 2px 12px alpha(#667cff, 0.32); }
            .suggested-action:hover { background-color: #7587ff; }
            .skeleton { background-color: alpha(#dce7ff, 0.06); border-radius: 8px; min-height: 12px; }
            /* Respect reduced motion */
            * { transition-timing-function: cubic-bezier(0.2, 0.8, 0.2, 1); }
            """.encode("utf-8")
        )
        display = Gdk.Display.get_default()
        if display:
            Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    def _shell(self, title: str, subtitle: str) -> tuple[Gtk.Box, Gtk.Box]:
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        header = Adw.HeaderBar()
        header.set_show_title(False)
        access = Gtk.Button(icon_name="preferences-desktop-accessibility-symbolic", tooltip_text="Accessibility")
        access.connect("clicked", lambda _button: self._launch(["gnome-control-center", "accessibility"]))
        header.pack_end(access)
        outer.append(header)
        content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18)
        content.add_css_class("welcome-content")
        title_label = Gtk.Label(label=title, xalign=0, wrap=True)
        title_label.add_css_class("welcome-title")
        copy = Gtk.Label(label=subtitle, xalign=0, wrap=True)
        copy.add_css_class("welcome-copy")
        band = Gtk.Box()
        band.add_css_class("horizon-band")
        content.append(title_label)
        content.append(copy)
        content.append(band)
        scroll = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER)
        scroll.set_child(content)
        scroll.set_vexpand(True)
        outer.append(scroll)
        return outer, content

    def _live_page(self) -> Gtk.Widget:
        title = "MythOS Recovery" if self.recovery else "Your computer, ready."
        subtitle = (
            "Repair, restore, reset, or reinstall an existing MythOS system."
            if self.recovery
            else "Try everything first, install when you are comfortable, or repair an existing system."
        )
        outer, content = self._shell(title, subtitle)
        choices = Adw.PreferencesGroup(title="Choose what to do")
        choices.add_css_class("choice-card")
        if not self.recovery:
            trial = Adw.ActionRow(
                title="Try MythOS",
                subtitle="Use Wi-Fi, audio, apps, controllers, and the desktop without changing this computer.",
            )
            trial.add_prefix(Gtk.Image.new_from_icon_name("media-playback-start-symbolic"))
            trial.add_suffix(self._button("Start using it", lambda _button: self.window.close() if self.window else None, True))
            choices.add(trial)
        install = Adw.ActionRow(title="Install", subtitle="Guided setup with optional encryption and a dedicated recovery system.")
        install.add_prefix(Gtk.Image.new_from_icon_name("drive-harddisk-symbolic"))
        install.add_suffix(self._button("Install", lambda _button: self._launch(["calamares-install-debian"]), not self.recovery))
        choices.add(install)
        repair = Adw.ActionRow(title="Repair existing installation", subtitle="Run diagnostics, restore a snapshot, repair networking, or rebuild startup files.")
        repair.add_prefix(Gtk.Image.new_from_icon_name("applications-engineering-symbolic"))
        repair.add_suffix(self._button("Open Recovery", lambda _button: self._launch_hub_recovery(), self.recovery))
        choices.add(repair)
        content.append(choices)

        hardware = Adw.PreferencesGroup(title="Before installing")
        check = Adw.ActionRow(title="Hardware check", subtitle="Wi-Fi, Bluetooth, audio, webcam, graphics, controllers, and printing.")
        check.add_prefix(Gtk.Image.new_from_icon_name("computer-symbolic"))
        check.add_suffix(self._button("Run check", self._hardware_check))
        hardware.add(check)
        reader = Adw.SwitchRow(title="Screen reader", subtitle="Turn Orca on now. Shortcut: Super + Alt + S.")
        reader.connect("notify::active", self._screen_reader)
        hardware.add(reader)
        content.append(hardware)
        return outer

    def _installed_page(self) -> Gtk.Widget:
        outer, content = self._shell(
            "Welcome home.",
            "Your account is local, diagnostics are off, and the essentials are ready. Choose extras now or add them later.",
        )
        appearance = Adw.PreferencesGroup(title="Appearance")
        appearance.add_css_class("choice-card")
        theme = Adw.ComboRow(
            title="Color mode",
            subtitle="Apps that follow the system change together.",
            model=Gtk.StringList.new(["Follow the system", "Light", "Dark"]),
        )
        theme.set_selected(self._current_theme_selection())
        theme.connect("notify::selected", self._theme_changed)
        appearance.add(theme)
        wallpaper = Adw.ComboRow(
            title="Wallpaper",
            subtitle="A dark glass collection designed for MythOS.",
            model=Gtk.StringList.new([name for name, _filename in WALLPAPERS]),
        )
        wallpaper.set_selected(self._current_wallpaper_selection())
        wallpaper.connect("notify::selected", self._wallpaper_changed)
        appearance.add(wallpaper)
        access = Adw.ActionRow(title="Accessibility", subtitle="Screen reader, magnifier, contrast, captions, keyboard, and typing aids.")
        access.add_suffix(self._button("Review", lambda _button: self._launch(["gnome-control-center", "accessibility"])))
        appearance.add(access)
        content.append(appearance)

        extras = Adw.PreferencesGroup(title="Optional capabilities", description="Nothing below is required and each choice can be changed later.")
        for key, title, subtitle, icon in (
            ("windows-apps", "Windows apps", "Managed, isolated compatibility containers", "application-x-executable-symbolic"),
            ("gaming", "Gaming", "Steam, Proton tools, GameMode, and Vulkan", "input-gaming-symbolic"),
            ("local-ai", "Local AI", "Local chat and accessibility assistance", "system-run-symbolic"),
            ("backup-plus", "Advanced backup", "Encrypted Borg backups and NAS targets", "document-save-symbolic"),
        ):
            row = Adw.ActionRow(title=title, subtitle=subtitle)
            row.add_prefix(Gtk.Image.new_from_icon_name(icon))
            row.add_suffix(self._button("Add", lambda button, feature=key: self._install_feature(button, feature)))
            extras.add(row)
        content.append(extras)

        move = Adw.PreferencesGroup(title="Bring your files")
        migrate = Adw.ActionRow(title="Move from Windows", subtitle="Copies files and supported settings without overwriting existing files.")
        migrate.add_prefix(Gtk.Image.new_from_icon_name("folder-download-symbolic"))
        migrate.add_suffix(self._button("Start", lambda _button: self._launch(["mythos-migrate"])))
        move.add(migrate)
        backup = Adw.ActionRow(title="Set up backup", subtitle="Choose an external drive or network location and a schedule.")
        backup.add_prefix(Gtk.Image.new_from_icon_name("document-save-symbolic"))
        backup.add_suffix(self._button("Open", lambda _button: self._launch(["deja-dup"])))
        move.add(backup)
        content.append(move)

        buttons = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12, halign=Gtk.Align.END)
        later = Gtk.Button(label="Finish later")
        later.connect("clicked", lambda _button: self._finish())
        done = Gtk.Button(label="Start using MythOS")
        done.add_css_class("suggested-action")
        done.connect("clicked", lambda _button: self._finish())
        buttons.append(later)
        buttons.append(done)
        content.append(buttons)
        return outer

    @staticmethod
    def _button(label: str, callback: Any, suggested: bool = False) -> Gtk.Button:
        button = Gtk.Button(label=label, valign=Gtk.Align.CENTER)
        if suggested:
            button.add_css_class("suggested-action")
        button.connect("clicked", callback)
        return button

    def _launch_hub_recovery(self) -> bool:
        launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.NONE)
        launcher.setenv("MYTHOS_START_PAGE", "recovery", True)
        try:
            launcher.spawnv(["mythos"])
        except GLib.Error as exc:
            self._notify(exc.message)
            return False
        return True

    def _launch(self, argv: list[str]) -> bool:
        try:
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE)
        except GLib.Error as exc:
            self._notify(exc.message)
            return False
        return True

    def _notify(self, message: str) -> None:
        if self.toast:
            self.toast.add_toast(Adw.Toast(title=message, timeout=6))

    def _screen_reader(self, row: Adw.SwitchRow, _param: Any) -> None:
        value = "true" if row.get_active() else "false"
        subprocess.run(
            ["gsettings", "set", "org.gnome.desktop.a11y.applications", "screen-reader-enabled", value],
            check=False,
        )

    def _theme_changed(self, row: Adw.ComboRow, _param: Any) -> None:
        value = {0: "default", 1: "prefer-light", 2: "prefer-dark"}[row.get_selected()]
        subprocess.run(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", value], check=False)

    def _wallpaper_changed(self, row: Adw.ComboRow, _param: Any) -> None:
        _name, filename = WALLPAPERS[row.get_selected()]
        uri = f"{WALLPAPER_ROOT}{filename}"
        for key in ("picture-uri", "picture-uri-dark"):
            subprocess.run(["gsettings", "set", "org.gnome.desktop.background", key, uri], check=False)

    @staticmethod
    def _current_theme_selection() -> int:
        try:
            scheme = Gio.Settings.new("org.gnome.desktop.interface").get_string("color-scheme")
        except GLib.Error:
            return 2
        return {"default": 0, "prefer-light": 1, "prefer-dark": 2}.get(scheme, 2)

    @staticmethod
    def _current_wallpaper_selection() -> int:
        try:
            uri = Gio.Settings.new("org.gnome.desktop.background").get_string("picture-uri-dark")
        except GLib.Error:
            return 0
        for index, (_name, filename) in enumerate(WALLPAPERS):
            if uri == f"{WALLPAPER_ROOT}{filename}":
                return index
        return 0

    def _hardware_check(self, button: Gtk.Button) -> None:
        button.set_sensitive(False)

        def worker() -> None:
            result = subprocess.run(["mythosctl", "--compact", "hardware"], capture_output=True, text=True, check=False)
            try:
                report = json.loads(result.stdout)
                checks = report.get("checks", [])
                supported = sum(item.get("status") == "supported" for item in checks)
                partial = sum(item.get("status") in {"partial", "unsupported"} for item in checks)
                message = f"{supported} ready"
                if partial:
                    message += f" · {partial} need attention"
            except (json.JSONDecodeError, AttributeError):
                message = "Hardware check could not finish."
            GLib.idle_add(self._notify, message)
            GLib.idle_add(button.set_sensitive, True)

        threading.Thread(target=worker, daemon=True).start()

    def _install_feature(self, button: Gtk.Button, feature: str) -> None:
        button.set_sensitive(False)

        def worker() -> None:
            result = subprocess.run(
                ["mythos-privileged", "--compact", "feature", "enable", feature],
                capture_output=True,
                text=True,
                check=False,
                timeout=7200,
            )
            message = "Capability installed." if result.returncode == 0 else "Installation was cancelled or did not complete."
            GLib.idle_add(self._notify, message)
            GLib.idle_add(button.set_sensitive, True)

        threading.Thread(target=worker, daemon=True).start()

    def _finish(self) -> None:
        marker = self.marker()
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("1\n", encoding="utf-8")
        if self.window:
            self.window.close()


def main() -> int:
    return Welcome().run(None)


if __name__ == "__main__":
    raise SystemExit(main())
