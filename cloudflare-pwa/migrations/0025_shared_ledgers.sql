-- Phase 9 (v2.0.0): Optional Shared Ledgers (Owner-Anchored Access Layer)
-- Strictly follows v1.8.16 multi-tenant conventions: NO DEFAULT 'owner', explicit user/member IDs.

-- 1. Shared ledger membership & per-member net-worth preference
CREATE TABLE IF NOT EXISTS ledger_members (
  ledger_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  include_in_net_worth INTEGER NOT NULL DEFAULT 0 CHECK (include_in_net_worth IN (0, 1)),
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (ledger_id, member_user_id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_members_member_active
  ON ledger_members (member_user_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_ledger_members_owner_ledger
  ON ledger_members (owner_user_id, ledger_id, revoked_at);

-- 2. One-time high-entropy shared ledger invite codes (SHA-256 hash only)
CREATE TABLE IF NOT EXISTS ledger_invites (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_by TEXT,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_invites_owner_ledger
  ON ledger_invites (owner_user_id, ledger_id, created_at DESC);

-- 3. Optional last-actor attribution on shareable row entities
ALTER TABLE cashflow_logs ADD COLUMN updated_by TEXT;
ALTER TABLE asset_items ADD COLUMN updated_by TEXT;
ALTER TABLE recurring_items ADD COLUMN updated_by TEXT;
ALTER TABLE savings_adjustments ADD COLUMN updated_by TEXT;
ALTER TABLE split_receivables ADD COLUMN updated_by TEXT;
ALTER TABLE installment_plans ADD COLUMN updated_by TEXT;
