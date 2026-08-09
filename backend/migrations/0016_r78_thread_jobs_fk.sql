-- R78: thread_jobs / thread_backfill were created (0015) without the
-- REFERENCES users(id) foreign key, so they escaped the account-deletion
-- cascade. Rebuild both tables with the FK and drop rows orphaned by
-- already-deleted accounts.

DELETE FROM thread_jobs WHERE user_id NOT IN (SELECT id FROM users);
DELETE FROM thread_backfill WHERE user_id NOT IN (SELECT id FROM users);

ALTER TABLE thread_jobs RENAME TO thread_jobs_v1;
CREATE TABLE thread_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
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
INSERT INTO thread_jobs SELECT * FROM thread_jobs_v1;
DROP TABLE thread_jobs_v1;
CREATE INDEX IF NOT EXISTS idx_thread_jobs_user ON thread_jobs(user_id, created_at DESC);

ALTER TABLE thread_backfill RENAME TO thread_backfill_v1;
CREATE TABLE thread_backfill (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  cursor_created_at TEXT NOT NULL DEFAULT '',
  cursor_id TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO thread_backfill SELECT * FROM thread_backfill_v1;
DROP TABLE thread_backfill_v1;
