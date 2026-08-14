# MythOS v1 architecture

## Product boundary

MythOS v1 is an amd64 Debian 13 live and installed system. Debian owns the
kernel, boot chain, hardware enablement, package archive, and GNOME session.
MythOS owns the default experience and the control plane that connects the
installer, updates, restore points, recovery, drivers, optional features,
migration, and application launchers.

The image is deliberately a distribution integration project, not a fork of
GNOME, Wine, Flatpak, or Debian. This keeps the security and maintenance burden
inside components with established upstream update paths.

## Runtime layers

1. Debian 13, systemd, signed shim and GRUB, Linux, PipeWire, NetworkManager,
   CUPS, fwupd, UFW, and AppArmor provide the operating-system layer.
2. GNOME 48 runs on Wayland by default. XWayland and the GNOME X11 session are
   included for compatibility.
3. Dash to Panel and ArcMenu provide the familiar bottom taskbar and menu. The
   small MythOS Shell extension adds the adjacent Search control and a
   screen-recording Quick Settings action.
4. Flatpak and xdg-desktop-portal provide the default application boundary.
   Debian packages remain available for system components and power users.
5. `mythos-core` provides the native System Hub, welcome flow, migration
   assistant, portable-application opener, and the JSON `mythosctl`
   control interface.

## Installation layout

Automated installation uses GPT, a firmware-dependent EFI partition, a 6 GiB
unencrypted `COS_RECOVERY` ext4 partition, and an optionally encrypted Btrfs
`COS_ROOT` partition. The root filesystem contains these subvolumes:

| Subvolume | Mount | Purpose |
| --- | --- | --- |
| `@` | `/` | Operating system |
| `@home` | `/home` | User data, excluded from system rollback |
| `@snapshots` | `/.snapshots` | Snapper restore points |
| `@cache` | `/var/cache` | Package and application caches |
| `@log` | `/var/log` | Logs that survive system rollback |
| `@state` | `/var/lib/mythos` | Transaction and boot-health state |
| `@swap` | swap file mount | Btrfs-safe swap and hibernation choice |

During installation, `mythosctl install-finalize` copies the live
SquashFS, kernel, and initramfs to the recovery partition. It then protects
the partition as read-only and on-demand in the installed `/etc/fstab`.
The GRUB generator addresses it by filesystem UUID, so disk enumeration does
not determine recovery availability.

## Updates and restore points

Stable follows Debian 13 stable and security updates. Current enables only the
Debian 13 backports suite; it never converts the base installation to testing.

System Hub refreshes metadata, simulates the transaction, creates a Snapper
pre-snapshot, downloads every package, and creates `/system-update`. systemd
then applies the already-downloaded transaction before the graphical session.
A successful transaction receives a paired post-snapshot and is blessed only
after `graphical.target` starts. A failed package transaction writes a rollback
request into persistent `@state`; an initramfs pre-mount helper then atomically
renames the failed `@` root and recreates it from the selected read-only
Snapper snapshot before that root can be mounted. The fixed `@` name means
GRUB and `/etc/fstab` never point at a version-specific snapshot path.

File backup is intentionally separate from system rollback. Deja Dup handles
scheduled user backups and restore; Pika Backup is an optional Borg profile for
advanced repositories and NAS workflows.

## Application model

- Flatpak is the default third-party format and Flathub is configured at image
  construction time.
- Debian packages are used for the base system and are exposed through an
  optional advanced package manager.
- AppImages are copied under the user's data directory, made executable only
  after an explicit trust warning, and represented by launcher entries.
- Windows files are shown a compatibility report and handed to the Bottles
  Flatpak. Bottles owns Wine runners, isolated bottles, DXVK, VKD3D, DLL
  overrides, and registry state.
- Snap is absent by default and installed only when the optional profile is
  explicitly selected.
- OSAII Platform, Studio, and Masque shortcuts are stored as inert templates.
  They are copied into the application menu only when the user enables the
  `osaii-web-apps` profile and are removed when that profile is disabled.
  The integration opens HTTPS web apps and does not bridge local identity.
- The macOS provider is an optional, pinned Darling runtime. Its setup builds
  GPL-3.0 upstream source with experimental Metal-over-Vulkan, records the
  exact revisions, inspects `.app` bundles before launch, and remains a
  per-app compatibility path rather than a claimed macOS replacement.
- GenericWifi and GenericNetworking are recovery services, not universal
  kernel modules: they use Linux's cfg80211/mac80211 and NetworkManager stack,
  while vendor kernel drivers and firmware remain Debian/upstream owned.
- Privileged GUI actions use the `org.mythos.Privileged` system D-Bus service.
  The service validates a typed operation allowlist, checks a distinct Polkit
  action for that operation against the calling bus name, then invokes only
  the corresponding fixed MythOS control command. `mythosctl` is not a Polkit
  executable target.

## Build products

`make package` creates an installable Debian package. `make iso` creates a
hybrid BIOS/UEFI live image and SHA-256 file. `make smoke` validates image
contents and boots the signed UEFI path in QEMU long enough to capture the
live desktop for inspection.
