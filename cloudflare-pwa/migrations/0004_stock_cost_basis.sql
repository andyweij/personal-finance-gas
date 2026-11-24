-- 0004_stock_cost_basis.sql: Stock cost basis, buy/sell moving-average ledger, and cash/stock dividend tracking

-- 1. 擴充 asset_items：記錄股票期初基準總成本（原幣，NULL 表示尚未設定成本）
ALTER TABLE asset_items ADD COLUMN cost_basis REAL;

-- 2. 新增 stock_transactions：持股買入 / 賣出 / 現金配息 / 股票配股明細（確定性推導股數、均價與回本進度）
CREATE TABLE IF NOT EXISTS stock_transactions (
  id TEXT PRIMARY KEY,
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
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_stock_tx_asset ON stock_transactions(asset_id);
CREATE INDEX IF NOT EXISTS idx_stock_tx_updated ON stock_transactions(updated_at);
