-- 0013_sync_cursor_epoch_and_auto_fx.sql:
-- 1) Monotonic per-user change_seq cursor & data_epoch (for replace-import invalidation)
-- 2) Per-user auto_fx_enabled toggle on app_settings so cron never overwrites manual FX rates

CREATE TABLE IF NOT EXISTS user_sync_state (
  user_id TEXT PRIMARY KEY,
  change_seq INTEGER NOT NULL DEFAULT 0,
  data_epoch INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO user_sync_state (user_id, change_seq, data_epoch)
SELECT id, 0, 1 FROM users;

INSERT OR IGNORE INTO user_sync_state (user_id, change_seq, data_epoch)
VALUES ('owner', 0, 1);

CREATE TABLE IF NOT EXISTS sync_lww_timestamps (
  user_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  record_id TEXT NOT NULL,
  client_ts TEXT NOT NULL,
  PRIMARY KEY (user_id, entity, record_id)
);

ALTER TABLE app_settings ADD COLUMN auto_fx_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE app_settings ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ledgers ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cashflow_logs ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recurring_items ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sinking_fund_items ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE asset_items ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE savings_adjustments ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stock_transactions ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE networth_history ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rent_utility_records ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rent_utility_settings ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ledgers_user_seq ON ledgers(user_id, change_seq);
CREATE INDEX IF NOT EXISTS idx_cashflow_user_seq ON cashflow_logs(user_id, change_seq);
CREATE INDEX IF NOT EXISTS idx_recurring_user_seq ON recurring_items(user_id, change_seq);
CREATE INDEX IF NOT EXISTS idx_sinking_user_seq ON sinking_fund_items(user_id, change_seq);
CREATE INDEX IF NOT EXISTS idx_asset_user_seq ON asset_items(user_id, change_seq);
CREATE INDEX IF NOT EXISTS idx_savings_adj_user_seq ON savings_adjustments(user_id, change_seq);
CREATE INDEX IF NOT EXISTS idx_stock_tx_user_seq ON stock_transactions(user_id, change_seq);
CREATE INDEX IF NOT EXISTS idx_networth_user_seq ON networth_history(user_id, change_seq);
CREATE INDEX IF NOT EXISTS idx_utility_rec_user_seq ON rent_utility_records(user_id, change_seq);
