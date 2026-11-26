-- 0016 (v1.8.13, H6): record which scheduled automation periods have run, so a missed run (cron failure, quota,
-- deployment gap) is caught up by the next scheduled invocation.
--   kind   'recurring' = monthly recurring auto-posting for period YYYY-MM
--          'snapshot'  = month-end net-worth snapshot for period YYYY-MM
--   status 'done' | 'partial' (stopped early because the per-invocation budget ran out; resumed next run) | 'failed'
CREATE TABLE IF NOT EXISTS automation_runs (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('recurring', 'snapshot')),
  period TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('done', 'partial', 'failed')),
  detail TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, period)
);

-- Baseline (Asia/Taipei, the default APP_TIMEZONE): periods that demonstrably already ran before this deployment are
-- marked done so the catch-up never re-runs them. A period without evidence (no auto-posted entry this month / no
-- snapshot for last month) is left for the catch-up — that is exactly the missed run H6 is meant to repair.
INSERT OR IGNORE INTO automation_runs (user_id, kind, period, status, detail, updated_at)
SELECT DISTINCT c.user_id, 'recurring', c.year_month, 'done', 'baseline (migration 0016)', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM cashflow_logs c
WHERE c.source = '自動入帳' AND c.year_month = strftime('%Y-%m', 'now', '+8 hours');

INSERT OR IGNORE INTO automation_runs (user_id, kind, period, status, detail, updated_at)
SELECT n.user_id, 'snapshot', n.year_month, 'done', 'baseline (migration 0016)', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM networth_history n
WHERE n.year_month <= strftime('%Y-%m', 'now', '+8 hours', 'start of month', '-1 day');
