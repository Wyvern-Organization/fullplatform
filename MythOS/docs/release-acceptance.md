# MythOS v1 release acceptance

An ISO artifact is a candidate, not a consumer release, until every required
gate below has evidence for the exact SHA-256 being shipped. Use `Pass`,
`Fail`, or `Not run`; never turn an untested gate into a pass by inference.

## Automated build gates

| Gate | Command | Required result |
| --- | --- | --- |
| Source and catalog validation | `make validate` | Unit tests, Python compilation, shell lint, XML, desktop, catalog, and project invariants pass |
| Debian package | `make package` | `mythos-core_1.0.0_all.deb` builds and installs with dependencies |
| Hybrid image | `make iso` | ISO and matching SHA-256 are produced |
| Image contents | `scripts/verify-image` | BIOS, PC UEFI, and Intel Mac boot records plus required rootfs payload are present |
| Virtual boot | `make smoke` | Signed UEFI path reaches a non-blank graphical live session and captures evidence |

## Installer and recovery gates

| Scenario | Required evidence |
| --- | --- |
| UEFI clean install | GPT, EFI, Btrfs subvolumes, swap choice, user creation, boot |
| Secure Boot install | Firmware remains enforcing; shim, GRUB, and kernel boot without enrolling an untrusted key |
| Encrypted install | Wrong passphrase fails; correct passphrase boots; recovery remains bootable |
| BIOS clean install | GRUB installs to the selected disk and boots |
| Intel MacBook live boot | An Intel Mac detects the USB as `EFI Boot`, reaches the live menu, and starts the desktop (with external boot permitted on T2 models) |
| Dual-boot/alongside | Existing Windows partitions and Windows boot remain intact |
| Recovery partition | GRUB entry boots the copied image without the USB attached |
| Rollback | Injected offline APT failure restores the pre-update system and preserves `/home`, logs, and update state |
| Reset settings | GNOME settings backup is created and personal files/apps stay unchanged |
| Repair bootloader | Explicit known test target is repaired; an unrelated or non-MythOS target is rejected |

## Daily-driver hardware gates

Test at least one current and one older device in each applicable class. Record
model, firmware, kernel, graphics stack, session type, result, and logs.

- Intel integrated graphics, AMD integrated/discrete graphics, and NVIDIA
  proprietary driver installation.
- Wi-Fi and Bluetooth from Intel, Realtek, MediaTek, Broadcom, and Qualcomm
  where hardware is available.
- Internal audio, HDMI/DisplayPort audio, microphone, webcam, USB headset,
  printer/scanner, fingerprint reader, and Thunderbolt dock.
- Multiple displays, HiDPI, fractional scaling, VRR, HDR-capable display,
  screen recording, and XWayland applications.
- Suspend/resume on AC and battery, lid close, airplane mode, brightness and
  audio keys, controller hotplug, printing, and low-disk behavior.

## Performance gates

Measure on the declared reference SSD hardware after three clean boots. Record
raw logs and do not substitute VM results.

| Goal | Measurement |
| --- | --- |
| Cold boot under 20 seconds | Firmware handoff to responsive desktop |
| Search under 100 ms | Input event to first local launcher result |
| Idle memory target under 1 GiB | Five-minute settled session using the documented accounting method |
| Responsive launch | Cold and warm launch latency for Files, Settings, Software, browser, and office suite |
| Suspend/resume parity | 30-cycle pass rate, wake latency, network/audio/display restoration |

## Compatibility and accessibility gates

- Install, launch, update, and remove native, Flatpak, AppImage, Windows/Bottles,
  and optional Snap applications; ensure every installed app appears once in
  the launcher.
- Test Steam, controller hotplug, GameMode, Proton selection, Vulkan, one
  working title, one known-problem title, and an anti-cheat title whose status
  is accurately reported.
- Run the installer and recovery flow using keyboard only and Orca from the
  first live screen. Test high contrast, magnifier, on-screen keyboard, Sticky
  Keys, Mouse Keys, and a Braille display when available.
- Verify telemetry remains off, SSH is closed, firewall is active, permission
  prompts work, and no cloud account is required.

## Shipment decision

The image must not be called production-ready while a required automated,
installer, rollback, Secure Boot, accessibility, or representative-hardware
gate is `Fail` or `Not run`. Experimental macOS support is excluded from the v1
ship gate and must remain disabled with its warning.
