-- Performance indexes for hot paths (bootstrap batch already reduces round-trips; indexes reduce per-query scan time)
CREATE INDEX IF NOT EXISTS idx_request_activity_surface_path_time ON request_activity(surface, path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_activity_account_surface_path_time ON request_activity(account_id, surface, path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_activity_ip_surface_path_time ON request_activity(ip_hash, surface, path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_surface_provider_time ON token_usage(surface, provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_chats_account_updated ON studio_chats(account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_memories_account_updated ON studio_memories(account_id, updated_at DESC);
-- Covering indexes for masque and cosaii hot loops are already present; no schema change needed for batch/conditional aggregation
