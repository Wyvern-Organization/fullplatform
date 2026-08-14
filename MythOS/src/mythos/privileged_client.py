from __future__ import annotations

import argparse
import json
import sys

import dbus

from .privileged_service import BUS_NAME, INTERFACE, OBJECT_PATH


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mythos-privileged")
    parser.add_argument("--compact", action="store_true")
    parser.add_argument("operation", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if not args.operation:
        parser.error("an operation is required")
    try:
        bus = dbus.SystemBus()
        service = bus.get_object(BUS_NAME, OBJECT_PATH)
        payload = service.get_dbus_method("Execute", INTERFACE)(json.dumps({"argv": args.operation}))
        print(json.dumps(json.loads(str(payload)), indent=None if args.compact else 2, sort_keys=not args.compact))
        return 0
    except dbus.DBusException as exc:
        print(json.dumps({"error": exc.get_dbus_message(), "ok": False}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
