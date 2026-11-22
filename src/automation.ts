/**
 * 自動化排程與觸發器管理 (automation.ts)
 * 1. 每月 1 號自動讀取 Recurring_Config（狀態=啟用）寫入 CashFlow_Log（具防重複機制，支援月繳/年繳/特定月份/一次性）
 * 2. 每月月底自動擷取 Assets_Liabilities 與當月現金流快照寫入 NetWorth_History
 * 3. 一鍵安裝、檢視與重設 GAS Time-Driven Triggers
 */

const TRIGGER_HANDLERS = {
  MONTHLY_RECURRING: 'runMonthlyRecurring',
  MONTH_END_CHECK: 'checkAndRunMonthEndSnapshot',
} as const;

/**
 * 選單入口：手動執行本月常態收支入帳
 */
function runMonthlyRecurringMenu(): void {
  const result = runMonthlyRecurring();
  const oneTimeMsg = result.deactivatedOneTimeCount > 0 ? `，自動停用已完成之一次性項目 ${result.deactivatedOneTimeCount} 筆` : '';
  const msg = `月份 ${result.yearMonth} 處理完成：新增 ${result.insertedCount} 筆，略過已存在 ${result.skippedCount} 筆${oneTimeMsg}（匯率 USD/TWD = ${result.fxRate}）。`;
  safeToast(msg, '常態收支入帳完成', 6);
  const ui = getUiOrNull();
  if (ui) {
    ui.alert('常態收支自動入帳完成', msg, ui.ButtonSet.OK);
  }
}

/**
 * 選單入口：立即執行本月淨資產快照
 */
function runMonthEndSnapshotMenu(): void {
  const result = runMonthEndNetWorthSnapshot();
  const actionLabel = result.updated ? '已更新本月既有快照' : '已新增本月快照';
  const msg = `${actionLabel}（${result.yearMonth}）\n總資產：NT$ ${result.totalAssets.toLocaleString()}\n總負債：NT$ ${result.totalLiabilities.toLocaleString()}\n淨資產：NT$ ${result.netWorth.toLocaleString()}`;
  safeToast(`淨資產快照完成：${result.yearMonth}`, '資產快照', 6);
  const ui = getUiOrNull();
  if (ui) {
    ui.alert('淨資產快照完成', msg, ui.ButtonSet.OK);
  }
}

/**
 * 每月 1 號自動入帳：讀取 Recurring_Config 中「啟用」的項目寫入 CashFlow_Log
 * - 支援月繳、年繳、特定月份（如 3,6,9,12）與一次性（入帳後自動改為停用）
 * - 支援 TWD / USD 雙幣別，並鎖定當下入帳匯率以保護歷史帳目不被未來匯率波動破壞
 * - 具冪等性（防重複）：同一月份已自動入帳的項目不會重複寫入
 */
function runMonthlyRecurring(
  targetYear?: number,
  targetMonth?: number
): {
  yearMonth: string;
  insertedCount: number;
  skippedCount: number;
  deactivatedOneTimeCount: number;
  fxRate: number;
} {
  const ss = getActiveSpreadsheetOrThrow();
  const configSheet = getSheetOrThrow(ss, SHEET_NAMES.RECURRING_CONFIG);
  const logSheet = getSheetOrThrow(ss, SHEET_NAMES.CASHFLOW_LOG);

  const now = new Date();
  const year = targetYear || now.getFullYear();
  const month = targetMonth || now.getMonth() + 1;
  const entryDate = new Date(year, month - 1, 1, 12, 0, 0);
  const targetYearMonth = formatYearMonth(entryDate);
  const usdRate = getLiveUsdTwdRate(ss);

  // 1. 掃描 CashFlow_Log 建立當月「自動入帳」去重集合
  const existingKeys = new Set<string>();
  const lastLogRow = findLastDataRowInColumn(logSheet, 1);
  if (lastLogRow >= 2) {
    const logData = logSheet.getRange(2, 1, lastLogRow - 1, 10).getValues();
    for (const row of logData) {
      const rowDate = row[0];
      const rowYm = rowDate instanceof Date ? formatYearMonth(rowDate) : String(row[1] || '').trim();
      const rowType = String(row[2] || '').trim();
      const rowName = String(row[4] || '').trim();
      const rowSource = String(row[9] || '').trim();

      if (rowYm === targetYearMonth && rowSource === '自動入帳') {
        existingKeys.add(buildRecurringDedupKey(rowType, rowName));
      }
    }
  }

  // 2. 讀取 Recurring_Config
  const lastConfigRow = findLastDataRowInColumn(configSheet, 1);
  const toInsert: CashFlowInput[] = [];
  const oneTimeRowsToDeactivate: Array<{ rowIndex: number; updatedNote: string }> = [];
  let skippedCount = 0;

  if (lastConfigRow >= 2) {
    const configRows = configSheet.getRange(2, 1, lastConfigRow - 1, 10).getValues();
    for (let i = 0; i < configRows.length; i++) {
      const row = configRows[i];
      const sheetRowIndex = i + 2;
      const itemName = String(row[0] || '').trim();
      const category = String(row[1] || '').trim() || '其他';
      const type = String(row[2] || '').trim();
      const amount = toSafeNumber(row[3], 0);
      const currency = String(row[4] || 'TWD').trim().toUpperCase();
      const cycle = String(row[5] || '月繳').trim();
      const billingSpec = row[6];
      const status = String(row[7] || '').trim();
      const note = String(row[9] || '').trim();

      if (!itemName || !type || status !== '啟用' || amount <= 0) {
        continue;
      }

      if (!shouldPostRecurringItem(cycle, billingSpec, year, month)) {
        continue;
      }

      const dedupKey = buildRecurringDedupKey(type, itemName);
      if (existingKeys.has(dedupKey)) {
        skippedCount++;
        continue;
      }

      const fxRate = currency === 'USD' ? usdRate : 1;
      let cycleTag = '';
      if (cycle === '年繳') cycleTag = '[年繳到期] ';
      else if (cycle === '特定月份') cycleTag = '[特定月份] ';
      else if (cycle === '一次性') cycleTag = '[一次性排程] ';

      toInsert.push({
        date: entryDate,
        type,
        category,
        itemName,
        amount,
        currency,
        fxRate,
        source: '自動入帳',
        note: `${cycleTag}${note}`.trim(),
      });
      existingKeys.add(dedupKey);

      if (cycle === '一次性') {
        const suffix = `[已一次性入帳 ${targetYearMonth}]`;
        const updatedNote = note ? `${note} ${suffix}` : suffix;
        oneTimeRowsToDeactivate.push({ rowIndex: sheetRowIndex, updatedNote });
      }
    }
  }

  const insertedCount = appendCashFlowRows(logSheet, toInsert);

  // 一次性項目入帳後自動將狀態設為停用，確保不重複入帳
  for (const item of oneTimeRowsToDeactivate) {
    configSheet.getRange(item.rowIndex, 8).setValue('停用');
    configSheet.getRange(item.rowIndex, 10).setValue(item.updatedNote);
  }

  SpreadsheetApp.flush();

  Logger.log(
    `[runMonthlyRecurring] ${targetYearMonth}: inserted=${insertedCount}, skipped=${skippedCount}, deactivatedOneTime=${oneTimeRowsToDeactivate.length}, usdRate=${usdRate}`
  );
  return {
    yearMonth: targetYearMonth,
    insertedCount,
    skippedCount,
    deactivatedOneTimeCount: oneTimeRowsToDeactivate.length,
    fxRate: usdRate,
  };
}

/**
 * 每日排程檢查器：判斷今天是否為當月最後一天（精準支援 28/29/30/31 日月份）
 * 若是月底則自動執行淨資產快照。
 */
function checkAndRunMonthEndSnapshot(): void {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (tomorrow.getDate() !== 1) {
    Logger.log(`[checkAndRunMonthEndSnapshot] 今日 (${formatDateYmd(now)}) 非月底，略過快照。`);
    return;
  }
  runMonthEndNetWorthSnapshot(now);
}

/**
 * 執行月底淨資產快照：彙總 Assets_Liabilities 與當月 CashFlow_Log，寫入 NetWorth_History
 * - 寫入純數值（非公式），確保歷史快照永久鎖定
 * - 若 NetWorth_History 已有同月份 (YYYY-MM) 紀錄則覆蓋更新，避免重複
 */
function runMonthEndNetWorthSnapshot(targetDate?: Date): {
  yearMonth: string;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  updated: boolean;
} {
  const ss = getActiveSpreadsheetOrThrow();
  const assetSheet = getSheetOrThrow(ss, SHEET_NAMES.ASSETS_LIABILITIES);
  const logSheet = getSheetOrThrow(ss, SHEET_NAMES.CASHFLOW_LOG);
  const sinkingSheet = getSheetOrThrow(ss, SHEET_NAMES.SINKING_FUND);
  const historySheet = getSheetOrThrow(ss, SHEET_NAMES.NETWORTH_HISTORY);

  SpreadsheetApp.flush();

  const snapshotDate = targetDate || new Date();
  const yearMonth = formatYearMonth(snapshotDate);

  // 1. 彙總資產負債存量（讀取 J 欄折合台幣市值）
  let totalAssets = 0;
  let totalLiabilities = 0;
  let highLiquidityAssets = 0;
  let investmentAssets = 0;
  let insuranceAssets = 0;

  const lastAssetRow = findLastDataRowInColumn(assetSheet, 5);
  if (lastAssetRow >= 2) {
    const assetRows = assetSheet.getRange(2, 1, lastAssetRow - 1, 10).getValues();
    for (const row of assetRows) {
      const majorType = String(row[1] || '').trim();
      const subCat = String(row[2] || '').trim();
      const liquidity = String(row[3] || '').trim();
      const itemName = String(row[4] || '').trim();
      const twdValue = toSafeNumber(row[9], 0);

      if (!itemName || twdValue === 0) continue;

      if (majorType === '資產') {
        totalAssets += twdValue;
        if (liquidity === '高流動') {
          highLiquidityAssets += twdValue;
        }
        if (subCat === '台股' || subCat === '中信基金' || subCat === '結構性商品') {
          investmentAssets += twdValue;
        }
        if (subCat === '保單(保價金)') {
          insuranceAssets += twdValue;
        }
      } else if (majorType === '負債') {
        totalLiabilities += twdValue;
      }
    }
  }

  const netWorth = Math.round(totalAssets - totalLiabilities);

  // 2. 計算快照月份的現金流總收入、消費性總支出（含自訂月數攤提）與真實儲蓄率
  let monthlyIncome = 0;
  let monthlyFixedAndSubAndDaily = 0;
  const lastLogRow = findLastDataRowInColumn(logSheet, 1);
  if (lastLogRow >= 2) {
    const logRows = logSheet.getRange(2, 1, lastLogRow - 1, 8).getValues();
    for (const row of logRows) {
      const rowDate = row[0];
      const rowYm = rowDate instanceof Date ? formatYearMonth(rowDate) : String(row[1] || '').trim();
      if (rowYm !== yearMonth) continue;

      const type = String(row[2] || '').trim();
      const twdAmt = toSafeNumber(row[7], 0);
      if (type === CASHFLOW_TYPES.FIXED_INCOME || type === CASHFLOW_TYPES.OTHER_INCOME) {
        monthlyIncome += twdAmt;
      } else if (
        type === CASHFLOW_TYPES.FIXED_EXPENSE ||
        type === CASHFLOW_TYPES.SUBSCRIPTION ||
        type === CASHFLOW_TYPES.DAILY_EXPENSE
      ) {
        monthlyFixedAndSubAndDaily += twdAmt;
      }
    }
  }

  // 讀取 Annual_Sinking_Fund 第 6 欄 (F 欄：每月應提撥)
  let monthlySinkingFund = 0;
  const lastSinkingRow = findLastDataRowInColumn(sinkingSheet, 1);
  if (lastSinkingRow >= 2) {
    const sinkingValues = sinkingSheet.getRange(2, 6, lastSinkingRow - 1, 1).getValues();
    for (const r of sinkingValues) {
      monthlySinkingFund += toSafeNumber(r[0], 0);
    }
  }

  const totalConsumption = Math.round(monthlyFixedAndSubAndDaily + monthlySinkingFund);
  const savingsRate =
    monthlyIncome > 0 ? Math.round(((monthlyIncome - totalConsumption) / monthlyIncome) * 10000) / 10000 : 0;

  const snapshotRow = [
    snapshotDate,
    yearMonth,
    Math.round(totalAssets),
    Math.round(totalLiabilities),
    netWorth,
    Math.round(highLiquidityAssets),
    Math.round(investmentAssets),
    Math.round(insuranceAssets),
    Math.round(monthlyIncome),
    totalConsumption,
    savingsRate,
    `自動快照 @ ${Utilities.formatDate(snapshotDate, APP_TIMEZONE, 'yyyy-MM-dd HH:mm')}`,
  ];

  // 3. 若同月份已存在則覆蓋更新，否則新增於末列
  const lastHistRow = findLastDataRowInColumn(historySheet, 2);
  let targetRowIndex = lastHistRow + 1;
  let updated = false;

  if (lastHistRow >= 2) {
    const ymValues = historySheet.getRange(2, 2, lastHistRow - 1, 1).getValues();
    for (let i = 0; i < ymValues.length; i++) {
      if (String(ymValues[i][0]).trim() === yearMonth) {
        targetRowIndex = i + 2;
        updated = true;
        break;
      }
    }
  }

  historySheet.getRange(targetRowIndex, 1, 1, snapshotRow.length).setValues([snapshotRow]);
  historySheet.getRange(targetRowIndex, 1).setNumberFormat('yyyy-mm-dd');
  historySheet.getRange(targetRowIndex, 3, 1, 8).setNumberFormat('#,##0');
  historySheet.getRange(targetRowIndex, 11).setNumberFormat('0.0%');

  Logger.log(
    `[runMonthEndNetWorthSnapshot] ${yearMonth} (${updated ? 'updated' : 'inserted'}): netWorth=${netWorth}`
  );
  return {
    yearMonth,
    totalAssets: Math.round(totalAssets),
    totalLiabilities: Math.round(totalLiabilities),
    netWorth,
    updated,
  };
}

/**
 * 安裝（或重設）所有排程觸發器，並自動清除舊的重複觸發器
 */
function installTriggers(): void {
  removeManagedTriggers();

  ScriptApp.newTrigger(TRIGGER_HANDLERS.MONTHLY_RECURRING)
    .timeBased()
    .onMonthDay(1)
    .atHour(8)
    .inTimezone(APP_TIMEZONE)
    .create();

  ScriptApp.newTrigger(TRIGGER_HANDLERS.MONTH_END_CHECK)
    .timeBased()
    .everyDays(1)
    .atHour(23)
    .inTimezone(APP_TIMEZONE)
    .create();

  const msg =
    '已成功安裝 2 組排程觸發器：\n' +
    '1. 每月 1 號 08:00：常態性與排程收支自動入帳 (runMonthlyRecurring)\n' +
    '2. 每月月底 23:00：淨資產自動快照 (checkAndRunMonthEndSnapshot)';
  safeToast('排程觸發器安裝成功！', '自動化排程', 6);
  const ui = getUiOrNull();
  if (ui) {
    ui.alert('排程觸發器已安裝', msg, ui.ButtonSet.OK);
  }
}

/**
 * 清除本系統管理的排程觸發器
 */
function removeManagedTriggers(): number {
  const managed = new Set<string>([
    TRIGGER_HANDLERS.MONTHLY_RECURRING,
    TRIGGER_HANDLERS.MONTH_END_CHECK,
  ]);
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (const trigger of triggers) {
    if (managed.has(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  }
  return removed;
}

/**
 * 檢視目前專案已安裝的觸發器清單
 */
function listInstalledTriggers(): void {
  const triggers = ScriptApp.getProjectTriggers();
  const lines =
    triggers.length === 0
      ? ['目前尚未安裝任何排程觸發器。請點擊選單「5. 安裝 / 重設每月排程觸發器」。']
      : triggers.map(
          (t, idx) =>
            `${idx + 1}. 函式：${t.getHandlerFunction()} | 類型：${t.getEventType()} | 來源：${t.getTriggerSource()}`
        );

  const msg = lines.join('\n');
  Logger.log(msg);
  const ui = getUiOrNull();
  if (ui) {
    ui.alert('目前排程觸發器狀態', msg, ui.ButtonSet.OK);
  }
}
