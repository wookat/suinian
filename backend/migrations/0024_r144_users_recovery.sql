-- R144 P1-2: passwordless account recovery via one-time recovery code.
-- Stores only the PBKDF2 hash of the code (same scheme as password_hash);
-- the plaintext code is shown to the user exactly once at generation time.
ALTER TABLE users ADD COLUMN recovery_hash TEXT;
