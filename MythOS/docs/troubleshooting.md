# MythOS troubleshooting

This page collects host-build and first-boot fixes that are surfaced in
`README.md#troubleshooting` and `mythosctl doctor`.

## Quick health check

On an installed MythOS system or dev checkout:

```bash
mythosctl status              # concise readiness JSON
mythosctl doctor              # full aggregate: system + diagnostics + hardware + updates + snapshots
mythosctl doctor --verbose    # include all snapshots
mythos-doctor --compact       # same via dedicated entry-point (compact JSON)
python3 scripts/validate-project  # repo invariants (catalog, desktop entries, package lists, etc.)
```

## Host build — Linux

| Symptom | Cause | Fix |
| --- | --- | --- |
| `docker: command not found` | Docker not installed | `sudo apt install docker.io && sudo systemctl enable --now docker && sudo usermod -aG docker $USER` then re-login. `make quick` works without Docker. |
| `Cannot connect to Docker daemon` | Daemon not running or permission | `sudo systemctl start docker` and ensure `docker info` succeeds without `sudo` for non-root builds. |
| `No space left on device` during `make iso` | ISO needs ~25 GiB in `MythOS/.build/` | `df -h MythOS/.build` and `make clean-all`. Use ext4/btrfs with sufficient temp. |
| `shellcheck: command not found` | Shell lint optional dep missing | `sudo apt install shellcheck` — `make quick` passes without it; `make validate` will still warn. |
| `mythosctl: command not found` | Package not installed in dev venv | `make dev && source .venv/bin/activate && mythosctl --help` or `PYTHONPATH=src python3 -m mythos.cli --help`. |
| `pytest: command not found` | pytest not in venv | `.venv/bin/pip install pytest` or `pip install -e ".[dev]"`. |
| `snapper` / `btrfs` errors on dev host | Host is not MythOS-installed | Expected. `mythosctl doctor` will show `atomic_updates: false`. Use a MythOS VM/ISO to test transactions. |
| `permission denied` on privileged ops | Needs root/Polkit | Run via `sudo mythosctl ...` or System Hub (Polkit prompt). |
| `FileNotFoundError: data/polkit/...` in pytest | Wrong working dir | `cd MythOS && python3 -m pytest -q`. Test resolves policy relative to repo root. |
| Debian 12 host | Mirror skew | `make quick`/`validate` fine; prefer Debian 13 for `make iso` so container vs host mirrors align. |

## Host build — Windows / macOS

MythOS ISOs are built inside a `debian:trixie-slim` Docker container, so Windows/macOS can still run `make quick` (Python) but full ISO assembly is easiest via WSL2 or a Debian VM.

**Windows (WSL2):**

```bash
wsl --install -d Debian
wsl -d Debian -- bash -c 'curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash'
# or inside WSL: bash MythOS/install.sh --iso
```

PowerShell helper exists but only clones and validates Python:

```powershell
irm https://osaii.wyvernhub.net/install/mythos.ps1 | iex
# then inside WSL Debian for ISO: wsl -d Debian -- make iso
```

**macOS:**

```bash
curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash -s -- --dry-run
# for ISO, use a Debian VM or Docker Desktop with a Debian container:
docker info  # verify Docker Desktop
bash MythOS/install.sh
```

## First boot / installed system

| Symptom | Fix |
| --- | --- |
| T2 Intel Mac not seeing `EFI Boot` | In macOS → Startup Security Utility → Allow external boot media. MythOS cannot bypass firmware policy. |
| Recovery partition missing in GRUB | Reinstall GRUB: boot live USB → `mythosctl recovery discover` → `sudo mythosctl recovery repair-bootloader /dev/... --efi-device /dev/...` |
| Update stuck at `staged` | `sudo mythosctl update status` then `sudo mythosctl update cancel` or restart to apply offline. Check `mythosctl doctor`. |
| Update failure → `rollback-pending` | Reboot; initramfs helper restores the pre-update snapshot. Verify with `mythosctl update status` and `snapper -c root list`. |
| No wireless after install | System Hub → Hardware & drivers → `Generic Wi-Fi` or `mythosctl drivers generic-wifi`. Firmware remains vendor-specific. |
| Desktop effects sluggish | System Hub → Privacy & access → disable transparency, or check GPU: `mythosctl hardware`. |

## Getting more help

```bash
make help
mythosctl --help
mythosctl doctor --help
python3 scripts/validate-project  # detailed invariant errors
cat .build/artifacts/iso-build.log  # ISO build log
```

If a build or boot error persists, include output from `mythosctl doctor --verbose` (or `PYTHONPATH=src python3 -m mythos.cli doctor --verbose` on dev hosts) and the failing `make` log when asking for help.
