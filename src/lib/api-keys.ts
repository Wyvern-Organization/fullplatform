export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
};

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createApiKeySecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `osaii_${hex(bytes)}`;
}

export function createApiKeyId(): string {
  return crypto.randomUUID();
}

export async function hashApiKey(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return hex(new Uint8Array(digest));
}

type KeyCache = { accountId: number; expiresAt: number; lastUsedWrite: number };
const keyCache = new Map<string, KeyCache>();
const KEY_CACHE_TTL_MS = 60_000;
const LAST_USED_THROTTLE_MS = 60 * 60_000;

export async function accountForApiKey(request: Request, db: D1Database): Promise<number | null> {
  const value = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!value?.startsWith("osaii_")) return null;
  const keyHash = await hashApiKey(value);
  const now = Date.now();
  const cached = keyCache.get(keyHash);
  if (cached && now < cached.expiresAt) {
    if (now - cached.lastUsedWrite > LAST_USED_THROTTLE_MS) {
      cached.lastUsedWrite = now;
      db.prepare("UPDATE api_keys SET last_used_at=datetime('now') WHERE key_hash=?").bind(keyHash).run().catch(() => {});
    } else {
      // prune expired entries occasionally
      if (keyCache.size > 1000) for (const [k, v] of keyCache) if (now >= v.expiresAt) keyCache.delete(k);
    }
    return cached.accountId;
  }
  const row = await db.prepare("SELECT account_id FROM api_keys WHERE key_hash=? AND revoked_at IS NULL")
    .bind(keyHash).first<{ account_id: number }>();
  if (!row) return null;
  keyCache.set(keyHash, { accountId: row.account_id, expiresAt: now + KEY_CACHE_TTL_MS, lastUsedWrite: now });
  // fire-and-forget throttled write; don't await on hot path?
  db.prepare("UPDATE api_keys SET last_used_at=datetime('now') WHERE key_hash=?").bind(keyHash).run().catch(() => {});
  if (keyCache.size > 2000) {
    // LRU eviction: delete oldest half
    const entries = [...keyCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (let i = 0; i < entries.length / 2; i++) keyCache.delete(entries[i][0]);
  }
  return row.account_id;
}
