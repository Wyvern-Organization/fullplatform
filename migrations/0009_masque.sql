ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS masque_profiles (
  account_id INTEGER PRIMARY KEY REFERENCES platform_accounts(id) ON DELETE CASCADE,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  avatar_key TEXT,
  avatar_alt TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  preferences TEXT NOT NULL DEFAULT '{}',
  creator_public INTEGER NOT NULL DEFAULT 0 CHECK (creator_public IN (0,1)),
  date_of_birth TEXT NOT NULL,
  adult_attested_at TEXT NOT NULL,
  contribution_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (contribution_opt_in IN (0,1)),
  contribution_changed_at TEXT,
  username_changed_at TEXT,
  tier TEXT NOT NULL DEFAULT 'standard',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS masque_characters (
  id TEXT PRIMARY KEY,
  owner_account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  traits TEXT NOT NULL DEFAULT '[]',
  speaking_style TEXT NOT NULL DEFAULT '',
  scenario TEXT NOT NULL DEFAULT '',
  goals TEXT NOT NULL DEFAULT '[]',
  behavior TEXT NOT NULL DEFAULT '{}',
  boundaries TEXT NOT NULL DEFAULT '{"hard":[],"soft":[]}',
  content_labels TEXT NOT NULL DEFAULT '[]',
  greetings TEXT NOT NULL DEFAULT '[]',
  examples TEXT NOT NULL DEFAULT '[]',
  languages TEXT NOT NULL DEFAULT '["en"]',
  tags TEXT NOT NULL DEFAULT '[]',
  response_defaults TEXT NOT NULL DEFAULT '{"length":"auto","initiative":"auto"}',
  voice TEXT NOT NULL DEFAULT '{}',
  media TEXT NOT NULL DEFAULT '{}',
  avatar_key TEXT,
  avatar_alt TEXT NOT NULL DEFAULT '',
  persona_kind TEXT NOT NULL DEFAULT 'fictional' CHECK (persona_kind IN ('original','fictional','public_figure')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','unlisted','public')),
  remix_allowed INTEGER NOT NULL DEFAULT 1 CHECK (remix_allowed IN (0,1)),
  source_character_id TEXT REFERENCES masque_characters(id),
  source_url TEXT,
  provenance TEXT NOT NULL DEFAULT '{}',
  current_revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','restricted','trashed')),
  published_at TEXT,
  deleted_at TEXT,
  purge_after TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_masque_characters_owner ON masque_characters(owner_account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_masque_characters_discovery ON masque_characters(status, visibility, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_masque_characters_source ON masque_characters(source_character_id);

CREATE TABLE IF NOT EXISTS masque_character_versions (
  character_id TEXT NOT NULL REFERENCES masque_characters(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  name TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  changed_by INTEGER REFERENCES platform_accounts(id) ON DELETE SET NULL,
  change_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(character_id, revision)
);

CREATE TABLE IF NOT EXISTS masque_collaborators (
  character_id TEXT NOT NULL REFERENCES masque_characters(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor','viewer')),
  invited_by INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(character_id, account_id)
);

CREATE TABLE IF NOT EXISTS masque_lore (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES masque_characters(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  activation TEXT NOT NULL DEFAULT 'keyword' CHECK (activation IN ('always','keyword')),
  keywords TEXT NOT NULL DEFAULT '[]',
  token_budget INTEGER NOT NULL DEFAULT 400,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_masque_lore_character ON masque_lore(character_id, position);

CREATE TABLE IF NOT EXISTS masque_personas (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  avatar_key TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_masque_personas_owner ON masque_personas(account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS masque_sessions (
  id TEXT PRIMARY KEY,
  owner_account_id INTEGER REFERENCES platform_accounts(id) ON DELETE SET NULL,
  guest_hash TEXT,
  title TEXT NOT NULL DEFAULT 'New conversation',
  kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','room')),
  character_ids TEXT NOT NULL DEFAULT '[]',
  frozen_characters TEXT NOT NULL DEFAULT '[]',
  persona_id TEXT REFERENCES masque_personas(id) ON DELETE SET NULL,
  branch_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  model_family TEXT NOT NULL DEFAULT 'auto' CHECK (model_family IN ('auto','fast','smart')),
  cross_chat_memory INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_masque_sessions_owner ON masque_sessions(owner_account_id, archived, pinned DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS masque_session_members (
  session_id TEXT NOT NULL REFERENCES masque_sessions(id) ON DELETE CASCADE,
  account_id INTEGER REFERENCES platform_accounts(id) ON DELETE CASCADE,
  guest_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('host','participant','viewer')),
  contribution_opt_in INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(session_id, account_id, guest_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_masque_members_account ON masque_session_members(session_id, account_id) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_masque_members_guest ON masque_session_members(session_id, guest_hash) WHERE guest_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS masque_invites (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES masque_sessions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('participant','viewer')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS masque_memories (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES masque_characters(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES masque_sessions(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','accepted','pinned','deleted')),
  vector_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_masque_memories_context ON masque_memories(account_id, character_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS masque_imports (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('characterai','janitorai','card_v2','json')),
  source_url TEXT,
  source_id TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  extracted TEXT NOT NULL DEFAULT '{}',
  warnings TEXT NOT NULL DEFAULT '[]',
  scratch_key TEXT,
  scratch_expires_at TEXT,
  character_id TEXT REFERENCES masque_characters(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_masque_imports_owner ON masque_imports(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS masque_follows (
  follower_account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  creator_account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(follower_account_id, creator_account_id)
);

CREATE TABLE IF NOT EXISTS masque_likes (
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES masque_characters(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(account_id, character_id)
);

CREATE TABLE IF NOT EXISTS masque_ratings (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES masque_characters(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES masque_sessions(id) ON DELETE SET NULL,
  message_id TEXT,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  reasons TEXT NOT NULL DEFAULT '[]',
  contribution_eligible INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, message_id)
);

CREATE TABLE IF NOT EXISTS masque_blocks (
  blocker_account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  blocked_account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all','creator')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(blocker_account_id, blocked_account_id, scope)
);

CREATE TABLE IF NOT EXISTS masque_reports (
  id TEXT PRIMARY KEY,
  reporter_account_id INTEGER REFERENCES platform_accounts(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('character','message','user','voice','import')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  selected_context TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','appealed','dismissed')),
  resolution TEXT NOT NULL DEFAULT '',
  assigned_account_id INTEGER REFERENCES platform_accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_masque_reports_queue ON masque_reports(status, created_at);

CREATE TABLE IF NOT EXISTS masque_appeals (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES masque_reports(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS masque_roles (
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','moderator','operator')),
  granted_by INTEGER REFERENCES platform_accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(account_id, role)
);

CREATE TABLE IF NOT EXISTS masque_feature_flags (
  key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  config TEXT NOT NULL DEFAULT '{}',
  updated_by INTEGER REFERENCES platform_accounts(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO masque_feature_flags(key, enabled, config) VALUES
  ('global', 0, '{}'),
  ('profiles', 1, '{}'),
  ('discovery', 1, '{}'),
  ('creator', 1, '{}'),
  ('chat', 1, '{"guest_daily":20,"smart_daily":100}'),
  ('memory', 1, '{}'),
  ('imports', 1, '{}'),
  ('exports', 1, '{}'),
  ('voice', 0, '{}'),
  ('images', 0, '{}'),
  ('shared_rooms', 0, '{}'),
  ('schedules', 0, '{}'),
  ('embeds', 0, '{}'),
  ('public_api', 0, '{}'),
  ('notifications', 0, '{}'),
  ('publishing', 1, '{}');

CREATE TABLE IF NOT EXISTS masque_embed_tokens (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  character_ids TEXT NOT NULL,
  origins TEXT NOT NULL,
  limits_json TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS masque_webhooks (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  secret_cipher TEXT NOT NULL,
  events TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_status INTEGER,
  last_delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS masque_notifications (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  href TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_masque_notifications_owner ON masque_notifications(account_id, read, created_at DESC);

CREATE TABLE IF NOT EXISTS masque_push_subscriptions (
  endpoint_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expiration_time INTEGER,
  last_status INTEGER,
  last_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_masque_push_account ON masque_push_subscriptions(account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS masque_schedules (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES masque_characters(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES masque_sessions(id) ON DELETE CASCADE,
  schedule TEXT NOT NULL,
  quiet_hours TEXT NOT NULL DEFAULT '{}',
  next_run TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_masque_schedules_due ON masque_schedules(enabled, next_run);

CREATE TABLE IF NOT EXISTS masque_snapshots (
  id TEXT PRIMARY KEY,
  owner_account_id INTEGER NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES masque_sessions(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  content_key TEXT NOT NULL,
  redactions TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS masque_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES platform_accounts(id) ON DELETE SET NULL,
  guest_hash TEXT,
  surface TEXT NOT NULL,
  model_family TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  queue_ms INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_masque_usage_limits ON masque_usage(account_id, guest_hash, surface, created_at DESC);

CREATE TABLE IF NOT EXISTS masque_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES platform_accounts(id) ON DELETE SET NULL,
  actor_kind TEXT NOT NULL DEFAULT 'account',
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_masque_audit_time ON masque_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_masque_audit_target ON masque_audit(target_type, target_id, created_at DESC);

-- Existing OSAII databases may predate the ON DELETE actions above. Keep
-- Platform account deletion recoverable and deterministic on those databases.
CREATE TRIGGER IF NOT EXISTS masque_before_platform_account_delete
BEFORE DELETE ON platform_accounts
BEGIN
  DELETE FROM masque_collaborators WHERE invited_by=OLD.id;
  DELETE FROM masque_invites WHERE created_by=OLD.id;
  UPDATE masque_character_versions SET changed_by=NULL WHERE changed_by=OLD.id;
  UPDATE masque_roles SET granted_by=NULL WHERE granted_by=OLD.id;
  UPDATE masque_feature_flags SET updated_by=NULL WHERE updated_by=OLD.id;
END;
