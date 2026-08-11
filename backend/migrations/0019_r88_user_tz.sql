-- R88: per-user IANA timezone (taken from the browser); triage interprets
-- relative dates ("明天上午10点") in this timezone instead of assuming +08:00
ALTER TABLE user_preferences ADD COLUMN tz TEXT;
