-- 0008_sort_order_and_pnl_scheme.sql:
-- 1. Add user-customizable positive/negative color scheme to app_settings ('intl' | 'tw' | 'tw_stocks')
-- 2. Add manual sort_order integer column to asset_items, recurring_items, and sinking_fund_items

ALTER TABLE app_settings ADD COLUMN pnl_color_scheme TEXT NOT NULL DEFAULT 'intl';

ALTER TABLE asset_items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recurring_items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sinking_fund_items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_asset_user_sort ON asset_items(user_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_recurring_user_sort ON recurring_items(user_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_sinking_user_sort ON sinking_fund_items(user_id, sort_order, created_at);
