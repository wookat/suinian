-- R85: WeChat Official Account (公众号) binding — normal users record notes by
-- messaging the official account, no self-hosted bridge required.

CREATE TABLE IF NOT EXISTS wechat_mp_bindings (
  openid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wechat_mp_bindings_user ON wechat_mp_bindings(user_id);

CREATE TABLE IF NOT EXISTS wechat_mp_bind_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wechat_mp_bind_codes_user ON wechat_mp_bind_codes(user_id);
