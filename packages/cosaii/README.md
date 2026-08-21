# Cosaii — cozy local agentic CLI

Cosaii (pronounced *cozy*) is the OSAII Platform's local agent runtime. A persistent Rust `cosaii-app-server` owns encrypted sessions, tools, permissions, and the Platform bridge; the `@opentui/core` TUI only renders state.

## Single-line install

```sh
curl -fsSL https://osaii.wyvernhub.net/install/cosaii.sh | sh
# PowerShell
powershell -c "irm https://osaii.wyvernhub.net/install/cosaii.ps1 | iex"

# Pin a version
COSAII_VERSION=0.1.0 sh install/cosaii.sh
# Custom dir
COSAII_INSTALL_DIR=$HOME/.local/bin sh install/cosaii.sh

# Verify (required after install)
cosaii --version && cosaii doctor
```

Installer handles `COSAII_VERSION` pinning, downloads the paired `cosaii` + `cosaii-app-server` archive, verifies `sha256` checksums, and installs with `0755` permissions. Uninstall:

```sh
rm "$(which cosaii)" "$(dirname $(which cosaii))/cosaii-app-server"
cosaii daemon uninstall   # removes user service (systemd / LaunchAgents / schtasks)
```

## Quick start

```sh
cosaii           # open TUI
cosaii login     # device flow (10-min code) — no localhost callback
cosaii doctor    # checks daemon, platform, keychain, data dir
cosaii health    # same as RPC server/health
cosaii --version # reads from Cargo.toml via --version

cosaii run "fix the failing tests" --format text          # streaming text
cosaii run "explain this codebase" --format json --verbose
cosaii run "summarize" --model fast --reasoning medium --format jsonl

cosaii session list
cosaii session resume <id>
cosaii session export <id> --format markdown --output ./out.md
cosaii config list
cosaii config read model
cosaii config write model '"fast"'
cosaii logs --lines 100 --follow
cosaii daemon status
cosaii daemon logs --lines 80
cosaii daemon restart
```

## TUI

- **Welcome**: `What are we working on?` with local-only note and connection indicator (`● connected` / `○ reconnecting`)
- **Composer**: native terminal `textarea` — `Enter` send, `Alt+Enter` newline, `Ctrl+N` new chat, `Esc` quit, `?` / `F1` help
- **Model picker**: `F2` cycles `auto` → `fast` → `smart` → `Mini (Preview)` when catalog includes `microsoft/bitnet-b1.58-2B-4T`
- **Reasoning** `F3`, **Permissions** `F4` (`deny_all`, `allow_low_risk`, `always_ask`, `full_access`)
- **Approval**: `Y` / `N` for `item/approval/request`
- **Status bar** shows version, `$COSAII_HOME`, daemon connectivity; **toasts** for errors; `Agent activity` panel with `◌`/`✓`/`×`
- **Sticky scroll** keeps `↓ New activity · Ctrl+L` visible; `Loading conversation` state

## CLI reference

| command | description |
|---|---|
| `cosaii` | Open TUI (default) |
| `cosaii --help`, `--version` | Help / version from `Cargo.toml` |
| `cosaii login [--no-browser]` | Device flow via `/platform/api/cli/*` |
| `cosaii run "task" [--format …]` | Streaming task (`text`, `json`, `jsonl`, `markdown`) with `--model`, `--reasoning`, `--verbose` preview |
| `cosaii session` | `list`, `resume`, `fork`, `export`, `import`, `delete` |
| `cosaii config` | `list`, `read KEY`, `write KEY JSON`, `path` (encrypted store) |
| `cosaii doctor [--json]` | Daemon `server/health` + platform `model/list` + keychain + data dir `0700` |
| `cosaii logs` | `daemon logs --lines N --follow` |
| `cosaii health` | RPC `server/health` (`/health`) |
| `cosaii daemon` | `status`, `start`, `stop`, `restart`, `logs`, `health`, `install`, `uninstall` |
| `cosaii update [--check]` | Verified `mkdtemp` + `rename(stagedServer`/`rename(stagedClient` with `sha256` check; `Checksum did not match` on failure |
| `cosaii app-server` | Hint to run `cosaii-app-server --help` |

`cosaii-app-server` flags: `--listen PATH`, `--data-dir DIR`, `--platform-url URL`, `-v/--verbose` (timestamps), `--help`, `--version`. Data dir handling creates parents and sets `0700`; config validation rejects empty/bad `--platform-url`.

## Health

- RPC: `server/health` (also `health` / `/health`) returns `{status:"ok",version,protocol,pid,platform,timestamp}`
- CLI: `cosaii health` and `cosaii doctor`
- Logs: `cosaii logs` or `$COSAII_HOME/app-server.log` (timestamped, verbose flag adds debug)

## Uninstall

```sh
cosaii daemon uninstall
rm ~/.local/bin/cosaii ~/.local/bin/cosaii-app-server  # or $COSAII_INSTALL_DIR
# installer --help shows details
curl -fsSL https://osaii.wyvernhub.net/install/cosaii.sh | sh -- --help
```

## Development

```sh
npm run cosaii:check   # cargo check + tsc
npm run build -w @osaii/cosaii-client  # bun build
cargo build --release --manifest-path cosaii/Cargo.toml
```

See `cosaii/crates/app-server/src/main.rs` for protocol (`PROTOCOL_MIN`/`PROTOCOL_MAX`, `initialize must be the first request`, `XChaCha20Poly1305`, `journal_mode=WAL`), streaming (`item/agentMessage/delta`, `item/toolCall/outputDelta`), permissions, tools (`command/exec`, `fs/write`), and env (`COSAII_HOME`, `COSAII_DATA_DIR`).
