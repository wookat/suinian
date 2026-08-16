-- R152 P1-1: API tokens are stored as SHA-256 hashes here; the raw token is
-- shown to the client exactly once at issue time. Legacy plaintext rows in
-- users.api_token keep authenticating and are migrated into this table on
-- first use (the plaintext is then replaced with an unmatchable sentinel).
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
