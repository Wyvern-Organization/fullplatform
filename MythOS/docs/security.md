# MythOS v1 security model

## Single-line install trust

MythOS builds are deterministic and served via HTTPS. Prefer the pinned
installer served from the Platform origin:

```bash
curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash -s -- --dry-run  # preview
curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash
```

The local copy is `MythOS/install.sh` (see `README.md`). Both install only from
`deb.debian.org` and the `openplatform` repository; they do not fetch opaque
binaries. Verify a released ISO or package bundle with its companion
`SHA256SUMS`/`*.sha256` before executing any installer:

```bash
sha256sum --check --strict mythos-*-amd64.iso.sha256
sha256sum --check --strict SHA256SUMS  # for in-place .tar.gz bundles
```

Health check after install: `mythosctl doctor` or `mythos-doctor`.

## Defaults

- Debian's signed shim, GRUB, and kernel packages provide the Secure Boot path.
- Calamares offers full-disk encryption and keeps the recovery partition
  unencrypted so it can boot independently.
- UFW denies unsolicited inbound traffic and allows outbound traffic.
- AppArmor is enabled at boot.
- SSH and Snap are disabled and absent unless a user explicitly enables them.
- Diagnostics are disabled. v1 contains no background telemetry uploader.
- Camera, microphone, screencast, and location access for sandboxed apps flow
  through the desktop portals and GNOME permission surfaces.
- System Hub mutations use a root system D-Bus service with an operation
  allowlist and a distinct Polkit action for each privileged operation. The
  service authenticates the calling bus name and validates feature identifiers,
  snapshot numbers, preferences, and command arguments before dispatch.

## Update trust and rollback

APT sources use Debian's archive keyring. Stable and Current both retain the
Debian stable base. Update state, errors, and the bounded transaction history
are mode `0600` under `/var/lib/mythos`.

Updates are downloaded before restart and installed by systemd's offline-update
mechanism. The updater refuses its transactional path unless root is Btrfs and
the `@`, `@snapshots`, and persistent `@state` layout plus Snapper root
configuration are operational. It creates a restore point before changing
packages. On failure, an initramfs pre-mount helper validates the numeric
snapshot and restricted transaction identifier, preserves the failed root, and
recreates `@` from the requested snapshot before mounting the operating system.

## Application and migration boundaries

Flatpak applications use system remotes and portals. A Windows executable is
never launched directly by the compatibility UI: it is delegated to Bottles,
which owns the per-application Wine environment. Compatibility entries without
evidence stay `untested`; a filename match is not promoted to a working claim.

The Windows migration assistant never deletes the source, never follows source
symlinks, and never overwrites a destination. Conflicts receive a visible
`(from Windows)` suffix. Windows-protected browser passwords are explicitly
excluded because copying encrypted databases would create a misleading and
unsafe promise.

AppImage import requires an ELF/AppImage header, copies the file to a
user-controlled directory, and escapes desktop-entry command characters. It
still executes publisher-supplied native code and therefore presents a trust
warning; AppImage is not described as sandboxed.

OSAII Platform integration is disabled by default. Enabling it copies only
three fixed HTTPS browser shortcuts into the application menu. It does not
read or transmit the local user name, files, administrator credentials,
diagnostics, or MythOS configuration. Disabling it removes only those generated
shortcuts; browser cookies and Platform account data remain under browser and
service control.

## Recovery safety

Bootloader repair accepts only explicit `/dev/...` targets, verifies the root
filesystem type, mounts it in a private temporary path, and checks the
MythOS marker before invoking GRUB. Desktop reset backs up GNOME settings
before resetting only the desktop-related key prefixes. Keep-files reset and
destructive reinstall remain installer/recovery operations and must show their
target disk before execution.

## Release threats still requiring operational controls

- Public images need a real HTTPS project origin, an incident contact, a
  signed release manifest, and a decided source/binary license.
- Every release needs fresh boot validation on Secure Boot hardware, an
  encrypted install, suspend/resume, update failure injection, recovery boot,
  and representative Intel/AMD/NVIDIA and Wi-Fi hardware.
- Flathub application IDs and Debian package availability must be checked at
  release time. Third-party runtime behavior can change independently.
- A compatibility report is advisory; vendor anti-cheat and DRM policy can
  change without an operating-system update.
