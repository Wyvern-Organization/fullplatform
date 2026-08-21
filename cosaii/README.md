# cosaii-app-server

Persistent local runtime for Cosaii (cozy) clients — encrypted SQLite sessions, streaming inference, tools, permissions, and Platform bridge.

- **Transport**: WebSocket-framed JSON-RPC over a `0700` Unix socket (`$COSAII_HOME/app-server.sock`) or Windows named pipe. Also supports `proxy` mode (JSON-RPC over stdio).
- **Storage**: `rusqlite` bundled, `PRAGMA journal_mode=WAL` + `foreign_keys=ON`, encrypted with `XChaCha20Poly1305` (nonce + ciphertext per record). Key via OS `keyring` with `COSAII_STORE_PASSPHRASE` fallback + `store.salt` (`0600`).
- **Protocol**: `PROTOCOL_MIN`/`PROTOCOL_MAX = 1`, `initialize` must be first request, `server/health` / `server/status`, `thread/*`, `turn/*`, streaming `item/agentMessage/delta` / `item/toolCall/outputDelta`, `permissionProfile/set`, `command/exec`, `fs/write`, etc. See `cosaii/crates/protocol/src/lib.rs`.
- **Config**: `--platform-url` validated, `--data-dir` creates parents with `0700`, `--listen` custom, `-v/--verbose` timestamped logs. `COSAII_HOME` / `COSAII_DATA_DIR` env overrides `directories` crate.

## Install & verify (single-line)

```sh
curl -fsSL https://osaii.wyvernhub.net/install/cosaii.sh | sh
cosaii --version && cosaii doctor
```

## Run

```sh
cosaii-app-server --help        # long help with examples
cosaii-app-server --version     # reads from Cargo.toml (workspace.package.version)
cosaii-app-server --verbose     # timestamped logs
cosaii-app-server --data-dir ~/.local/share/cosaii --platform-url https://osaii.wyvernhub.net
cosaii-app-server proxy         # stdio bridge

# health (RPC also available as server/health)
cosaii health
cosaii doctor
```

## Logging

With `-v`/`--verbose` logs include `RFC3339` timestamps (`log_ts`). Without, startup still logs timestamped line to stderr and to `$COSAII_HOME/app-server.log` (`0600`). Idle watcher (1800s) logs when exiting.

## Data dir robustness

`ensure_dir_robust` creates parents, checks not a file, sets `0700` via `restrict_dir`. Validates `platform_url` starts with `https://`/`http://`. `recover_interrupted_turns` marks interrupted turns on start.

## Metadata

Workspace `version = 0.1.0`, `edition = 2024`, `license = GPL-3.0-only`, `description`, `keywords`, `categories` in `cosaii/Cargo.toml`. Verify with `cargo check --workspace` and `npm run cosaii:check`.
