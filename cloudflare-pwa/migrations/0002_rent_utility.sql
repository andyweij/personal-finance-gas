-- 0002_rent_utility.sql: 5F & 6F 房租與水電費自動分攤紀錄與固定月租金設定

-- 13. 5F & 6F 抄表與水電帳單紀錄（對應 Rent_Utility）
CREATE TABLE IF NOT EXISTS rent_utility_records (
  period TEXT PRIMARY KEY,
  is_baseline INTEGER NOT NULL DEFAULT 0,
  cur_total INTEGER NOT NULL DEFAULT 0,
  cur_6f INTEGER NOT NULL DEFAULT 0,
  total_elec INTEGER NOT NULL DEFAULT 0,
  total_water INTEGER NOT NULL DEFAULT 0,
  f6_people INTEGER NOT NULL DEFAULT 2,
  f5_people INTEGER NOT NULL DEFAULT 3,
  cur_a INTEGER NOT NULL DEFAULT 0,
  cur_b INTEGER NOT NULL DEFAULT 0,
  cur_c INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rent_utility_updated ON rent_utility_records(updated_at);

-- 14. 5F & 6F 固定月租金設定（單筆 id = 1）
CREATE TABLE IF NOT EXISTS rent_utility_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rent_6f INTEGER NOT NULL DEFAULT 0,
  rent_a INTEGER NOT NULL DEFAULT 0,
  rent_b INTEGER NOT NULL DEFAULT 0,
  rent_c INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- 初始固定月租金設定（預設 0，不覆蓋已存在設定）
INSERT OR IGNORE INTO rent_utility_settings (id, rent_6f, rent_a, rent_b, rent_c, updated_at)
VALUES (1, 0, 0, 0, 0, '2026-01-01T00:00:00.000Z');

-- 初始確認起點表底 (11409) 與歷史抄表紀錄 (11411 ~ 11509)
INSERT OR IGNORE INTO rent_utility_records
  (period, is_baseline, cur_total, cur_6f, total_elec, total_water, f6_people, f5_people, cur_a, cur_b, cur_c, created_at, updated_at, deleted_at)
VALUES
  ('11409', 1, 52803, 4486, 0,    0,   2, 3, 8989, 5251, 6026, '2025-09-01T00:00:00.000Z', '2025-09-01T00:00:00.000Z', NULL),
  ('11411', 0, 54090, 4778, 3828, 570, 0, 3, 9235, 5454, 6140, '2025-11-01T00:00:00.000Z', '2025-11-01T00:00:00.000Z', NULL),
  ('11501', 0, 55048, 4998, 2328, 583, 2, 3, 9294, 5499, 6157, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
  ('11503', 0, 55893, 5173, 1974, 515, 2, 3, 9324, 5531, 6172, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', NULL),
  ('11505', 0, 57232, 5682, 3896, 656, 2, 3, 9443, 5585, 6205, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', NULL),
  ('11507', 0, 59341, 6607, 9201, 595, 2, 3, 9826, 5732, 6295, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', NULL),
  ('11509', 0, 61261, 7762, 8214, 494, 2, 3, 105,  5852, 6374, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL);
