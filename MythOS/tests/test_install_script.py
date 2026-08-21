from pathlib import Path


def test_install_script_exists_and_is_curlable() -> None:
    root = Path(__file__).resolve().parents[1]
    script = root / "install.sh"
    assert script.is_file(), "MythOS/install.sh must exist for single-line install"
    text = script.read_text(encoding="utf-8")
    assert "curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh" in text
    assert "--dry-run" in text
    assert "make quick" in text or "make validate" in text
    # Must be bash strict
    assert "set -euo pipefail" in text


def test_readme_quickstart_present() -> None:
    root = Path(__file__).resolve().parents[1]
    readme = (root / "README.md").read_text(encoding="utf-8")
    assert "curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash" in readme
    assert "Troubleshooting" in readme
    assert "make quick" in readme


def test_makefile_has_new_targets() -> None:
    root = Path(__file__).resolve().parents[1]
    mk = (root / "Makefile").read_text(encoding="utf-8")
    for target in ("quick:", "dev:", "clean-all:", "help:", "check-deps:"):
        assert target in mk, f"Makefile missing {target}"
    assert "VERSION" in mk
