from __future__ import annotations

import json

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

from .privileged import action_for, authorize_sender, execute
from .util import MythOSError


BUS_NAME = "org.mythos.Privileged"
OBJECT_PATH = "/org/mythos/Privileged"
INTERFACE = "org.mythos.Privileged1"


class PrivilegedService(dbus.service.Object):
    @dbus.service.method(INTERFACE, in_signature="s", out_signature="s", sender_keyword="sender")
    def Execute(self, request: str, sender: str | None = None) -> str:
        try:
            payload = json.loads(request)
            argv = payload.get("argv")
            if not isinstance(argv, list) or not all(isinstance(item, str) for item in argv):
                raise MythOSError("Invalid privileged operation request.")
            action = action_for(argv)
            if not sender:
                raise MythOSError("Privileged caller identity is unavailable.")
            authorize_sender(sender, action)
            return json.dumps(execute(argv), sort_keys=True)
        except (MythOSError, ValueError, json.JSONDecodeError) as exc:
            raise dbus.exceptions.DBusException(str(exc), name="org.mythos.Privileged.Error") from exc


def main() -> int:
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    name = dbus.service.BusName(BUS_NAME, bus=bus)
    PrivilegedService(name, OBJECT_PATH)
    GLib.MainLoop().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
