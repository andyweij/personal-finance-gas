-- 0006_optimistic_versioning.sql: Server-managed optimistic locking version column
-- All existing rows initialize cleanly to version = 1.

ALTER TABLE app_settings ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cashflow_logs ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE recurring_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sinking_fund_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE asset_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE savings_adjustments ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE stock_transactions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rent_utility_records ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rent_utility_settings ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
