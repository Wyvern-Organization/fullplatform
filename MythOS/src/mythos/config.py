from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .constants import CONFIG_FILE, rooted
from .util import atomic_write


@dataclass(slots=True)
class Config:
    channel: str = "stable"
    diagnostics: bool = False
    macos_preview: bool = False
    transparency: bool = False
    enabled_features: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.enabled_features = sorted(set(self.enabled_features))

    @classmethod
    def load(cls, path: Path | None = None) -> "Config":
        target = path or rooted(CONFIG_FILE)
        try:
            with target.open("rb") as handle:
                raw: dict[str, Any] = tomllib.load(handle)
        except (FileNotFoundError, OSError, tomllib.TOMLDecodeError):
            return cls()
        system = raw.get("system", {})
        privacy = raw.get("privacy", {})
        appearance = raw.get("appearance", {})
        features = raw.get("features", {})
        return cls(
            channel=system.get("channel", "stable"),
            diagnostics=bool(privacy.get("diagnostics", False)),
            macos_preview=bool(features.get("macos_preview", False)),
            transparency=bool(appearance.get("transparency", False)),
            enabled_features=list(features.get("enabled", [])),
        )

    def save(self, path: Path | None = None) -> None:
        target = path or rooted(CONFIG_FILE)
        enabled = ", ".join(f'"{item}"' for item in sorted(set(self.enabled_features)))
        text = (
            "# Managed by MythOS System Hub.\n"
            "[system]\n"
            f'channel = "{self.channel}"\n\n'
            "[privacy]\n"
            f"diagnostics = {str(self.diagnostics).lower()}\n\n"
            "[appearance]\n"
            f"transparency = {str(self.transparency).lower()}\n\n"
            "[features]\n"
            f"macos_preview = {str(self.macos_preview).lower()}\n"
            f"enabled = [{enabled}]\n"
        )
        atomic_write(target, text, mode=0o644)
