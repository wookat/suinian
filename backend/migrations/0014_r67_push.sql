-- R67: Web Push (VAPID) — subscription endpoints, per-todo reminder dedupe, daily-review push log
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  tz TEXT,                            -- IANA timezone reported by the browser at subscribe time
  ua TEXT,                            -- user agent label so settings can show "which device"
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_ok_at TEXT                     -- last successful delivery
);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

-- each todo fires at most one due reminder
ALTER TABLE notes ADD COLUMN todo_reminded_at TEXT;

-- daily review push: at most one per user per (local) day
CREATE TABLE IF NOT EXISTS push_daily_log (
  user_id TEXT NOT NULL REFERENCES users(id),
  review_date TEXT NOT NULL,          -- YYYY-MM-DD in the user's local timezone
  pushed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, review_date)
);
