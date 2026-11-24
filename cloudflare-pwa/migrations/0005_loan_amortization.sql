-- 0005_loan_amortization.sql: Optional auto-amortization fields for liabilities
-- Reuses existing asset_items.balance_anchor_date as the loan statement anchor date.

ALTER TABLE asset_items ADD COLUMN is_amortizing_loan INTEGER NOT NULL DEFAULT 0;
ALTER TABLE asset_items ADD COLUMN loan_annual_rate REAL;
ALTER TABLE asset_items ADD COLUMN loan_monthly_payment REAL;
ALTER TABLE asset_items ADD COLUMN loan_billing_day INTEGER;
