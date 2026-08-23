-- R262 P1-1（audit-r261 §P1-1）：转敏感后附件加密此前 catch(console.error)
-- 静默吞掉失败，且逐对象无重试/无写后复核，生产间歇性明文残留（7 试 5 复现）。
-- 加密失败 key 落表由 10 分钟 cron 重试，head() 复核加密态成功才清行。
CREATE TABLE IF NOT EXISTS media_encrypt_failures (
  r2_key TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT
);
