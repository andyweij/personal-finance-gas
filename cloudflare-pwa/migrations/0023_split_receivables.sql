-- Phase 6 (v1.14.0): Split Expenses & Advance Receivables Tracking
-- Strictly follows v1.8.16 multi-tenant conventions: NO DEFAULT 'owner', composite PK (user_id, id).

CREATE TABLE IF NOT EXISTS split_receivables (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  ledger_id TEXT NOT NULL DEFAULT 'default',
  split_group_id TEXT NOT NULL DEFAULT '',
  counterparty TEXT NOT NULL,
  date TEXT NOT NULL,
  item_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '餐飲',
  amount REAL NOT NULL,
  settled_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'TWD',
  fx_rate REAL NOT NULL DEFAULT 1,
  twd_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  source_cashflow_id TEXT,
  source_account_id TEXT,
  source_adjustment_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  change_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_split_receivables_user_seq
  ON split_receivables(user_id, change_seq);

CREATE INDEX IF NOT EXISTS idx_split_receivables_user_status
  ON split_receivables(user_id, status, date DESC);
