-- Suinian R1 initial schema
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  wechat_binding TEXT,
  api_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  source TEXT NOT NULL,              -- wechat|android|web|api
  raw_type TEXT NOT NULL,            -- text|link|image|voice|file
  content TEXT NOT NULL,
  url TEXT,
  url_title TEXT,
  url_summary TEXT,
  category TEXT,                     -- idea|todo|collect|data
  tags TEXT NOT NULL DEFAULT '[]',   -- JSON array
  title TEXT,
  thread_id TEXT,
  is_sensitive INTEGER NOT NULL DEFAULT 0,
  content_enc TEXT,
  todo_due TEXT,
  todo_done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_user_created ON notes(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(user_id, category);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  summary TEXT,
  note_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS weekly_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  week_start TEXT NOT NULL,
  content_md TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id),
  r2_key TEXT NOT NULL,
  mime TEXT,
  size INTEGER
);
