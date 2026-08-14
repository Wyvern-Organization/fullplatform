from __future__ import annotations

import fnmatch
import json
import os
from pathlib import Path
from typing import Any

from .constants import catalog_dir
from .models import CompatibilityEntry, CompatibilityRating
from .util import MythOSError


class CompatibilityDatabase:
    def __init__(self, source: Path | None = None):
        self.source = source or catalog_dir() / "compatibility.json"
        self.generated = ""
        self.entries: list[CompatibilityEntry] = []
        self.reload()

    def reload(self) -> None:
        try:
            with self.source.open(encoding="utf-8") as handle:
                payload: dict[str, Any] = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            raise MythOSError(f"Compatibility data could not be read: {exc}") from exc
        if payload.get("schema") != 1 or not isinstance(payload.get("entries"), list):
            raise MythOSError("Compatibility data uses an unsupported format.")
        self.generated = str(payload.get("generated", ""))
        self.entries = [CompatibilityEntry.from_dict(item) for item in payload["entries"]]

    def lookup(self, value: str | os.PathLike[str]) -> CompatibilityEntry:
        query = Path(value).name.lower()
        stem = Path(query).stem
        candidates = [query, stem]
        for entry in self.entries:
            for alias in entry.aliases + [entry.app_id, entry.name]:
                pattern = alias.lower()
                if any(fnmatch.fnmatch(candidate, pattern) or pattern in candidate for candidate in candidates):
                    return entry
        return CompatibilityEntry(
            app_id="unknown",
            name=Path(value).stem or "Unknown application",
            platform="windows",
            rating=CompatibilityRating.UNTESTED,
            aliases=[],
            known_bugs=["No matching compatibility report is available yet."],
        )

    def search(self, query: str) -> list[CompatibilityEntry]:
        value = query.strip().lower()
        if not value:
            return list(self.entries)
        return [
            entry
            for entry in self.entries
            if value in entry.name.lower() or value in entry.app_id.lower() or any(value in item.lower() for item in entry.aliases)
        ]

    def summary(self) -> dict[str, int]:
        counts = {rating.value: 0 for rating in CompatibilityRating}
        for entry in self.entries:
            counts[entry.rating.value] += 1
        return counts

