-- R47: per-user push preferences (daily review push / todo reminder push, default on)
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  daily_review_push INTEGER NOT NULL DEFAULT 1,
  todo_reminder_push INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
