-- R298 P2-3（audit-r297 §7）：判别器失败 / 降级 / 隔离此前只有 console 日志，
-- 而 Observability API 取不到（两个 token 都是 Authentication error），于是
-- 「生产判别器不可用发生率」无人可声称。这里按天 × 事件类型累加计数（无用户
-- 维度、无内容，纯运营指标），写入走 waitUntil，不进请求关键路径。
CREATE TABLE IF NOT EXISTS guard_events (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day, kind)
);
