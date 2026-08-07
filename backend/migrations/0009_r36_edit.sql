-- R36: todo completion timestamp so the weekly report can count what got done
ALTER TABLE notes ADD COLUMN done_at TEXT;
