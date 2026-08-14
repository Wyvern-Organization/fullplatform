# macOS compatibility

MythOS provides an optional macOS application runtime based on
[Darling](https://github.com/darlinghq/darling). It is disabled by default.
MythOS never ships Apple operating-system files, Apple services, or Mac App
Store content.

## Pinned upstream sources

| Component | Source | Revision | License |
| --- | --- | --- | --- |
| Darling | `https://github.com/darlinghq/darling.git` | `e471d067655f887a22b6ae6cedbc224f40c037cf` (`v0.1.20260222`) | GPL-3.0-only |
| Darling Metal | `https://github.com/darlinghq/darling-metal.git` | `f815654533fe0515f709bf4def29ae523b09414c` | GPL-3.0-only |

`data/libexec/build-darling-runtime` clones Darling recursively, checks out
that exact release, verifies its Metal submodule revision, and builds it with
`-DENABLE_METAL=ON`. This enables Darling's experimental Metal-over-Vulkan
path. Upstream documents a minimum 64-bit x86 Linux host, 4 GiB RAM, 5 GiB
source checkout, and up to 16 GiB build space; MythOS reserves 25 GiB.

The GPL text used by both projects is included at
`THIRD_PARTY_LICENSES/Darling-GPL-3.0.txt`. Darling source is not copied into
this repository and MythOS makes no local modification to Darling or
Darling Metal. A runtime built by the helper remains GPL-governed upstream
software; its complete corresponding source is the pinned recursive upstream
checkout created by that helper.

## MythOS changes

- Adds an optional `macos-apps` profile that installs Darling's Debian 13
  build prerequisites, then builds the pinned runtime.
- Records exact runtime source revisions and whether Metal was enabled in
  `/opt/mythos/darling/share/mythos/runtime.json`.
- Inspects `.app` bundles before launch, resolves `CFBundleExecutable`, checks
  Mach-O format, detects common Metal linkage markers, and launches the real
  executable through Darling rather than passing an opaque bundle path.
- Blocks a Metal-marked bundle when runtime metadata cannot verify an enabled
  Metal build. It labels all other launches as candidates, never guarantees
  compatibility.

## Compatibility boundary

This improves practical support for command-line apps and simple GUI apps.
Metal support remains experimental and per-app: current upstream still has
unimplemented API paths, and complex GUI software may fail. Apple ID, iCloud,
App Store, DRM, DriverKit, kernel extensions, Continuity, FaceTime, and
Messages remain unsupported. Inspect before launch with:

```bash
mythosctl macos runtime
mythosctl macos inspect /path/to/Application.app
```
