import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [worker, api, relay, migration, wrangler, protocol, server, client, daemon, pkg, agents, installer] = await Promise.all([
  read("src/index.ts"), read("API/cosaii.ts"), read("src/cosaii-relay.ts"), read("migrations/0010_cosaii.sql"),
  read("wrangler.jsonc"), read("cosaii/crates/protocol/src/lib.rs"), read("cosaii/crates/app-server/src/main.rs"),
  read("packages/cosaii/src/index.tsx"), read("packages/cosaii/src/daemon.ts"), read("packages/cosaii/package.json"), read("AGENTS.md"),
  read("API/cosaii-install.ts"),
]);

test("Worker exposes scoped CLI login and inference without restoring /cli", () => {
  for (const value of ["/platform/api/cli/", "/platform/cli/authorize", "/cosaii/api/v1/", "cosaii_at_", "cosaii_rt_", "datetime('now','+90 days')"])
    assert.match(worker + api, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(worker, /url\.pathname === "\/cli"/);
  assert.match(api, /surface='cosaii'/);
  assert.match(api, /cosaii_safe_turns/);
  assert.match(api, /safetyAlreadyChecked/);
  assert.match(server, /"agent_turn_id":turn_id/);
  assert.match(server, /"continuation_index":step/);
  assert.match(api, /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[1-8\]\[0-9a-f\]\{3\}-\[89ab\]\[0-9a-f\]\{3\}-\[0-9a-f\]\{12\}/i);
});

test("Platform installer serves checksum-verified Cosaii release assets from R2", () => {
  for (const value of ["/install/cosaii.sh", "cosaii/releases/latest/", "cosaii_release_unavailable", "cosaii-linux-x64.tar.gz", "sha256sum -c"]) {
    assert.match(worker + installer, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(installer, /github\.com\/.*\/releases/);
});

test("Cosaii relay is opaque and uses an immutable SQLite Durable Object migration", () => {
  assert.match(relay, /acceptWebSocket/);
  assert.match(relay, /serializeAttachment/);
  assert.match(relay, /stores no\s*\n?\s*\*?\s*frame or transcript content/i);
  assert.match(wrangler, /"tag": "cosaii-v1"/);
  assert.match(wrangler, /"new_sqlite_classes": \["CosaiiRelay"\]/);
  assert.match(migration, /cosaii_pairings/);
  assert.match(migration, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS cosaii_safe_turns/);
  assert.doesNotMatch(migration, /transcript|message_content|raw_token/);
});

test("app-server owns protocol, persistence, streaming, permissions, and tools", () => {
  for (const value of ["PROTOCOL_MIN", "initialize must be the first request", "XChaCha20Poly1305", "journal_mode=WAL", "recover_interrupted_turns", "item/agentMessage/delta", "item/toolCall/outputDelta", "permissionProfile/set", "command/exec", "fs/write", "COSAII_DATA_DIR", "COSAII_HOME"])
    assert.match(protocol + server, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("thin OpenTUI client validates the daemon and exposes core commands", () => {
  for (const value of ["server/status", "processIsAlive", "OpenTUI", "thread/start", "turn/start", "New activity", "cosaii run", "cosaii login", "daemon status", "permission_profile"])
    assert.match(client + daemon + pkg, new RegExp(value, "i"));
  assert.match(agents, /app-server/i);
});

test("Cosaii update is implemented as a verified paired-binary replacement", () => {
  for (const value of ["command === \"update\"", "releaseArtifact", "sha256", "Checksum did not match", "cosaii-app-server", "mkdtemp", "rename(stagedServer", "rename(stagedClient"])
    assert.match(client, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.doesNotMatch(client, /curl\s+.*\|\s*(?:sh|bash)/i);
});

test("Cosaii refreshes the remote model catalog on launch", () => {
  for (const value of ["refreshModelCatalog", "3_000", "best-effort"])
    assert.match(client, new RegExp(value.replace(/[.*+?^${}()|[\[\]\\]/g, "\\$&"), "i"));
  assert.match(client, /rpc\.call\("model\/list"\)/);
  assert.match(client, /microsoft\/bitnet-b1\.58-2B-4T/);
  assert.match(client, /Mini \(Preview\)/);
  assert.match(client, /modelChoices/);
});

test("Cosaii TUI keeps the conversation visible and the composer terminal-native", () => {
  for (const value of ["visibleItems", "displayText", "Agent activity", "stickyScroll", "What are we working on?", "Enter send", "Alt+Enter newline", "Loading conversation"])
    assert.match(client, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.doesNotMatch(client, /Ctrl\+Enter send/);
  assert.match(worker, /latest[\s\S]{0,800}cache-control"\s*:\s*"no-store"/i);
});

test("Cosaii keeps one conversation store across sandboxed launchers", () => {
  for (const value of ["userInfo().homedir", "cosaiiDataDir", "COSAII_HOME:cosaiiHome", "COSAII_DATA_DIR:cosaiiDataDir"])
    assert.match(daemon, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(daemon, /XDG_CONFIG_HOME/);
});
