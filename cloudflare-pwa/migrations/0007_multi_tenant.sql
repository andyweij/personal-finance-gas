-- 0007_multi_tenant.sql: Multi-tenant family architecture with composite PK isolation,
-- one-time invite codes, and zero-knowledge admin-assisted password resets.

-- 1. Users table (replaces single-row auth_owner)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  pin_enabled INTEGER NOT NULL DEFAULT 0,
  pin_hash TEXT,
  pin_salt TEXT,
  show_utility_tab INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

-- Seamlessly migrate existing single-owner credential to admin ('owner')
INSERT OR IGNORE INTO users
  (id, username, display_name, role, password_hash, password_salt, pin_enabled, pin_hash, pin_salt, show_utility_tab, is_active, created_at, updated_at, last_login_at)
SELECT
  'owner', 'admin', '管理員', 'admin', password_hash, password_salt, pin_enabled, pin_hash, pin_salt, 1, 1, updated_at, updated_at, NULL
FROM auth_owner
WHERE id = 1;

-- 2. One-time invite codes (only SHA-256 hash stored)
CREATE TABLE IF NOT EXISTS auth_invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by TEXT,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_invites_created ON auth_invites(created_at DESC);

-- 3. Zero-knowledge one-time password reset codes (only SHA-256 hash stored)
CREATE TABLE IF NOT EXISTS auth_password_resets (
  id TEXT PRIMARY KEY,
  target_user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_resets_target ON auth_password_resets(target_user_id);

-- 4. Attach user_id to existing auth tables
ALTER TABLE auth_passkeys ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';
CREATE INDEX IF NOT EXISTS idx_auth_passkeys_user ON auth_passkeys(user_id);

ALTER TABLE auth_sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

ALTER TABLE auth_challenges ADD COLUMN user_id TEXT;

-- 5. Rebuild tenant tables with composite PRIMARY KEY (user_id, ...) for engine-level isolation

-- 5.1 app_settings
CREATE TABLE app_settings_v2 (
  user_id TEXT PRIMARY KEY,
  monthly_daily_budget INTEGER NOT NULL DEFAULT 45000,
  emergency_target_months INTEGER NOT NULL DEFAULT 6,
  usd_twd_rate REAL NOT NULL DEFAULT 32.5,
  fx_updated_at TEXT,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO app_settings_v2 (user_id, monthly_daily_budget, emergency_target_months, usd_twd_rate, fx_updated_at, updated_at, version)
SELECT 'owner', monthly_daily_budget, emergency_target_months, usd_twd_rate, fx_updated_at, updated_at, version
FROM app_settings;
DROP TABLE app_settings;
ALTER TABLE app_settings_v2 RENAME TO app_settings;

-- 5.2 cashflow_logs
CREATE TABLE cashflow_logs_v2 (
  user_id TEXT NOT NULL DEFAULT 'owner',
  id TEXT NOT NULL,
  date TEXT NOT NULL,
  year_month TEXT NOT NULL,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  item_name TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'TWD',
  fx_rate REAL NOT NULL DEFAULT 1,
  twd_amount INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT '手機記帳',
  note TEXT NOT NULL DEFAULT '',
  recurring_dedup_key TEXT,
  linked_account_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, id)
);
INSERT INTO cashflow_logs_v2
  (user_id, id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, recurring_dedup_key, linked_account_id, created_at, updated_at, deleted_at, version)
SELECT
  'owner', id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, recurring_dedup_key, linked_account_id, created_at, updated_at, deleted_at, version
FROM cashflow_logs;
DROP TABLE cashflow_logs;
ALTER TABLE cashflow_logs_v2 RENAME TO cashflow_logs;
CREATE INDEX IF NOT EXISTS idx_cashflow_user_ym ON cashflow_logs(user_id, year_month, date DESC);
CREATE INDEX IF NOT EXISTS idx_cashflow_user_updated ON cashflow_logs(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_cashflow_user_linked ON cashflow_logs(user_id, linked_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cashflow_recurring_dedup
  ON cashflow_logs(user_id, recurring_dedup_key)
  WHERE recurring_dedup_key IS NOT NULL AND deleted_at IS NULL;

-- 5.3 recurring_items
CREATE TABLE recurring_items_v2 (
  user_id TEXT NOT NULL DEFAULT 'owner',
  id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'TWD',
  cycle TEXT NOT NULL DEFAULT '月繳',
  billing_spec TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '啟用',
  note TEXT NOT NULL DEFAULT '',
  linked_account_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, id)
);
INSERT INTO recurring_items_v2
  (user_id, id, item_name, category, type, amount, currency, cycle, billing_spec, status, note, linked_account_id, created_at, updated_at, deleted_at, version)
SELECT
  'owner', id, item_name, category, type, amount, currency, cycle, billing_spec, status, note, linked_account_id, created_at, updated_at, deleted_at, version
FROM recurring_items;
DROP TABLE recurring_items;
ALTER TABLE recurring_items_v2 RENAME TO recurring_items;
CREATE INDEX IF NOT EXISTS idx_recurring_user_updated ON recurring_items(user_id, updated_at);

-- 5.4 sinking_fund_items
CREATE TABLE sinking_fund_items_v2 (
  user_id TEXT NOT NULL DEFAULT 'owner',
  id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  category TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  months INTEGER NOT NULL DEFAULT 12,
  due_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '啟用',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, id)
);
INSERT INTO sinking_fund_items_v2
  (user_id, id, item_name, category, total_amount, months, due_note, status, note, created_at, updated_at, deleted_at, version)
SELECT
  'owner', id, item_name, category, total_amount, months, due_note, status, note, created_at, updated_at, deleted_at, version
FROM sinking_fund_items;
DROP TABLE sinking_fund_items;
ALTER TABLE sinking_fund_items_v2 RENAME TO sinking_fund_items;
CREATE INDEX IF NOT EXISTS idx_sinking_user_updated ON sinking_fund_items(user_id, updated_at);

-- 5.5 asset_items
CREATE TABLE asset_items_v2 (
  user_id TEXT NOT NULL DEFAULT 'owner',
  id TEXT NOT NULL,
  update_mode TEXT NOT NULL DEFAULT '手動快照',
  major_type TEXT NOT NULL DEFAULT '資產',
  sub_category TEXT NOT NULL,
  liquidity TEXT NOT NULL DEFAULT '中流動',
  item_name TEXT NOT NULL,
  ticker TEXT NOT NULL DEFAULT '',
  quantity_or_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'TWD',
  unit_price REAL NOT NULL DEFAULT 1,
  price_updated_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  is_linked_savings INTEGER NOT NULL DEFAULT 0,
  balance_anchor_date TEXT,
  balance_anchor_at TEXT,
  is_default_savings INTEGER NOT NULL DEFAULT 0,
  cost_basis REAL,
  is_amortizing_loan INTEGER NOT NULL DEFAULT 0,
  loan_annual_rate REAL,
  loan_monthly_payment REAL,
  loan_billing_day INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, id)
);
INSERT INTO asset_items_v2
  (user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, price_updated_at, note, is_linked_savings, balance_anchor_date, balance_anchor_at, is_default_savings, cost_basis, is_amortizing_loan, loan_annual_rate, loan_monthly_payment, loan_billing_day, created_at, updated_at, deleted_at, version)
SELECT
  'owner', id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, price_updated_at, note, is_linked_savings, balance_anchor_date, balance_anchor_at, is_default_savings, cost_basis, is_amortizing_loan, loan_annual_rate, loan_monthly_payment, loan_billing_day, created_at, updated_at, deleted_at, version
FROM asset_items;
DROP TABLE asset_items;
ALTER TABLE asset_items_v2 RENAME TO asset_items;
CREATE INDEX IF NOT EXISTS idx_asset_user_updated ON asset_items(user_id, updated_at);

-- 5.6 savings_adjustments
CREATE TABLE savings_adjustments_v2 (
  user_id TEXT NOT NULL DEFAULT 'owner',
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  twd_amount INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, id)
);
INSERT INTO savings_adjustments_v2
  (user_id, id, account_id, date, amount, twd_amount, note, created_at, updated_at, deleted_at, version)
SELECT
  'owner', id, account_id, date, amount, twd_amount, note, created_at, updated_at, deleted_at, version
FROM savings_adjustments;
DROP TABLE savings_adjustments;
ALTER TABLE savings_adjustments_v2 RENAME TO savings_adjustments;
CREATE INDEX IF NOT EXISTS idx_savings_adj_user_account ON savings_adjustments(user_id, account_id);
CREATE INDEX IF NOT EXISTS idx_savings_adj_user_updated ON savings_adjustments(user_id, updated_at);

-- 5.7 stock_transactions
CREATE TABLE stock_transactions_v2 (
  user_id TEXT NOT NULL DEFAULT 'owner',
  id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  date TEXT NOT NULL,
  tx_type TEXT NOT NULL,
  shares REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  linked_cashflow_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, id)
);
INSERT INTO stock_transactions_v2
  (user_id, id, asset_id, date, tx_type, shares, total_amount, fee, linked_cashflow_id, note, created_at, updated_at, deleted_at, version)
SELECT
  'owner', id, asset_id, date, tx_type, shares, total_amount, fee, linked_cashflow_id, note, created_at, updated_at, deleted_at, version
FROM stock_transactions;
DROP TABLE stock_transactions;
ALTER TABLE stock_transactions_v2 RENAME TO stock_transactions;
CREATE INDEX IF NOT EXISTS idx_stock_tx_user_asset ON stock_transactions(user_id, asset_id);
CREATE INDEX IF NOT EXISTS idx_stock_tx_user_updated ON stock_transactions(user_id, updated_at);

-- 5.8 networth_history
CREATE TABLE networth_history_v2 (
  user_id TEXT NOT NULL DEFAULT 'owner',
  year_month TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  total_assets INTEGER NOT NULL,
  total_liabilities INTEGER NOT NULL,
  net_worth INTEGER NOT NULL,
  high_liquidity_assets INTEGER NOT NULL,
  investment_assets INTEGER NOT NULL,
  insurance_assets INTEGER NOT NULL,
  monthly_income INTEGER NOT NULL,
  monthly_consumption INTEGER NOT NULL,
  savings_rate REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, year_month)
);
INSERT INTO networth_history_v2
  (user_id, year_month, snapshot_date, total_assets, total_liabilities, net_worth, high_liquidity_assets, investment_assets, insurance_assets, monthly_income, monthly_consumption, savings_rate, note, updated_at)
SELECT
  'owner', year_month, snapshot_date, total_assets, total_liabilities, net_worth, high_liquidity_assets, investment_assets, insurance_assets, monthly_income, monthly_consumption, savings_rate, note, updated_at
FROM networth_history;
DROP TABLE networth_history;
ALTER TABLE networth_history_v2 RENAME TO networth_history;
CREATE INDEX IF NOT EXISTS idx_networth_user_updated ON networth_history(user_id, updated_at);

-- 5.9 rent_utility_records
CREATE TABLE rent_utility_records_v2 (
  user_id TEXT NOT NULL DEFAULT 'owner',
  period TEXT NOT NULL,
  is_baseline INTEGER NOT NULL DEFAULT 0,
  cur_total INTEGER NOT NULL DEFAULT 0,
  cur_6f INTEGER NOT NULL DEFAULT 0,
  total_elec INTEGER NOT NULL DEFAULT 0,
  total_water INTEGER NOT NULL DEFAULT 0,
  f6_people INTEGER NOT NULL DEFAULT 2,
  f5_people INTEGER NOT NULL DEFAULT 3,
  cur_a INTEGER NOT NULL DEFAULT 0,
  cur_b INTEGER NOT NULL DEFAULT 0,
  cur_c INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, period)
);
INSERT INTO rent_utility_records_v2
  (user_id, period, is_baseline, cur_total, cur_6f, total_elec, total_water, f6_people, f5_people, cur_a, cur_b, cur_c, created_at, updated_at, deleted_at, version)
SELECT
  'owner', period, is_baseline, cur_total, cur_6f, total_elec, total_water, f6_people, f5_people, cur_a, cur_b, cur_c, created_at, updated_at, deleted_at, version
FROM rent_utility_records;
DROP TABLE rent_utility_records;
ALTER TABLE rent_utility_records_v2 RENAME TO rent_utility_records;
CREATE INDEX IF NOT EXISTS idx_rent_utility_user_updated ON rent_utility_records(user_id, updated_at);

-- 5.10 rent_utility_settings
CREATE TABLE rent_utility_settings_v2 (
  user_id TEXT PRIMARY KEY,
  rent_6f INTEGER NOT NULL DEFAULT 0,
  rent_a INTEGER NOT NULL DEFAULT 0,
  rent_b INTEGER NOT NULL DEFAULT 0,
  rent_c INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO rent_utility_settings_v2 (user_id, rent_6f, rent_a, rent_b, rent_c, updated_at, version)
SELECT 'owner', rent_6f, rent_a, rent_b, rent_c, updated_at, version
FROM rent_utility_settings;
DROP TABLE rent_utility_settings;
ALTER TABLE rent_utility_settings_v2 RENAME TO rent_utility_settings;

-- 5.11 sync_idempotency
CREATE TABLE sync_idempotency_v2 (
  user_id TEXT NOT NULL DEFAULT 'owner',
  mutation_id TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (user_id, mutation_id)
);
INSERT INTO sync_idempotency_v2 (user_id, mutation_id, applied_at)
SELECT 'owner', mutation_id, applied_at
FROM sync_idempotency;
DROP TABLE sync_idempotency;
ALTER TABLE sync_idempotency_v2 RENAME TO sync_idempotency;
