-- 0002_savings_linkage.sql: Live-linked savings accounts, deposit adjustments, and cashflow linkage

-- 1. 擴充 asset_items：標記活存連動帳戶、餘額起算基準日/時間戳與預設主帳戶
ALTER TABLE asset_items ADD COLUMN is_linked_savings INTEGER NOT NULL DEFAULT 0;
ALTER TABLE asset_items ADD COLUMN balance_anchor_date TEXT;
ALTER TABLE asset_items ADD COLUMN balance_anchor_at TEXT;
ALTER TABLE asset_items ADD COLUMN is_default_savings INTEGER NOT NULL DEFAULT 0;

-- 2. 擴充 cashflow_logs：記錄連動之活存帳戶 ID（NULL = 不連動）
ALTER TABLE cashflow_logs ADD COLUMN linked_account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_cashflow_linked_account ON cashflow_logs(linked_account_id);

-- 3. 擴充 recurring_items：每月自動入帳時可自動帶入連動活存帳戶
ALTER TABLE recurring_items ADD COLUMN linked_account_id TEXT;

-- 4. 新增 savings_adjustments：活存本金存入 / 轉出累加紀錄（不影響損益報表）
CREATE TABLE IF NOT EXISTS savings_adjustments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  twd_amount INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_savings_adj_account ON savings_adjustments(account_id);
CREATE INDEX IF NOT EXISTS idx_savings_adj_updated ON savings_adjustments(updated_at);
