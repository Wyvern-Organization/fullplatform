import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const ScreenRecordingToggle = GObject.registerClass(
class ScreenRecordingToggle extends QuickSettings.QuickToggle {
    constructor() {
        super({
            title: 'Screen recording',
            subtitle: 'Choose a screen or area',
            iconName: 'media-record-symbolic',
            toggleMode: false,
        });
        this.connect('clicked', () => {
            Main.panel.statusArea.quickSettings.menu.close();
            Main.screenshotUI.open();
        });
    }
});

const MythOSIndicator = GObject.registerClass(
class MythOSIndicator extends QuickSettings.SystemIndicator {
    constructor() {
        super();
        this.quickSettingsItems.push(new ScreenRecordingToggle());
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class MythOSExtension extends Extension {
    enable() {
        this._search = new PanelMenu.Button(0.0, 'Search applications and files', false);
        this._search.add_style_class_name('mythos-search');

        const content = new St.BoxLayout({
            style_class: 'mythos-search-content',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(new St.Icon({icon_name: 'system-search-symbolic', style_class: 'system-status-icon'}));
        content.add_child(new St.Label({text: 'Search', y_align: Clutter.ActorAlign.CENTER}));
        this._search.add_child(content);
        this._search.connect('clicked', () => this._openSearch());
        Main.panel.addToStatusArea('mythos-search', this._search, 1, 'left');

        this._quickSettings = new MythOSIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._quickSettings);
    }

    _openSearch() {
        Main.overview.show();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const entry = Main.overview.searchEntry;
            if (entry)
                entry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        this._quickSettings?.destroy();
        this._quickSettings = null;
        this._search?.destroy();
        this._search = null;
    }
}
