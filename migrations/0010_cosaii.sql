PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cosaii_device_grants (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  requested_scopes TEXT NOT NULL DEFAULT '[]',
  client_name TEXT NOT NULL,
  account_id INTEGER REFERENCES platform_accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','consumed','expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cosaii_device_grants_code
  ON cosaii_device_grants(user_code, status, expires_at);

CREATE TABLE IF NOT EXISTS cosaii_devices (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cosaii_devices_account
  ON cosaii_devices(account_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS cosaii_access_tokens (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES cosaii_devices(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cosaii_access_tokens_hash
  ON cosaii_access_tokens(token_hash, expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS cosaii_refresh_tokens (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES cosaii_devices(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rotated_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cosaii_refresh_tokens_hash
  ON cosaii_refresh_tokens(token_hash, expires_at, revoked_at);

-- A successful first inference request establishes a short-lived safety
-- boundary for one local agent turn. Tool continuations must present the same
-- turn id, account, and device; this prevents clients from using a bare flag to
-- bypass the input gate while avoiding a classifier call for every tool step.
CREATE TABLE IF NOT EXISTS cosaii_safe_turns (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES cosaii_devices(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cosaii_safe_turns_expiry
  ON cosaii_safe_turns(expires_at);

CREATE TABLE IF NOT EXISTS cosaii_environments (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES cosaii_devices(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cosaii_environments_account
  ON cosaii_environments(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cosaii_pairings (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES cosaii_environments(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  manual_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  client_public_key TEXT,
  client_id TEXT,
  claimed_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cosaii_pairings_environment
  ON cosaii_pairings(environment_id, expires_at);

CREATE TABLE IF NOT EXISTS cosaii_remote_clients (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES cosaii_environments(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cosaii_remote_clients_environment
  ON cosaii_remote_clients(environment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cosaii_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  device_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cosaii_audit_account
  ON cosaii_audit(account_id, created_at DESC);
