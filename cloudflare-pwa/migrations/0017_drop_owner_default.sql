-- 0017 (v1.8.16, B7): remove `user_id … DEFAULT 'owner'` from the 12 tenant tables.
--
-- Why: the default was only needed in 0007 to assign pre-multi-tenant rows to the original user ('owner').
-- Today it is a trap: an INSERT that forgets user_id would silently file the row under the admin account
-- instead of failing. Without the default such an INSERT fails with "NOT NULL constraint failed".
--
-- How: SQLite cannot alter a column default, so each table is rebuilt:
--   1. CREATE TABLE <t>__v17 — identical definition (generated from the schema after 0016), only without the default
--   2. INSERT INTO <t>__v17 (<every column>) SELECT <every column> FROM <t>   — every row is copied unchanged
--   3. DROP TABLE <t>; ALTER TABLE <t>__v17 RENAME TO <t>
--   4. recreate every index of <t> with its original name and definition
-- No table has foreign keys or triggers. Rows, column order, types, other defaults, primary keys and indexes
-- are unchanged (verified by tests/v1816-tenant-rebuild.test.ts and on local workerd D1).
-- Back up first: npm run db:backup:remote

PRAGMA defer_foreign_keys = true;

-- asset_items
CREATE TABLE asset_items__v17 (
  user_id TEXT NOT NULL,
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
  version INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, stock_category TEXT NOT NULL DEFAULT '', is_watchlist INTEGER NOT NULL DEFAULT 0, previous_close REAL, ledger_id TEXT NOT NULL DEFAULT 'default', exclude_from_net_worth INTEGER NOT NULL DEFAULT 0, change_seq INTEGER NOT NULL DEFAULT 0, quote_checked_at TEXT,
  PRIMARY KEY (user_id, id)
);
INSERT INTO asset_items__v17 (user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, price_updated_at, note, is_linked_savings, balance_anchor_date, balance_anchor_at, is_default_savings, cost_basis, is_amortizing_loan, loan_annual_rate, loan_monthly_payment, loan_billing_day, created_at, updated_at, deleted_at, version, sort_order, stock_category, is_watchlist, previous_close, ledger_id, exclude_from_net_worth, change_seq, quote_checked_at)
SELECT user_id, id, update_mode, major_type, sub_category, liquidity, item_name, ticker, quantity_or_amount, currency, unit_price, price_updated_at, note, is_linked_savings, balance_anchor_date, balance_anchor_at, is_default_savings, cost_basis, is_amortizing_loan, loan_annual_rate, loan_monthly_payment, loan_billing_day, created_at, updated_at, deleted_at, version, sort_order, stock_category, is_watchlist, previous_close, ledger_id, exclude_from_net_worth, change_seq, quote_checked_at FROM asset_items;
DROP TABLE asset_items;
ALTER TABLE asset_items__v17 RENAME TO asset_items;
CREATE INDEX idx_asset_user_ledger ON asset_items(user_id, ledger_id);
CREATE INDEX idx_asset_user_seq ON asset_items(user_id, change_seq);
CREATE INDEX idx_asset_user_sort ON asset_items(user_id, sort_order, created_at);
CREATE INDEX idx_asset_user_updated ON asset_items(user_id, updated_at);

-- auth_passkeys
CREATE TABLE auth_passkeys__v17 (
  credential_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  device_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
, user_id TEXT NOT NULL);
INSERT INTO auth_passkeys__v17 (credential_id, public_key, counter, transports, device_name, created_at, user_id)
SELECT credential_id, public_key, counter, transports, device_name, created_at, user_id FROM auth_passkeys;
DROP TABLE auth_passkeys;
ALTER TABLE auth_passkeys__v17 RENAME TO auth_passkeys;
CREATE INDEX idx_auth_passkeys_user ON auth_passkeys(user_id);

-- auth_sessions
CREATE TABLE auth_sessions__v17 (
  token_hash TEXT PRIMARY KEY,
  device_label TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
, user_id TEXT NOT NULL);
INSERT INTO auth_sessions__v17 (token_hash, device_label, expires_at, created_at, last_seen_at, user_id)
SELECT token_hash, device_label, expires_at, created_at, last_seen_at, user_id FROM auth_sessions;
DROP TABLE auth_sessions;
ALTER TABLE auth_sessions__v17 RENAME TO auth_sessions;
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);

-- cashflow_logs
CREATE TABLE cashflow_logs__v17 (
  user_id TEXT NOT NULL,
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
  version INTEGER NOT NULL DEFAULT 1, ledger_id TEXT NOT NULL DEFAULT 'default', change_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
INSERT INTO cashflow_logs__v17 (user_id, id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, recurring_dedup_key, linked_account_id, created_at, updated_at, deleted_at, version, ledger_id, change_seq)
SELECT user_id, id, date, year_month, type, category, item_name, amount, currency, fx_rate, twd_amount, source, note, recurring_dedup_key, linked_account_id, created_at, updated_at, deleted_at, version, ledger_id, change_seq FROM cashflow_logs;
DROP TABLE cashflow_logs;
ALTER TABLE cashflow_logs__v17 RENAME TO cashflow_logs;
CREATE UNIQUE INDEX idx_cashflow_recurring_dedup ON cashflow_logs(user_id, recurring_dedup_key) WHERE recurring_dedup_key IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_cashflow_user_ledger_ym ON cashflow_logs(user_id, ledger_id, year_month, date DESC);
CREATE INDEX idx_cashflow_user_linked ON cashflow_logs(user_id, linked_account_id);
CREATE INDEX idx_cashflow_user_seq ON cashflow_logs(user_id, change_seq);
CREATE INDEX idx_cashflow_user_updated ON cashflow_logs(user_id, updated_at);
CREATE INDEX idx_cashflow_user_ym ON cashflow_logs(user_id, year_month, date DESC);

-- ledgers
CREATE TABLE ledgers__v17 (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  include_in_net_worth INTEGER NOT NULL DEFAULT 1,
  monthly_daily_budget INTEGER,
  note TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1, change_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
INSERT INTO ledgers__v17 (user_id, id, name, include_in_net_worth, monthly_daily_budget, note, sort_order, created_at, updated_at, deleted_at, version, change_seq)
SELECT user_id, id, name, include_in_net_worth, monthly_daily_budget, note, sort_order, created_at, updated_at, deleted_at, version, change_seq FROM ledgers;
DROP TABLE ledgers;
ALTER TABLE ledgers__v17 RENAME TO ledgers;
CREATE INDEX idx_ledgers_user_seq ON ledgers(user_id, change_seq);
CREATE INDEX idx_ledgers_user_updated ON ledgers(user_id, updated_at);

-- networth_history
CREATE TABLE networth_history__v17 (
  user_id TEXT NOT NULL,
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
  updated_at TEXT NOT NULL, change_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, year_month)
);
INSERT INTO networth_history__v17 (user_id, year_month, snapshot_date, total_assets, total_liabilities, net_worth, high_liquidity_assets, investment_assets, insurance_assets, monthly_income, monthly_consumption, savings_rate, note, updated_at, change_seq)
SELECT user_id, year_month, snapshot_date, total_assets, total_liabilities, net_worth, high_liquidity_assets, investment_assets, insurance_assets, monthly_income, monthly_consumption, savings_rate, note, updated_at, change_seq FROM networth_history;
DROP TABLE networth_history;
ALTER TABLE networth_history__v17 RENAME TO networth_history;
CREATE INDEX idx_networth_user_seq ON networth_history(user_id, change_seq);
CREATE INDEX idx_networth_user_updated ON networth_history(user_id, updated_at);

-- recurring_items
CREATE TABLE recurring_items__v17 (
  user_id TEXT NOT NULL,
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
  version INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, ledger_id TEXT NOT NULL DEFAULT 'default', change_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
INSERT INTO recurring_items__v17 (user_id, id, item_name, category, type, amount, currency, cycle, billing_spec, status, note, linked_account_id, created_at, updated_at, deleted_at, version, sort_order, ledger_id, change_seq)
SELECT user_id, id, item_name, category, type, amount, currency, cycle, billing_spec, status, note, linked_account_id, created_at, updated_at, deleted_at, version, sort_order, ledger_id, change_seq FROM recurring_items;
DROP TABLE recurring_items;
ALTER TABLE recurring_items__v17 RENAME TO recurring_items;
CREATE INDEX idx_recurring_user_ledger ON recurring_items(user_id, ledger_id);
CREATE INDEX idx_recurring_user_seq ON recurring_items(user_id, change_seq);
CREATE INDEX idx_recurring_user_sort ON recurring_items(user_id, sort_order, created_at);
CREATE INDEX idx_recurring_user_updated ON recurring_items(user_id, updated_at);

-- rent_utility_records
CREATE TABLE rent_utility_records__v17 (
  user_id TEXT NOT NULL,
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
  version INTEGER NOT NULL DEFAULT 1, change_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);
INSERT INTO rent_utility_records__v17 (user_id, period, is_baseline, cur_total, cur_6f, total_elec, total_water, f6_people, f5_people, cur_a, cur_b, cur_c, created_at, updated_at, deleted_at, version, change_seq)
SELECT user_id, period, is_baseline, cur_total, cur_6f, total_elec, total_water, f6_people, f5_people, cur_a, cur_b, cur_c, created_at, updated_at, deleted_at, version, change_seq FROM rent_utility_records;
DROP TABLE rent_utility_records;
ALTER TABLE rent_utility_records__v17 RENAME TO rent_utility_records;
CREATE INDEX idx_rent_utility_user_updated ON rent_utility_records(user_id, updated_at);
CREATE INDEX idx_utility_rec_user_seq ON rent_utility_records(user_id, change_seq);

-- savings_adjustments
CREATE TABLE savings_adjustments__v17 (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  twd_amount INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1, transfer_group_id TEXT, change_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
INSERT INTO savings_adjustments__v17 (user_id, id, account_id, date, amount, twd_amount, note, created_at, updated_at, deleted_at, version, transfer_group_id, change_seq)
SELECT user_id, id, account_id, date, amount, twd_amount, note, created_at, updated_at, deleted_at, version, transfer_group_id, change_seq FROM savings_adjustments;
DROP TABLE savings_adjustments;
ALTER TABLE savings_adjustments__v17 RENAME TO savings_adjustments;
CREATE INDEX idx_savings_adj_user_account ON savings_adjustments(user_id, account_id);
CREATE INDEX idx_savings_adj_user_seq ON savings_adjustments(user_id, change_seq);
CREATE INDEX idx_savings_adj_user_transfer ON savings_adjustments(user_id, transfer_group_id) WHERE transfer_group_id IS NOT NULL;
CREATE INDEX idx_savings_adj_user_updated ON savings_adjustments(user_id, updated_at);

-- sinking_fund_items
CREATE TABLE sinking_fund_items__v17 (
  user_id TEXT NOT NULL,
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
  version INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, change_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
INSERT INTO sinking_fund_items__v17 (user_id, id, item_name, category, total_amount, months, due_note, status, note, created_at, updated_at, deleted_at, version, sort_order, change_seq)
SELECT user_id, id, item_name, category, total_amount, months, due_note, status, note, created_at, updated_at, deleted_at, version, sort_order, change_seq FROM sinking_fund_items;
DROP TABLE sinking_fund_items;
ALTER TABLE sinking_fund_items__v17 RENAME TO sinking_fund_items;
CREATE INDEX idx_sinking_user_seq ON sinking_fund_items(user_id, change_seq);
CREATE INDEX idx_sinking_user_sort ON sinking_fund_items(user_id, sort_order, created_at);
CREATE INDEX idx_sinking_user_updated ON sinking_fund_items(user_id, updated_at);

-- stock_transactions
CREATE TABLE stock_transactions__v17 (
  user_id TEXT NOT NULL,
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
  version INTEGER NOT NULL DEFAULT 1, change_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
INSERT INTO stock_transactions__v17 (user_id, id, asset_id, date, tx_type, shares, total_amount, fee, linked_cashflow_id, note, created_at, updated_at, deleted_at, version, change_seq)
SELECT user_id, id, asset_id, date, tx_type, shares, total_amount, fee, linked_cashflow_id, note, created_at, updated_at, deleted_at, version, change_seq FROM stock_transactions;
DROP TABLE stock_transactions;
ALTER TABLE stock_transactions__v17 RENAME TO stock_transactions;
CREATE INDEX idx_stock_tx_user_asset ON stock_transactions(user_id, asset_id);
CREATE INDEX idx_stock_tx_user_seq ON stock_transactions(user_id, change_seq);
CREATE INDEX idx_stock_tx_user_updated ON stock_transactions(user_id, updated_at);

-- sync_idempotency
CREATE TABLE sync_idempotency__v17 (
  user_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (user_id, mutation_id)
);
INSERT INTO sync_idempotency__v17 (user_id, mutation_id, applied_at)
SELECT user_id, mutation_id, applied_at FROM sync_idempotency;
DROP TABLE sync_idempotency;
ALTER TABLE sync_idempotency__v17 RENAME TO sync_idempotency;
