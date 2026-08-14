from __future__ import annotations

import json
import os
import subprocess
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gdk, Gio, GLib, Gtk  # noqa: E402

from .constants import APP_ID


PageBuilder = Callable[[], Gtk.Widget]


class SystemHub(Adw.Application):
    def __init__(self) -> None:
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
        self.window: Adw.ApplicationWindow | None = None
        self.stack: Gtk.Stack | None = None
        self.toast_overlay: Adw.ToastOverlay | None = None
        self.page_index: dict[str, tuple[str, str]] = {}
        self.status_rows: dict[str, Adw.ActionRow] = {}
        self.feature_rows: dict[str, Adw.ActionRow] = {}
        self.update_group: Adw.PreferencesGroup | None = None
        self.snapshot_group: Adw.PreferencesGroup | None = None
        self.hardware_group: Adw.PreferencesGroup | None = None

    def do_activate(self) -> None:
        if self.window:
            self.window.present()
            return
        self.window = Adw.ApplicationWindow(application=self)
        self._install_css()
        self.window.set_title("MythOS System Hub")
        self.window.set_default_size(1180, 780)

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        header = Adw.HeaderBar()
        header.add_css_class("mythos-header")
        title = Adw.WindowTitle(title="System Hub", subtitle="MythOS")
        header.set_title_widget(title)
        search = Gtk.SearchEntry(placeholder_text="Search settings")
        search.add_css_class("header-search")
        search.set_width_chars(27)
        search.connect("search-changed", self._on_search)
        menu = Gio.Menu()
        menu.append("About MythOS", "app.about")
        menu_button = Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu)
        header.pack_end(menu_button)
        header.pack_end(search)
        outer.append(header)

        self.toast_overlay = Adw.ToastOverlay()
        paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL, wide_handle=True)
        paned.set_position(232)
        paned.set_shrink_start_child(False)
        self.stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE)
        sidebar = Gtk.StackSidebar(stack=self.stack)
        sidebar.add_css_class("navigation-sidebar")
        sidebar.set_size_request(222, -1)
        paned.set_start_child(sidebar)
        paned.set_end_child(self.stack)
        self.toast_overlay.set_child(paned)
        outer.append(self.toast_overlay)
        self.toast_overlay.set_vexpand(True)
        self.window.set_content(outer)

        pages: list[tuple[str, str, str, PageBuilder]] = [
            ("overview", "Overview", "ready security storage update", self._build_overview),
            ("updates", "Updates", "channel stable current rollback offline packages", self._build_updates),
            ("hardware", "Hardware & drivers", "wifi bluetooth graphics firmware printer controller audio", self._build_hardware),
            ("apps", "Apps & compatibility", "software flatpak windows wine gaming appimage ai", self._build_apps),
            ("backup", "Backup", "restore snapshots external drive nas", self._build_backup),
            ("recovery", "Recovery", "diagnostics repair reset boot migration", self._build_recovery),
            ("privacy", "Privacy & access", "firewall encryption secure boot telemetry accessibility macos", self._build_privacy),
            ("developer", "Developer", "git python containers virtual machines ssh terminal packages", self._build_developer),
        ]
        for key, label, keywords, builder in pages:
            self.stack.add_titled(builder(), key, label)
            self.page_index[key] = (label, keywords)

        requested_page = os.environ.get("MYTHOS_START_PAGE", "")
        if requested_page in self.page_index:
            self.stack.set_visible_child_name(requested_page)

        about_action = Gio.SimpleAction.new("about", None)
        about_action.connect("activate", self._show_about)
        self.add_action(about_action)
        self.window.present()
        self._refresh_status()

    def _install_css(self) -> None:
        css = Gtk.CssProvider()
        css.load_from_data(
            b"""
            window { background-color: #080b13; color: #eaf1ff; }
            .mythos-header {
              min-height: 52px;
              background-color: alpha(#0d1220, 0.96);
              border-bottom: 1px solid alpha(#cddcff, 0.10);
              box-shadow: 0 4px 18px alpha(#000000, 0.24);
            }
            .header-search {
              min-height: 34px;
              border-radius: 12px;
              background-color: alpha(#1a2235, 0.90);
              border: 1px solid alpha(#dce7ff, 0.11);
            }
            .header-search:focus { border-color: alpha(#6ae7ff, 0.70); }
            .page-content { margin: 34px 42px 52px 42px; }
            .page-title {
              font-family: Manrope, sans-serif;
              font-size: 26pt;
              font-weight: 800;
              letter-spacing: -0.5px;
              color: #f4f7ff;
            }
            .page-subtitle { font-size: 11.5pt; color: alpha(#dce7ff, 0.68); }
            .aurora-hero {
              padding: 28px 30px;
              border-radius: 24px;
              background-image: linear-gradient(125deg, alpha(#1b2440, 0.96), alpha(#101728, 0.94) 58%, alpha(#2c1738, 0.88));
              border: 1px solid alpha(#b9d8ff, 0.14);
              box-shadow: 0 12px 38px alpha(#000000, 0.30);
            }
            .hero-kicker {
              font-family: Adwaita Mono, monospace;
              font-size: 9pt;
              font-weight: 700;
              letter-spacing: 1.4px;
              color: #6ae7ff;
            }
            .hero-title { font-family: Manrope, sans-serif; font-size: 29pt; font-weight: 800; color: #f7f9ff; }
            .hero-subtitle { font-size: 12pt; color: alpha(#eaf1ff, 0.72); }
            .horizon-band {
              min-height: 6px;
              margin-top: 18px;
              border-radius: 999px;
              background-image: linear-gradient(to right, #7587ff, #6ae7ff 52%, #d86cff);
              box-shadow: 0 0 18px alpha(#6ae7ff, 0.30);
            }
            .mythos-group { margin-top: 3px; }
            .mythos-row { min-height: 60px; }
            .mythos-row image { color: #9bb8ff; }
            .mythos-button { min-height: 32px; padding: 0 14px; border-radius: 999px; }
            .suggested-action { background-color: #667cff; color: #ffffff; }
            .suggested-action:hover { background-color: #758aff; }
            .ready-status { border-left: 3px solid #6ae7ff; }
            .attention-status { border-left: 3px solid #d86cff; }
            .dim-label { color: alpha(#dce7ff, 0.66); }
            .navigation-sidebar {
              padding: 16px 10px;
              background-color: alpha(#0d1220, 0.94);
              border-right: 1px solid alpha(#dce7ff, 0.09);
            }
            .navigation-sidebar row { margin: 3px 0; border-radius: 12px; }
            .navigation-sidebar row:selected {
              background-image: linear-gradient(to right, alpha(#667cff, 0.30), alpha(#b267ff, 0.18));
              color: #ffffff;
            }
            """
        )
        display = Gdk.Display.get_default()
        if display:
            Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    def _page(self, title: str, subtitle: str) -> tuple[Gtk.ScrolledWindow, Gtk.Box]:
        scroll = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER)
        content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
        content.add_css_class("page-content")
        heading = Gtk.Label(label=title, xalign=0)
        heading.add_css_class("page-title")
        description = Gtk.Label(label=subtitle, xalign=0, wrap=True)
        description.add_css_class("page-subtitle")
        content.append(heading)
        content.append(description)
        scroll.set_child(content)
        return scroll, content

    @staticmethod
    def _group(title: str, description: str = "") -> Adw.PreferencesGroup:
        group = Adw.PreferencesGroup(title=title, description=description)
        group.add_css_class("mythos-group")
        return group

    @staticmethod
    def _row(title: str, subtitle: str = "", icon: str | None = None) -> Adw.ActionRow:
        row = Adw.ActionRow(title=title, subtitle=subtitle)
        row.add_css_class("mythos-row")
        if icon:
            row.add_prefix(Gtk.Image.new_from_icon_name(icon))
        return row

    @staticmethod
    def _button(label: str, callback: Callable[[Gtk.Button], None], *, suggested: bool = False) -> Gtk.Button:
        button = Gtk.Button(label=label, valign=Gtk.Align.CENTER)
        button.add_css_class("mythos-button")
        if suggested:
            button.add_css_class("suggested-action")
        button.connect("clicked", callback)
        return button

    def _build_overview(self) -> Gtk.Widget:
        scroll, content = self._page("Overview", "The important things, without the operating-system noise.")
        hero = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        hero.add_css_class("aurora-hero")
        kicker = Gtk.Label(label="MYTHOS  /  DAILY DRIVER", xalign=0)
        kicker.add_css_class("hero-kicker")
        hero_title = Gtk.Label(label="Ready when you are.", xalign=0)
        hero_title.add_css_class("hero-title")
        hero_copy = Gtk.Label(
            label="Updates, protection, storage, and recovery stay close—then get out of your way.",
            xalign=0,
            wrap=True,
        )
        hero_copy.add_css_class("hero-subtitle")
        band = Gtk.Box()
        band.add_css_class("horizon-band")
        hero.append(kicker)
        hero.append(hero_title)
        hero.append(hero_copy)
        hero.append(band)
        content.append(hero)

        status_group = self._group("System readiness")
        readiness = self._row("Checking this computer…", "Hardware and protection status will appear here.", "emblem-default-symbolic")
        status_group.add(readiness)
        self.status_rows["readiness"] = readiness
        for key, title, icon in (
            ("updates", "System updates", "software-update-available-symbolic"),
            ("security", "Protection", "security-high-symbolic"),
            ("storage", "Storage", "drive-harddisk-symbolic"),
        ):
            row = self._row(title, "Checking…", icon)
            status_group.add(row)
            self.status_rows[key] = row
        content.append(status_group)

        actions = self._group("Common tasks")
        for title, subtitle, icon, page in (
            ("Install apps", "Flatpak and native apps in one Software window", "system-software-install-symbolic", "apps"),
            ("Back up my files", "External drives, network storage, and restore points", "document-save-symbolic", "backup"),
            ("Check hardware", "Wi-Fi, graphics, audio, cameras, and controllers", "computer-symbolic", "hardware"),
            ("Move from Windows", "Bring personal files and supported settings across safely", "folder-download-symbolic", "recovery"),
        ):
            row = self._row(title, subtitle, icon)
            row.set_activatable(True)
            row.connect("activated", lambda _row, target=page: self._show_page(target))
            actions.add(row)
        content.append(actions)
        return scroll

    def _build_updates(self) -> Gtk.Widget:
        scroll, content = self._page("Updates", "System changes download first, install offline, and keep a restore point.")
        self.update_group = self._group("System update", "No apps are interrupted while packages are being replaced.")
        status = self._row("Checking update state…", "", "software-update-available-symbolic")
        self.update_group.add(status)
        self.status_rows["update-page"] = status
        check = self._button("Check now", lambda button: self._update_check(button))
        status.add_suffix(check)
        install_row = self._row("Install available update", "Downloads now, then asks to restart.", "system-reboot-symbolic")
        install = self._button("Download", lambda button: self._update_stage(button), suggested=True)
        install_row.add_suffix(install)
        self.update_group.add(install_row)
        content.append(self.update_group)

        channel_group = self._group("Update channel", "Both channels keep the tested Debian stable base.")
        model = Gtk.StringList.new(["Stable — recommended", "Current — newer backports"])
        combo = Adw.ComboRow(title="Channel", subtitle="Current offers newer supported software with slightly more change.", model=model)
        combo.connect("notify::selected", self._channel_changed)
        channel_group.add(combo)
        self.status_rows["channel-combo"] = combo
        content.append(channel_group)
        return scroll

    def _build_hardware(self) -> Gtk.Widget:
        scroll, content = self._page("Hardware & drivers", "See what works before installing and keep firmware and drivers current.")
        actions = self._group("Driver manager")
        driver = self._row("Recommended drivers", "Detects graphics, Wi-Fi, Bluetooth, and firmware packages.", "application-x-firmware-symbolic")
        driver.add_suffix(self._button("Install", lambda button: self._privileged(button, ["drivers", "install-recommended"], "Recommended drivers installed.")))
        actions.add(driver)
        wifi = self._row("Generic Wi-Fi", "Enables Linux wireless stack, clears airplane mode, and turns Wi-Fi on. Chipset firmware stays vendor-specific.", "network-wireless-symbolic")
        wifi.add_suffix(self._button("Activate", lambda button: self._privileged(button, ["drivers", "generic-wifi"], "Generic Wi-Fi activated.")))
        actions.add(wifi)
        networking = self._row("Generic networking", "Starts NetworkManager, manages available interfaces, and refreshes DNS without replacing hardware drivers.", "network-workgroup-symbolic")
        networking.add_suffix(self._button("Activate", lambda button: self._privileged(button, ["drivers", "generic-networking"], "Generic networking activated.")))
        actions.add(networking)
        firmware = self._row("Device firmware", "Updates supported laptop, dock, storage, and peripheral firmware.", "software-update-available-symbolic")
        firmware.add_suffix(self._button("Check", lambda button: self._firmware_check(button)))
        actions.add(firmware)
        content.append(actions)

        self.hardware_group = self._group("Live hardware report")
        loading = self._row("Run hardware check", "Nothing is uploaded; serial numbers and network addresses are excluded.", "computer-symbolic")
        loading.add_suffix(self._button("Scan", lambda button: self._hardware_scan(button), suggested=True))
        self.hardware_group.add(loading)
        content.append(self.hardware_group)
        return scroll

    def _build_apps(self) -> Gtk.Widget:
        scroll, content = self._page("Apps & compatibility", "The launcher stays consistent whether an app came from Flatpak, Debian, Windows, or an AppImage.")
        software = self._group("Software")
        store = self._row("Software Center", "Find, install, update, and remove apps.", "system-software-install-symbolic")
        store.add_suffix(self._button("Open", lambda _button: self._launch(["gnome-software"]), suggested=True))
        software.add(store)
        compatibility = self._row("Windows compatibility lookup", "Check status before opening an installer.", "system-search-symbolic")
        entry = Gtk.SearchEntry(placeholder_text="App or installer name", valign=Gtk.Align.CENTER)
        entry.set_width_chars(22)
        entry.connect("activate", self._compatibility_search)
        compatibility.add_suffix(entry)
        software.add(compatibility)
        content.append(software)

        optional = self._group("Optional capabilities", "Only the capabilities you choose are installed.")
        profiles = (
            ("windows-apps", "Windows apps", "Managed Bottles containers with DXVK and VKD3D", "application-x-executable-symbolic"),
            ("gaming", "Gaming", "Steam, Proton tools, GameMode, Vulkan, and controllers", "input-gaming-symbolic"),
            ("appimages", "Portable apps", "Integrate AppImages into the launcher", "application-x-executable-symbolic"),
            ("macos-apps", "macOS Apps", "Experimental Darling runtime with Metal-over-Vulkan", "computer-symbolic"),
            ("local-ai", "Local AI", "Local chat, writing, OCR, and image descriptions", "system-run-symbolic"),
        )
        for key, title, subtitle, icon in profiles:
            row = self._row(title, subtitle, icon)
            row.add_suffix(self._button("Install", lambda button, feature=key: self._feature_enable(button, feature)))
            optional.add(row)
            self.feature_rows[key] = row
        osaii = self._row(
            "OSAII web apps",
            "Optional browser shortcuts for Platform, Studio, and Masque; no local data is shared",
            "web-browser-symbolic",
        )
        osaii_actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        osaii_actions.append(self._button("Remove", lambda button: self._feature_disable(button, "osaii-web-apps")))
        osaii_actions.append(self._button("Add shortcuts", lambda button: self._feature_enable(button, "osaii-web-apps")))
        osaii.add_suffix(osaii_actions)
        optional.add(osaii)
        self.feature_rows["osaii-web-apps"] = osaii
        content.append(optional)
        return scroll

    def _build_backup(self) -> Gtk.Widget:
        scroll, content = self._page("Backup", "Restore a file, a folder, or the whole system without starting over.")
        file_group = self._group("Files")
        deja = self._row("Backups", "Schedule encrypted backups to external drives or network locations.", "document-save-symbolic")
        deja.add_suffix(self._button("Open", lambda _button: self._launch(["deja-dup"]), suggested=True))
        file_group.add(deja)
        pika = self._row("Advanced backups", "Add Borg repositories, NAS targets, and archive browsing.", "network-server-symbolic")
        pika.add_suffix(self._button("Install", lambda button: self._feature_enable(button, "backup-plus")))
        file_group.add(pika)
        content.append(file_group)

        self.snapshot_group = self._group("System restore points", "Restore points protect system files; personal files use Backups above.")
        snapshot = self._row("Create restore point", "Useful before a driver or advanced package change.", "document-save-as-symbolic")
        snapshot.add_suffix(self._button("Create", lambda button: self._privileged(button, ["snapshots", "create"], "Restore point created.")))
        self.snapshot_group.add(snapshot)
        refresh = self._row("Available restore points", "Open Recovery to select and restore one.", "view-refresh-symbolic")
        refresh.set_activatable(True)
        refresh.connect("activated", lambda _row: self._show_page("recovery"))
        self.snapshot_group.add(refresh)
        content.append(self.snapshot_group)
        return scroll

    def _build_recovery(self) -> Gtk.Widget:
        scroll, content = self._page("Recovery", "Diagnose problems, restore the last working system, or repair an installation from the live image.")
        group = self._group("Repair")
        diagnostics = self._row("System diagnostics", "Checks failed services, boot errors, firmware, storage paths, and internet access.", "utilities-system-monitor-symbolic")
        diagnostics.add_suffix(self._button("Run", lambda button: self._diagnostics(button), suggested=True))
        group.add(diagnostics)
        network = self._row("Restart networking", "Restarts NetworkManager and clears the name-lookup cache.", "network-wireless-symbolic")
        network.add_suffix(self._button("Repair", lambda button: self._privileged(button, ["recovery", "repair-network"], "Networking restarted.")))
        group.add(network)
        settings = self._row("Reset desktop settings", "Keeps files and apps; a settings backup is created first.", "edit-undo-symbolic")
        settings.add_suffix(self._button("Reset", lambda button: self._confirm_reset(button)))
        group.add(settings)
        migrate = self._row("Move from Windows", "Documents, pictures, bookmarks, fonts, wallpapers, and Steam metadata.", "folder-download-symbolic")
        migrate.add_suffix(self._button("Start", lambda _button: self._launch(["mythos-migrate"])))
        group.add(migrate)
        content.append(group)

        snapshots = self._group("Rollback")
        list_row = self._row("System restore points", "Load the snapshots stored on this installation.", "document-open-recent-symbolic")
        list_row.add_suffix(self._button("Load", lambda button: self._load_snapshots(button, snapshots)))
        snapshots.add(list_row)
        content.append(snapshots)

        reset_group = self._group("Reset or reinstall", "These actions run from MythOS Recovery so personal files can stay unmounted and safe.")
        reset_row = self._row("Open installation and reset tools", "Boot Recovery from the startup menu for keep-files reset or complete reinstall.", "system-reboot-symbolic")
        reset_group.add(reset_row)
        content.append(reset_group)
        return scroll

    def _build_privacy(self) -> Gtk.Widget:
        scroll, content = self._page("Privacy & accessibility", "No advertising, no forced cloud account, and no diagnostic upload unless you choose it.")
        protection = self._group("Protection")
        for key, title, icon in (
            ("secure-boot", "Secure Boot", "security-high-symbolic"),
            ("encryption", "Disk encryption", "changes-prevent-symbolic"),
            ("firewall", "Firewall", "network-vpn-symbolic"),
        ):
            row = self._row(title, "Checking…", icon)
            protection.add(row)
            self.status_rows[key] = row
        permissions = self._row("Camera, microphone, and location", "Review app permissions in Privacy settings.", "preferences-system-privacy-symbolic")
        permissions.add_suffix(self._button("Open", lambda _button: self._launch(["gnome-control-center", "privacy"])))
        protection.add(permissions)
        content.append(protection)

        choices = self._group("Your choices")
        diagnostics = Adw.SwitchRow(title="Optional diagnostics", subtitle="Off by default. Reports are reviewed before anything is sent.")
        diagnostics.connect("notify::active", self._diagnostics_switch)
        choices.add(diagnostics)
        self.status_rows["diagnostics-switch"] = diagnostics
        transparency = Adw.SwitchRow(
            title="Transparency effects",
            subtitle="Default: a translucent dock and overview. Turn off only if graphics performance is limited.",
        )
        schema_source = Gio.SettingsSchemaSource.get_default()
        panel_schema = (
            schema_source.lookup("org.gnome.shell.extensions.dash-to-panel", True)
            if schema_source
            else None
        )
        if panel_schema:
            panel_settings = Gio.Settings.new_full(panel_schema, None, None)
            transparency.set_active(panel_settings.get_boolean("trans-use-custom-opacity"))
            transparency.connect("notify::active", self._transparency_switch, panel_settings)
        else:
            transparency.set_sensitive(False)
            transparency.set_subtitle("The desktop effects extension is unavailable.")
        choices.add(transparency)
        macos = Adw.SwitchRow(title="macOS compatibility research preview", subtitle="No Apple services, DRM, DriverKit, kernel extensions, or App Store support.")
        macos.connect("notify::active", self._macos_switch)
        choices.add(macos)
        self.status_rows["macos-switch"] = macos
        content.append(choices)

        access = self._group("Accessibility", "Screen reader, magnifier, high contrast, color filters, keyboard access, captions, and typing aids.")
        access_row = self._row("Accessibility settings", "Available in the live environment and before installation.", "preferences-desktop-accessibility-symbolic")
        access_row.add_suffix(self._button("Open", lambda _button: self._launch(["gnome-control-center", "accessibility"]), suggested=True))
        access.add(access_row)
        content.append(access)
        return scroll

    def _build_developer(self) -> Gtk.Widget:
        scroll, content = self._page("Developer & power user", "Advanced tools stay out of the way until they are intentionally enabled.")
        group = self._group("Optional toolsets")
        for key, title, subtitle, icon in (
            ("developer", "Developer mode", "Git, Python, build tools, Podman, and Distrobox", "applications-development-symbolic"),
            ("virtualization", "Virtual machines", "GNOME Boxes, libvirt, virt-manager, and UEFI firmware", "computer-symbolic"),
            ("native-packages", "Advanced package manager", "Browse native Debian packages with Synaptic", "system-software-install-symbolic"),
        ):
            row = self._row(title, subtitle, icon)
            row.add_suffix(self._button("Install", lambda button, feature=key: self._feature_enable(button, feature)))
            group.add(row)
        terminal = self._row("Terminal", "An optional tool, never a requirement for normal operation.", "utilities-terminal-symbolic")
        terminal.add_suffix(self._button("Open", lambda _button: self._launch(["kgx"])))
        group.add(terminal)
        content.append(group)

        remote = self._group("Remote access")
        ssh = Adw.SwitchRow(title="Secure Shell server", subtitle="Disabled by default. Enabling it opens a rate-limited firewall rule.")
        ssh.connect("notify::active", self._ssh_switch)
        remote.add(ssh)
        content.append(remote)
        return scroll

    def _on_search(self, entry: Gtk.SearchEntry) -> None:
        query = entry.get_text().strip().lower()
        if not query or not self.stack:
            return
        for key, (title, keywords) in self.page_index.items():
            if query in f"{title} {keywords}".lower():
                self.stack.set_visible_child_name(key)
                return

    def _show_page(self, key: str) -> None:
        if self.stack:
            self.stack.set_visible_child_name(key)

    def _show_about(self, *_args: Any) -> None:
        if not self.window:
            return
        about = Adw.AboutDialog(
            application_name="MythOS",
            application_icon="org.mythos.SystemHub",
            version="1.0.0",
            developer_name="MythOS Build Team",
            comments="A consumer-first Linux operating system built to be a dependable daily driver.",
        )
        about.present(self.window)

    def _toast(self, message: str) -> None:
        if self.toast_overlay:
            self.toast_overlay.add_toast(Adw.Toast(title=message, timeout=5))

    def _launch(self, argv: list[str]) -> None:
        try:
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE)
        except GLib.Error as exc:
            self._toast(f"Could not open: {exc.message}")

    def _run_ctl(
        self,
        argv: list[str],
        callback: Callable[[dict[str, Any] | list[Any]], None],
        *,
        privileged: bool = False,
        button: Gtk.Button | None = None,
    ) -> None:
        if button:
            button.set_sensitive(False)
        command = (["mythos-privileged"] if privileged else ["mythosctl"]) + ["--compact", *argv]

        def worker() -> None:
            try:
                completed = subprocess.run(command, capture_output=True, text=True, timeout=7500, check=False)
                stream = completed.stdout if completed.returncode == 0 else completed.stderr
                try:
                    value = json.loads(stream.strip().splitlines()[-1] if stream.strip() else "{}")
                except json.JSONDecodeError:
                    value = {"error": stream.strip() or f"Command exited with status {completed.returncode}."}
                if completed.returncode != 0:
                    raise RuntimeError(value.get("error", "The operation did not complete."))
                GLib.idle_add(callback, value)
            except (OSError, subprocess.TimeoutExpired, RuntimeError) as exc:
                GLib.idle_add(self._toast, str(exc))
            finally:
                if button:
                    GLib.idle_add(button.set_sensitive, True)

        threading.Thread(target=worker, daemon=True).start()

    def _privileged(self, button: Gtk.Button, argv: list[str], success: str) -> None:
        self._run_ctl(argv, lambda _value: (self._toast(success), self._refresh_status()), privileged=True, button=button)

    def _refresh_status(self) -> None:
        self._run_ctl(["status"], self._render_status)
        self._run_ctl(["update", "status"], self._render_update_status)

    def _render_status(self, value: dict[str, Any] | list[Any]) -> None:
        if not isinstance(value, dict):
            return
        ready = value.get("health") == "ready"
        row = self.status_rows.get("readiness")
        if row:
            row.remove_css_class("ready-status")
            row.remove_css_class("attention-status")
            row.add_css_class("ready-status" if ready else "attention-status")
            row.set_title("Everything looks ready" if ready else "This computer needs attention")
            row.set_subtitle("No action is needed." if ready else " ".join(value.get("concerns", [])))
        updates = self.status_rows.get("updates")
        if updates:
            updates.set_subtitle(f"{value.get('channel', 'stable').title()} channel · transactional updates {'ready' if value.get('atomic_updates') else 'unavailable'}")
        security = self.status_rows.get("security")
        if security:
            security.set_subtitle(f"Firewall {value.get('firewall')} · Secure Boot {value.get('secure_boot')} · Encryption {value.get('encryption')}")
        storage = self.status_rows.get("storage")
        if storage:
            storage.set_subtitle(f"{value.get('disk', {}).get('free_label', 'Unknown')} free on the system disk")
        mapping = {"secure-boot": "secure_boot", "encryption": "encryption", "firewall": "firewall"}
        for row_key, field in mapping.items():
            target = self.status_rows.get(row_key)
            if target:
                target.set_subtitle(str(value.get(field, "unknown")).replace("-", " ").title())
        diagnostics = self.status_rows.get("diagnostics-switch")
        if isinstance(diagnostics, Adw.SwitchRow):
            diagnostics.handler_block_by_func(self._diagnostics_switch)
            diagnostics.set_active(value.get("diagnostics") == "enabled")
            diagnostics.handler_unblock_by_func(self._diagnostics_switch)

    def _render_update_status(self, value: dict[str, Any] | list[Any]) -> None:
        if not isinstance(value, dict):
            return
        row = self.status_rows.get("update-page")
        if row:
            row.set_title({"staged": "Ready to install", "healthy": "System is current", "failed": "Update needs attention"}.get(value.get("status"), "System update"))
            row.set_subtitle(value.get("message", "Check for updates when it is convenient."))
        combo = self.status_rows.get("channel-combo")
        if isinstance(combo, Adw.ComboRow):
            combo.handler_block_by_func(self._channel_changed)
            combo.set_selected(1 if value.get("channel") == "current" else 0)
            combo.handler_unblock_by_func(self._channel_changed)

    def _update_check(self, button: Gtk.Button) -> None:
        def done(value: dict[str, Any] | list[Any]) -> None:
            count = value.get("count", 0) if isinstance(value, dict) else 0
            self._toast("System is up to date." if count == 0 else f"{count} updates are available.")

        self._run_ctl(["update", "check", "--refresh"], done, privileged=True, button=button)

    def _update_stage(self, button: Gtk.Button) -> None:
        def done(value: dict[str, Any] | list[Any]) -> None:
            message = value.get("message", "Update downloaded.") if isinstance(value, dict) else "Update downloaded."
            self._toast(message)
            self._refresh_status()
            if isinstance(value, dict) and value.get("status") == "staged":
                self._confirm("Restart and install?", "Open apps will close. The update installs before the next desktop starts.", "Restart", lambda: self._launch(["systemctl", "reboot"]))

        self._run_ctl(["update", "stage"], done, privileged=True, button=button)

    def _channel_changed(self, row: Adw.ComboRow, _param: Any) -> None:
        name = "current" if row.get_selected() == 1 else "stable"
        self._run_ctl(["update", "channel", name], lambda _value: self._toast(f"{name.title()} channel selected."), privileged=True)

    def _hardware_scan(self, button: Gtk.Button) -> None:
        def done(value: dict[str, Any] | list[Any]) -> None:
            if not isinstance(value, dict) or not self.hardware_group:
                return
            for check in value.get("checks", []):
                icon = {"supported": "emblem-ok-symbolic", "partial": "dialog-warning-symbolic", "unsupported": "dialog-error-symbolic"}.get(check.get("status"), "radio-symbolic")
                self.hardware_group.add(self._row(check.get("label", "Hardware"), check.get("detail", ""), icon))
            self._toast("Hardware check finished.")

        self._run_ctl(["hardware"], done, button=button)

    def _firmware_check(self, button: Gtk.Button) -> None:
        def done(value: dict[str, Any] | list[Any]) -> None:
            if isinstance(value, dict) and value.get("error"):
                self._toast(value["error"])
            else:
                self._confirm("Install firmware updates?", "The firmware service will install updates offered for supported devices.", "Install", lambda: self._run_ctl(["drivers", "update-firmware"], lambda _v: self._toast("Firmware update finished."), privileged=True))

        self._run_ctl(["drivers", "firmware"], done, button=button)

    def _feature_enable(self, button: Gtk.Button, feature: str) -> None:
        self._run_ctl(["feature", "enable", feature], lambda _value: self._toast("Capability installed."), privileged=True, button=button)

    def _feature_disable(self, button: Gtk.Button, feature: str) -> None:
        self._run_ctl(["feature", "disable", feature], lambda _value: self._toast("Capability removed."), privileged=True, button=button)

    def _compatibility_search(self, entry: Gtk.SearchEntry) -> None:
        query = entry.get_text().strip()
        if not query:
            return

        def done(value: dict[str, Any] | list[Any]) -> None:
            if not isinstance(value, list) or not value:
                self._toast("No matching report. It remains marked untested.")
                return
            item = value[0]
            rating = str(item.get("rating", "untested")).replace("-", " ").title()
            bugs = " ".join(item.get("known_bugs", [])) or "No known issue is recorded."
            self._message(item.get("name", query), f"Rating: {rating}\n\n{bugs}")

        self._run_ctl(["compatibility", "search", query], done)

    def _diagnostics(self, button: Gtk.Button) -> None:
        def done(value: dict[str, Any] | list[Any]) -> None:
            if not isinstance(value, dict):
                return
            failed = [item["label"] for item in value.get("checks", []) if not item.get("ok")]
            self._message("Diagnostics finished", "No problems were found." if not failed else "Needs attention: " + ", ".join(failed))

        self._run_ctl(["recovery", "diagnostics"], done, button=button)

    def _load_snapshots(self, button: Gtk.Button, group: Adw.PreferencesGroup) -> None:
        def done(value: dict[str, Any] | list[Any]) -> None:
            if not isinstance(value, list) or not value:
                self._toast("No restore points are available.")
                return
            for snapshot in value[-8:]:
                number = int(snapshot["number"])
                row = self._row(snapshot.get("description") or f"Restore point {number}", snapshot.get("date", ""), "document-open-recent-symbolic")
                row.add_suffix(self._button("Restore", lambda _button, selected=number: self._confirm("Restore this system version?", "Personal files in Home are kept. A restart is required.", "Restore", lambda: self._run_ctl(["snapshots", "rollback", str(selected)], lambda _v: self._toast("Restore point selected. Restart when ready."), privileged=True), destructive=True)))
                group.add(row)

        self._run_ctl(["snapshots", "list"], done, button=button)

    def _confirm_reset(self, button: Gtk.Button) -> None:
        self._confirm("Reset desktop settings?", "MythOS creates a backup first. Files and installed apps are not changed.", "Reset", lambda: self._run_ctl(["recovery", "reset-settings"], lambda _v: self._toast("Desktop settings reset."), button=button), destructive=True)

    def _preference_switch(self, row: Adw.SwitchRow, key: str) -> None:
        value = "enabled" if row.get_active() else "disabled"
        self._run_ctl(["preference", key, value], lambda _v: self._toast("Preference saved."), privileged=True)

    def _diagnostics_switch(self, row: Adw.SwitchRow, _param: Any) -> None:
        self._preference_switch(row, "diagnostics")

    def _transparency_switch(self, row: Adw.SwitchRow, _param: Any, settings: Gio.Settings) -> None:
        enabled = row.get_active()
        settings.set_boolean("trans-use-custom-opacity", enabled)
        settings.set_double("trans-panel-opacity", 0.82)
        self._launch(["gnome-extensions", "enable" if enabled else "disable", "blur-my-shell@aunetx"])
        self._toast("Transparency effects enabled." if enabled else "Transparency effects disabled.")

    def _macos_switch(self, row: Adw.SwitchRow, _param: Any) -> None:
        if not row.get_active():
            self._run_ctl(["preference", "macos-preview", "disabled"], lambda _v: self._toast("macOS preview disabled."), privileged=True)
            return

        def enable() -> None:
            self._run_ctl(
                ["preference", "macos-preview", "enabled", "--acknowledge-compatibility-warning"],
                lambda _v: self._toast("Research provider enabled. A compatible runtime is still required."),
                privileged=True,
            )

        def cancel() -> None:
            row.handler_block_by_func(self._macos_switch)
            row.set_active(False)
            row.handler_unblock_by_func(self._macos_switch)

        self._confirm(
            "Experimental means incomplete",
            "Apple ID, iCloud, DRM, App Store, DriverKit, kernel extensions, Continuity, FaceTime, and Messages are not supported. Most modern apps will not run.",
            "Enable preview",
            enable,
            on_cancel=cancel,
        )

    def _ssh_switch(self, row: Adw.SwitchRow, _param: Any) -> None:
        state = "enable" if row.get_active() else "disable"
        if state == "enable":
            self._confirm("Allow remote logins?", "This installs the SSH server, starts it at boot, and opens a rate-limited firewall rule.", "Enable", lambda: self._run_ctl(["ssh", "enable"], lambda _v: self._toast("Remote login enabled."), privileged=True), on_cancel=lambda: row.set_active(False))
        else:
            self._run_ctl(["ssh", "disable"], lambda _v: self._toast("Remote login disabled."), privileged=True)

    def _confirm(
        self,
        heading: str,
        body: str,
        confirm_label: str,
        callback: Callable[[], None],
        *,
        destructive: bool = False,
        on_cancel: Callable[[], None] | None = None,
    ) -> None:
        if not self.window:
            return
        dialog = Adw.AlertDialog(heading=heading, body=body)
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("confirm", confirm_label)
        dialog.set_default_response("cancel")
        dialog.set_close_response("cancel")
        dialog.set_response_appearance(
            "confirm", Adw.ResponseAppearance.DESTRUCTIVE if destructive else Adw.ResponseAppearance.SUGGESTED
        )

        def response(_dialog: Adw.AlertDialog, name: str) -> None:
            if name == "confirm":
                callback()
            elif on_cancel:
                on_cancel()

        dialog.connect("response", response)
        dialog.present(self.window)

    def _message(self, heading: str, body: str) -> None:
        if not self.window:
            return
        dialog = Adw.AlertDialog(heading=heading, body=body)
        dialog.add_response("close", "Close")
        dialog.present(self.window)


def main() -> int:
    app = SystemHub()
    return app.run(None)


def drivers_main() -> int:
    os.environ["MYTHOS_START_PAGE"] = "hardware"
    return main()


def recovery_main() -> int:
    os.environ["MYTHOS_START_PAGE"] = "recovery"
    return main()


if __name__ == "__main__":
    raise SystemExit(main())
