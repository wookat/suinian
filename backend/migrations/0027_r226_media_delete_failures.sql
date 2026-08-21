-- R226 P1（audit-r225 §3c）：注销/删除级联的 R2 批量删除失败此前被
-- catch(console.error) 静默吞掉，无重试无对账，泄漏用户隐私原件。
-- 失败 key 落表由 10 分钟 cron 重试，删成功才清行——失败不再静默。
CREATE TABLE IF NOT EXISTS media_delete_failures (
  r2_key TEXT PRIMARY KEY,
  enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT
);
