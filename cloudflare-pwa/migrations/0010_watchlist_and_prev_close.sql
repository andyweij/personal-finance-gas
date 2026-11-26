-- 0010_watchlist_and_prev_close.sql:
-- 1. Add is_watchlist flag to asset_items (1 = watchlist only, excluded from portfolio & net worth)
-- 2. Add previous_close to asset_items for daily price change & PnL coloring

ALTER TABLE asset_items ADD COLUMN is_watchlist INTEGER NOT NULL DEFAULT 0;
ALTER TABLE asset_items ADD COLUMN previous_close REAL;
