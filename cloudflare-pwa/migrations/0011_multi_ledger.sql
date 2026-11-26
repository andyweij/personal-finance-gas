-- 0011_multi_ledger.sql:
-- Multi-ledger isolation (books) with per-ledger net-worth inclusion & per-asset override

CREATE TABLE IF NOT EXISTS ledgers (
  user_id TEXT NOT NULL DEFAULT 'owner',
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  include_in_net_worth INTEGER NOT NULL DEFAULT 1,
  monthly_daily_budget INTEGER,
  note TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_ledgers_user_updated ON ledgers(user_id, updated_at);

-- Seed default primary ledger for all existing users
INSERT OR IGNORE INTO ledgers (user_id, id, name, include_in_net_worth, monthly_daily_budget, note, sort_order, created_at, updated_at, deleted_at, version)
SELECT id, 'default', '個人主帳本', 1, NULL, '預設個人帳本（納入總資產與淨值統計）', 1, created_at, updated_at, NULL, 1
FROM users;

-- Attach ledger_id to cashflow_logs, asset_items, recurring_items
ALTER TABLE cashflow_logs ADD COLUMN ledger_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_cashflow_user_ledger_ym ON cashflow_logs(user_id, ledger_id, year_month, date DESC);

ALTER TABLE asset_items ADD COLUMN ledger_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE asset_items ADD COLUMN exclude_from_net_worth INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_asset_user_ledger ON asset_items(user_id, ledger_id);

ALTER TABLE recurring_items ADD COLUMN ledger_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_recurring_user_ledger ON recurring_items(user_id, ledger_id);
