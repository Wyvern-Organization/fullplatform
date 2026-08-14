from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any


class Health(StrEnum):
    READY = "ready"
    ATTENTION = "attention"
    ACTION_REQUIRED = "action-required"
    UNKNOWN = "unknown"


class Support(StrEnum):
    SUPPORTED = "supported"
    PARTIAL = "partial"
    UNSUPPORTED = "unsupported"
    NOT_DETECTED = "not-detected"


class CompatibilityRating(StrEnum):
    KNOWN_WORKING = "known-working"
    MINOR_FIXES = "minor-fixes"
    MAY_HAVE_ISSUES = "may-have-issues"
    UNTESTED = "untested"
    KNOWN_BROKEN = "known-broken"


@dataclass(slots=True)
class HardwareCheck:
    key: str
    label: str
    status: Support
    detail: str
    devices: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["status"] = self.status.value
        return value


@dataclass(slots=True)
class CompatibilityEntry:
    app_id: str
    name: str
    platform: str
    rating: CompatibilityRating
    aliases: list[str] = field(default_factory=list)
    performance: str = "Unknown"
    graphics: str = "Unknown"
    multiplayer: str = "Unknown"
    audio: str = "Unknown"
    anti_cheat: str = "Not applicable"
    known_bugs: list[str] = field(default_factory=list)
    fixes: list[dict[str, str]] = field(default_factory=list)
    reports: int = 0
    tested_version: str = ""
    tested_on: str = ""
    source: str = ""

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "CompatibilityEntry":
        copy = dict(value)
        copy["rating"] = CompatibilityRating(copy.get("rating", "untested"))
        return cls(**copy)

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["rating"] = self.rating.value
        return value


@dataclass(slots=True)
class CommandResult:
    argv: list[str]
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0

