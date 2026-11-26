-- 0014_auth_challenge_expiry_index.sql
-- Each passkey options request deletes expired challenges (DELETE ... WHERE expires_at <= ?).
-- Without an index that DELETE scans the whole table on every request.
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires_at ON auth_challenges (expires_at);
