-- R13: self-serve registration/login
-- password_hash: PBKDF2-SHA256 (see src/auth.ts). NULL for legacy token-only users.
ALTER TABLE users ADD COLUMN password_hash TEXT;

-- per-IP fixed-window rate limiting for /api/auth/register and /api/auth/login
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key TEXT PRIMARY KEY,          -- "<action>:<ip>"
  window_start TEXT NOT NULL,    -- ISO minute the window began
  count INTEGER NOT NULL DEFAULT 0
);
