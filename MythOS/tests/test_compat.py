import json
from pathlib import Path

import pytest

from mythos.compat import CompatibilityDatabase
from mythos.models import CompatibilityRating
from mythos.util import MythOSError


def test_lookup_matches_filename_alias(tmp_path: Path) -> None:
    source = tmp_path / "compatibility.json"
    source.write_text(
        json.dumps(
            {
                "schema": 1,
                "generated": "2026-08-07",
                "entries": [
                    {
                        "app_id": "example",
                        "name": "Example App",
                        "platform": "windows",
                        "rating": "minor-fixes",
                        "aliases": ["example-setup*.exe"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    database = CompatibilityDatabase(source)
    result = database.lookup("Example-Setup-4.2.exe")
    assert result.app_id == "example"
    assert result.rating == CompatibilityRating.MINOR_FIXES


def test_unknown_app_stays_untested(tmp_path: Path) -> None:
    source = tmp_path / "compatibility.json"
    source.write_text('{"schema": 1, "entries": []}', encoding="utf-8")
    result = CompatibilityDatabase(source).lookup("Mystery.exe")
    assert result.rating == CompatibilityRating.UNTESTED
    assert result.name == "Mystery"


def test_rejects_unsupported_database_schema(tmp_path: Path) -> None:
    source = tmp_path / "compatibility.json"
    source.write_text('{"schema": 99, "entries": []}', encoding="utf-8")
    with pytest.raises(MythOSError):
        CompatibilityDatabase(source)

