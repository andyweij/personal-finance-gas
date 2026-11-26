-- 0012_transfer_group.sql:
-- Link paired savings_adjustments created by an account-to-account transfer
-- so deleting one side can optionally undo the matching counterpart atomically.

ALTER TABLE savings_adjustments ADD COLUMN transfer_group_id TEXT;
CREATE INDEX IF NOT EXISTS idx_savings_adj_user_transfer
  ON savings_adjustments(user_id, transfer_group_id)
  WHERE transfer_group_id IS NOT NULL;
