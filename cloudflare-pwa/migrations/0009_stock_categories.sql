-- 0009_stock_categories.sql:
-- 1. Add stock_category to asset_items (e.g. '個股', 'ETF', '特別股', or custom user category)
-- 2. Add custom_stock_categories JSON array to app_settings (synced per user)

ALTER TABLE asset_items ADD COLUMN stock_category TEXT NOT NULL DEFAULT '';
ALTER TABLE app_settings ADD COLUMN custom_stock_categories TEXT NOT NULL DEFAULT '[]';
