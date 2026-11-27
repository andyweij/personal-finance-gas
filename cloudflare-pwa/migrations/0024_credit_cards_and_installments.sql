-- Phase 7 (v1.15.0): Credit Card Billing Cycles & Installment Plans
-- Strictly follows v1.8.16 multi-tenant conventions: NO DEFAULT 'owner', composite PK (user_id, id).

-- 1. Backward-compatible credit card metadata on asset_items
ALTER TABLE asset_items ADD COLUMN is_credit_card INTEGER NOT NULL DEFAULT 0;
ALTER TABLE asset_items ADD COLUMN credit_billing_day INTEGER;
ALTER TABLE asset_items ADD COLUMN credit_due_day INTEGER;
ALTER TABLE asset_items ADD COLUMN credit_limit REAL;

-- 2. Installment plans table (monthly auto-posting + remaining future burden tracking)
CREATE TABLE IF NOT EXISTS installment_plans (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  ledger_id TEXT NOT NULL DEFAULT 'default',
  card_account_id TEXT,
  item_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '其他',
  total_amount REAL NOT NULL,
  total_installments INTEGER NOT NULL,
  posted_installments INTEGER NOT NULL DEFAULT 0,
  start_ym TEXT NOT NULL,
  post_day INTEGER NOT NULL DEFAULT 1,
  currency TEXT NOT NULL DEFAULT 'TWD',
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  change_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_installment_plans_user_seq
  ON installment_plans(user_id, change_seq);

CREATE INDEX IF NOT EXISTS idx_installment_plans_user_status
  ON installment_plans(user_id, status, start_ym DESC);

-- 3. Installment linkage & idempotency on cashflow_logs
ALTER TABLE cashflow_logs ADD COLUMN installment_plan_id TEXT;
ALTER TABLE cashflow_logs ADD COLUMN installment_seq INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cashflow_installment_unique
  ON cashflow_logs(user_id, installment_plan_id, installment_seq)
  WHERE installment_plan_id IS NOT NULL AND installment_seq IS NOT NULL AND deleted_at IS NULL;

-- 4. Expand automation_runs.kind CHECK to include 'installments'
CREATE TABLE automation_runs_v2 (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('recurring', 'snapshot', 'installments')),
  period TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('done', 'partial', 'failed')),
  detail TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, period)
);
INSERT INTO automation_runs_v2 (user_id, kind, period, status, detail, updated_at)
SELECT user_id, kind, period, status, detail, updated_at FROM automation_runs;
DROP TABLE automation_runs;
ALTER TABLE automation_runs_v2 RENAME TO automation_runs;
