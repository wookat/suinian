-- R33: track when an api_token was last used so the settings page can show it
-- and nudge users to rotate stale tokens.
ALTER TABLE users ADD COLUMN last_used_at TEXT;
