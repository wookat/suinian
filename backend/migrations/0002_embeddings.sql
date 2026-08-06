-- R2: note embeddings for thread clustering
CREATE TABLE IF NOT EXISTS note_embeddings (
  note_id TEXT PRIMARY KEY REFERENCES notes(id),
  vector TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_thread ON notes(thread_id);
CREATE INDEX IF NOT EXISTS idx_reports_user_week ON weekly_reports(user_id, week_start);
