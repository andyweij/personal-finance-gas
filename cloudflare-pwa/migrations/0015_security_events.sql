-- 0015_security_events.sql
-- H1: audit trail for security-sensitive account events (e.g. a password reset completed with a code that an
-- admin created). Shown to the member on sign-in so an admin cannot silently take over a member account.
CREATE TABLE IF NOT EXISTS auth_security_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_user_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_security_events_user ON auth_security_events (user_id, created_at);
