-- 0018_rebalance_targets.sql:
-- Add rebalance_targets_json to app_settings (per-user portfolio target weights, synced via app_settings)
ALTER TABLE app_settings ADD COLUMN rebalance_targets_json TEXT NOT NULL DEFAULT '[]';
