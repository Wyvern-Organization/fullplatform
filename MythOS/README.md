# MythOS v1

> **Quick start — single-line install**
> ```bash
> curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash
> # dry-run first?  curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash -s -- --dry-run
> # local clone:     bash MythOS/install.sh --dry-run && bash MythOS/install.sh
> # ISO build:       bash MythOS/install.sh --iso   # needs Docker + 25 GiB tmp
> ```
> Installs deps on Debian/Ubuntu, clones the repo if needed, runs `make quick`/`make validate`,
> and prints next steps (`make package`, `make iso`, `make smoke`). Release metadata: `https://osaii.wyvernhub.net/mythos/release.json` · Docs: [`docs/architecture.md`](docs/architecture.md)
>
> **Troubleshooting:** see [Troubleshooting](#troubleshooting) below.

MythOS is a Debian-based desktop operating system for people who want a
computer, not a Linux hobby. This repository builds an amd64 hybrid live ISO,
the installed operating system, and the native graphical tools that connect
updates, drivers, recovery, migration, application compatibility, backup, and
optional power-user features.

The v1 base is Debian 13 (trixie), GNOME 48 on Wayland, Flatpak with Flathub,
Calamares, Btrfs, Snapper, GRUB, and Debian's signed Secure Boot chain. XWayland
is installed for older applications and GNOME's X11 session remains available
where the hardware stack provides it.

## What is implemented

- A reproducible live/install ISO with BIOS, PC UEFI Secure Boot, and Intel
  Mac UEFI paths. Its hybrid layout includes a GPT EFI partition, Apple
  Partition Map/HFS+ entry, and the standard `EFI/BOOT/BOOTX64.EFI` fallback
  loader.
- A bottom taskbar, Super application menu, panel search control, centered
  running applications, app indicators, clock, notifications, and GNOME Quick
  Settings.
- Velvet Rays, supplied with the original MythOS visual references, is the
  first-boot default in dark mode. Three additional built-in dark neon
  wallpapers (Neon Spectrum, Neon Circuit, and Aurora Glass) remain available. The Welcome
  app exposes all four choices alongside a floating translucent taskbar and
  restrained glass surfaces. GNOME selects the monitor scale automatically,
  with fractional Wayland and native XWayland scaling enabled in Displays for
  high-DPI and mixed-DPI setups.
- A native System Hub for updates, drivers and firmware, applications, gaming,
  backups, recovery, privacy, developer mode, and system diagnostics.
- Btrfs `@`, `@home`, `@snapshots`, and `@swap` subvolumes. Offline package
  transactions create a pre-update snapshot and automatically select rollback
  when the package transaction fails.
- Stable and Current channels. Current adds Debian backports while retaining
  the stable Debian base; switching channels never converts the installation
  to Debian testing.
- A protected recovery partition containing the live root filesystem, kernel,
  and initramfs, plus a generated GRUB recovery entry.
- A live welcome screen with Try, Install, Repair, hardware validation, and
  accessibility controls.
- Windows application hand-off to the sandboxed Bottles Flatpak, with a local
  compatibility database and a confirmation surface before an installer runs.
- AppImage integration without exposing package formats in the launcher.
- Windows-user migration for files, wallpapers, fonts, supported browser
  bookmarks, and Steam library metadata, with conflict-safe copying.
- Firewall, AppArmor, portals, firmware updates, full-disk encryption in the
  installer, optional TPM tooling, and diagnostics opt-in (off by default).
- Optional one-click profiles for gaming, Windows apps, local AI, development,
  virtualization, OSAII web apps, and Snap. Optional profiles are not installed
  until chosen. OSAII shortcuts are absent from the default application menu.

## Optional OSAII integration

MythOS is complete without OSAII services. Users who choose the
`osaii-web-apps` capability in System Hub receive browser shortcuts for OSAII
Platform, OSS Studio, and Masque. Disabling the capability removes those
shortcuts without changing browser data or Platform sessions.

The local MythOS user, files, administrator credentials, system diagnostics,
and settings are never used as an OSAII Platform identity. Platform sign-in is
an explicit browser action. Canonical service locations and bounded release
metadata are published at `https://osaii.wyvernhub.net/mythos/release.json`.

## Honest compatibility boundary

No operating system can guarantee every Windows game, anti-cheat driver,
printer, or vendor firmware on arbitrary hardware. MythOS reports what it
can verify, keeps untested software marked untested, and delegates Windows
runtime isolation to Bottles/Wine/Proton rather than inventing another Wine
prefix manager.

The macOS provider is deliberately gated as a research preview. Optional
macOS Apps builds pinned GPL-3.0 Darling sources with experimental
Metal-over-Vulkan, checks `.app` bundles before launch, and never promises
per-app success. Apple services, DRM, DriverKit, kernel extensions, App Store,
and Continuity remain unsupported. See [macOS compatibility](docs/macos-compatibility.md).

## Build

The build runs in a pinned Debian container and does not install packages on
the host:

```bash
make help        # show all targets
make quick       # fast validate (compile + unit tests + project invariants)
make validate    # full validation including shell lint
make package     # Debian package at .build/artifacts/mythos-core_*_all.deb
make iso         # hybrid ISO (needs Docker + 25 GiB tmp + network)
make smoke       # UEFI boot smoke test inside QEMU
make dev         # create local Python venv at .venv

# single-line host setup:
bash install.sh --dry-run   # preview
bash install.sh             # deps + quick validation
bash install.sh --iso       # + package build + ISO guidance
```

Artifacts are written to `.build/artifacts/`. The ISO build needs Docker,
roughly 25 GiB of temporary space, and network access to Debian mirrors. Build
parameters can be overridden without editing the project:

```bash
MYTHOS_ARCH=amd64 MYTHOS_MIRROR=https://deb.debian.org/debian make iso
```

See [architecture](docs/architecture.md), [security model](docs/security.md),
and the [release acceptance matrix](docs/release-acceptance.md) before shipping
an image to real hardware.

## Booting on an Intel MacBook

This amd64 image supports Intel Macs, not Apple Silicon Macs. On an Intel
MacBook, connect the Ventoy USB, hold Option at power-on, and select `EFI Boot`.
T2-equipped Intel Macs must permit external boot media in Startup Security
Utility first; this is a firmware policy and cannot be bypassed by an ISO.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `docker: command not found` or `Cannot connect to Docker daemon` | `sudo apt install docker.io && sudo systemctl enable --now docker && sudo usermod -aG docker $USER` then re-login. `make quick`/`make validate` work without Docker; only `make package`/`make iso`/`make smoke` need it. |
| `No space left on device` during `make iso` | Free ~25 GiB in `MythOS/.build/` (check `df -h .`). Run `make clean-all` and retry. `MYTHOS_ARCH=amd64 make iso` is amd64-only. |
| `shellcheck: command not found` or lint warnings | `sudo apt install shellcheck` (lint-shell is optional; compile + pytest still run). |
| `python3 -m pytest` fails with `FileNotFoundError: data/polkit/...` | Run pytest from the MythOS root: `cd MythOS && python3 -m pytest -q`. The policy path test is repo-relative. |
| `mythosctl: command not found` after editing sources | `pip install -e .` from `MythOS/` (or `make dev` then `source .venv/bin/activate`). |
| `snapper: command not found` or snapshot errors on dev host | Expected outside MythOS install. `mythosctl doctor` will report `atomic_updates: false` on non-Btrfs hosts. Use a MythOS VM/ISO for transactional update tests. |
| `permission denied` on privileged actions | Prefix with `sudo` or use the System Hub GUI (Polkit will prompt). `mythosctl doctor --verbose` shows which checks need root. |
| Debian 12 (bookworm) host building trixie ISO | Works for `make validate`/`make quick`; for `make iso` prefer Debian 13 to avoid mirror mismatches. The build container is trixie regardless. |
| Windows host | Use WSL2 Debian 13: `wsl --install -d Debian` then inside WSL run `curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash`. Native Windows ISO assembly is not supported. |

More help: `make help`, `mythosctl --help`, `mythosctl doctor --help`, and `python3 scripts/validate-project`.
