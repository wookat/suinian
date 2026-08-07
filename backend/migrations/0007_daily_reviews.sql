-- R31: daily review touchpoints (昨日回声 / 那年今日)
CREATE TABLE IF NOT EXISTS daily_reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  review_date TEXT NOT NULL,          -- YYYY-MM-DD in Asia/Shanghai
  note_id TEXT NOT NULL REFERENCES notes(id),
  kind TEXT NOT NULL,                 -- year_ago | month_ago | revisit
  comment TEXT,                       -- one-line AI comment on why this is worth revisiting
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_reviews_user_date_note ON daily_reviews(user_id, review_date, note_id);
CREATE INDEX IF NOT EXISTS idx_daily_reviews_user_date ON daily_reviews(user_id, review_date);
