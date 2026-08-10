-- R86: WeCom 微信客服 (WeChat Customer Service) channel — official channel that
-- can receive forwarded articles (link) and files, complementing the 公众号.

CREATE TABLE IF NOT EXISTS wecom_kf_bindings (
  external_userid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wecom_kf_bindings_user ON wecom_kf_bindings(user_id);

-- Small KV table for channel state that must survive Worker isolate recycling:
-- the cached corp access_token and the per-kf-account sync_msg cursor.
CREATE TABLE IF NOT EXISTS wecom_kf_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
