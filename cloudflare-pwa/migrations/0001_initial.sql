-- 0001_initial.sql: Personal Finance Offline-First PWA (Cloudflare D1 / SQLite)

-- 1. 全域設定（單筆 id = 1）
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  monthly_daily_budget INTEGER NOT NULL DEFAULT 45000,
  emergency_target_months INTEGER NOT NULL DEFAULT 6,
  usd_twd_rate REAL NOT NULL DEFAULT 32.5,
  fx_updated_at TEXT,
  updated_at TEXT NOT NULL
);

-- 2. 收支流水帳（對應 CashFlow_Log）
CREATE TABLE IF NOT EXISTS cashflow_logs (
  id TEXT PRIMARY KEY,
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cashflow_ym ON cashflow_logs(year_month, date DESC);
CREATE INDEX IF NOT EXISTS idx_cashflow_updated ON cashflow_logs(updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cashflow_recurring_dedup
  ON cashflow_logs(recurring_dedup_key)
  WHERE recurring_dedup_key IS NOT NULL AND deleted_at IS NULL;

-- 3. 常態性與排程收支（對應 Recurring_Config）
CREATE TABLE IF NOT EXISTS recurring_items (
  id TEXT PRIMARY KEY,
  item_name TEXT NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'TWD',
  cycle TEXT NOT NULL DEFAULT '月繳',
  billing_spec TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '啟用',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recurring_updated ON recurring_items(updated_at);

-- 4. 不定期稅金與大額攤提（對應 Annual_Sinking_Fund）
CREATE TABLE IF NOT EXISTS sinking_fund_items (
  id TEXT PRIMARY KEY,
  item_name TEXT NOT NULL,
  category TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  months INTEGER NOT NULL DEFAULT 12,
  due_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '啟用',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sinking_updated ON sinking_fund_items(updated_at);

-- 5. 資產負債明細（對應 Assets_Liabilities）
CREATE TABLE IF NOT EXISTS asset_items (
  id TEXT PRIMARY KEY,
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_asset_updated ON asset_items(updated_at);

-- 6. 每月淨資產歷史快照（對應 NetWorth_History）
CREATE TABLE IF NOT EXISTS networth_history (
  year_month TEXT PRIMARY KEY,
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
  updated_at TEXT NOT NULL
);

-- 7. 單一擁有者憑證（id = 1）
CREATE TABLE IF NOT EXISTS auth_owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  pin_enabled INTEGER NOT NULL DEFAULT 0,
  pin_hash TEXT,
  pin_salt TEXT,
  updated_at TEXT NOT NULL
);

-- 8. WebAuthn Passkey 憑證
CREATE TABLE IF NOT EXISTS auth_passkeys (
  credential_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  device_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- 9. 伺服器 Session（僅存 Token SHA-256 雜湊）
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  device_label TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- 10. WebAuthn 一次性 Challenge（5 分鐘過期）
CREATE TABLE IF NOT EXISTS auth_challenges (
  challenge TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- 11. 暴力破解防護限速表
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  ip_key TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

-- 12. 離線同步冪等紀錄
CREATE TABLE IF NOT EXISTS sync_idempotency (
  mutation_id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
