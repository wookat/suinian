-- Cron observability: one row per job, updated on every run, so "cron 没跑"
-- is distinguishable from "跑了但无素材" straight from the database.
CREATE TABLE IF NOT EXISTS cron_heartbeats (
  job TEXT PRIMARY KEY,
  last_run_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'cron',
  stats TEXT
);
