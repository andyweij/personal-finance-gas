-- 0020_multi_currency.sql:
-- Add enabled_currencies_json and fx_rates_json to app_settings (zero extra D1 queries, backward compatible)
ALTER TABLE app_settings ADD COLUMN enabled_currencies_json TEXT NOT NULL DEFAULT '["TWD","USD"]';
ALTER TABLE app_settings ADD COLUMN fx_rates_json TEXT NOT NULL DEFAULT '{}';
