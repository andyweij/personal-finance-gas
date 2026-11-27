-- 0022_recurring_post_day.sql:
-- v1.13.1: day of month (1-31) a recurring item's auto-posted cash-flow entry is dated.
-- Existing items keep the previous behaviour (the 1st). A day the month lacks is posted on its last day.
ALTER TABLE recurring_items ADD COLUMN post_day INTEGER NOT NULL DEFAULT 1;
