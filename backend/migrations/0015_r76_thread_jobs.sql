-- R76: async thread rebuild jobs + full-history clustering backfill cursor
CREATE TABLE IF NOT EXISTS thread_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'rebuild',
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | error
  phase TEXT NOT NULL DEFAULT 'reset',   -- reset | cluster | second_pass | summarize | done
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  threads INTEGER,
  state TEXT,                            -- JSON resume state (cursor etc.)
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_thread_jobs_user ON thread_jobs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS thread_backfill (
  user_id TEXT PRIMARY KEY,
  cursor_created_at TEXT NOT NULL DEFAULT '',
  cursor_id TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
