-- R64: soft delete for notes. Deleting marks deleted_at; a cron sweep hard
-- deletes (and cleans derived data) after the undo window expires.
ALTER TABLE notes ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_notes_deleted_at ON notes(deleted_at) WHERE deleted_at IS NOT NULL;
