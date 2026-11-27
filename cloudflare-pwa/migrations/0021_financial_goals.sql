-- Phase 5 (v1.13.0): Financial Goals & Achievement Date Projection
-- Strictly follows v1.8.16 multi-tenant conventions: NO DEFAULT 'owner', composite PK (user_id, id).

CREATE TABLE IF NOT EXISTS financial_goals (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  goal_type TEXT NOT NULL DEFAULT 'manual',
  target_amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'TWD',
  linked_ledger_id TEXT,
  linked_asset_ids_json TEXT NOT NULL DEFAULT '[]',
  current_manual_amount REAL NOT NULL DEFAULT 0,
  expected_annual_return_pct REAL NOT NULL DEFAULT 0,
  monthly_contribution_override REAL,
  fire_swr_pct REAL,
  target_date TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  change_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_financial_goals_user_seq
  ON financial_goals(user_id, change_seq);
