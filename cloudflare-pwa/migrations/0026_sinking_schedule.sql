-- 0026_sinking_schedule.sql:
-- v2.1.0: 攤提與預備金加上期間。
--   start_ym      開始月份 (YYYY-MM)。NULL = 舊項目，維持「啟用即每月計入」的原行為。
--   repeat_yearly 1 = 每年從開始月份重新起算一輪（如所得稅、保費）；0 = 期滿自動結束。
--   fund_kind     'save_first' 先存後付（預備金）／'amortize' 已付分攤（成本攤提）。只影響顯示，不影響金額計算。
ALTER TABLE sinking_fund_items ADD COLUMN start_ym TEXT;
ALTER TABLE sinking_fund_items ADD COLUMN repeat_yearly INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sinking_fund_items ADD COLUMN fund_kind TEXT NOT NULL DEFAULT 'save_first';
