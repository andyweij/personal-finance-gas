/**
 * 共用工具函式：日期處理、匯率讀取、週期規則判斷、安全寫入流水帳、介面提示
 */

function getActiveSpreadsheetOrThrow(): GoogleAppsScript.Spreadsheet.Spreadsheet {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('找不到綁定的 Google Sheet，請確認此 Apps Script 已正確綁定至試算表。');
  }
  return ss;
}

function getSheetOrThrow(
  ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
  sheetName: string
): GoogleAppsScript.Spreadsheet.Sheet {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error(`找不到分頁「${sheetName}」，請先執行 setupSpreadsheet() 初始化試算表。`);
  }
  return sheet;
}

/**
 * 將 Date 物件格式化為 yyyy-mm-dd（Asia/Taipei）
 */
function formatDateYmd(date: Date): string {
  return Utilities.formatDate(date, APP_TIMEZONE, 'yyyy-MM-dd');
}

/**
 * 將 Date 物件格式化為 yyyy-mm（Asia/Taipei）
 */
function formatYearMonth(date: Date): string {
  return Utilities.formatDate(date, APP_TIMEZONE, 'yyyy-MM');
}

/**
 * 解析 YYYY-MM-DD 字串為本地 Date（避免時區偏移導致日期少一天）
 */
function parseLocalDate(ymd: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!match) {
    throw new Error(`日期格式錯誤：${ymd}（應為 YYYY-MM-DD）`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day, 12, 0, 0);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    throw new Error(`無效的日期：${ymd}`);
  }
  return parsed;
}

/**
 * 讀取 Dashboard!F2 的即時 USD/TWD 匯率，若暫時無法載入則回退預設值
 */
function getLiveUsdTwdRate(ss: GoogleAppsScript.Spreadsheet.Spreadsheet): number {
  const dashboard = ss.getSheetByName(SHEET_NAMES.DASHBOARD);
  if (!dashboard) {
    return DEFAULT_USD_TWD_RATE;
  }
  const raw = dashboard.getRange('F2').getValue();
  const rate = Number(raw);
  if (!isNaN(rate) && isFinite(rate) && rate > 10 && rate < 100) {
    return Math.round(rate * 10000) / 10000;
  }
  return DEFAULT_USD_TWD_RATE;
}

/**
 * 判斷 Recurring_Config 的某列在指定年月 (targetYear, targetMonth) 是否應該自動入帳
 * 支援週期：
 * - 月繳：每月皆入帳
 * - 年繳：billingSpec 填月份（1-12）時於該月入帳
 * - 特定月份：billingSpec 可填逗號/頓號/斜線分隔月份，例如 "3,6,9,12" 或 "1、7"
 * - 一次性：billingSpec 留空（當月立即入帳）、填單一月份（如 "12"）或指定年月（如 "2026-12"），入帳後會自動改為停用
 */
function shouldPostRecurringItem(
  cycle: string,
  billingSpec: unknown,
  targetYear: number,
  targetMonth: number
): boolean {
  const normalizedCycle = String(cycle || '月繳').trim();
  const rawSpec = String(billingSpec === null || billingSpec === undefined ? '' : billingSpec).trim();

  if (normalizedCycle === '月繳') {
    return true;
  }

  if (normalizedCycle === '一次性') {
    if (!rawSpec) {
      return true;
    }
    const ymMatch = /^(\d{4})[-/](\d{1,2})$/.exec(rawSpec);
    if (ymMatch) {
      return Number(ymMatch[1]) === targetYear && Number(ymMatch[2]) === targetMonth;
    }
    const singleMonth = Number(rawSpec);
    if (!isNaN(singleMonth) && singleMonth >= 1 && singleMonth <= 12) {
      return singleMonth === targetMonth;
    }
    return false;
  }

  // 年繳 / 特定月份：支援單月或逗號/頓號/空白/斜線分隔多月
  if (normalizedCycle === '年繳' || normalizedCycle === '特定月份') {
    if (!rawSpec) {
      return false;
    }
    const tokens = rawSpec.split(/[,、，/\s]+/).filter(Boolean);
    for (const token of tokens) {
      const m = Number(token);
      if (!isNaN(m) && m >= 1 && m <= 12 && m === targetMonth) {
        return true;
      }
    }
    return false;
  }

  return false;
}

/**
 * 找出指定欄位中最後一筆非空白資料列（避免受其他欄位 ARRAYFORMULA 干擾）
 */
function findLastDataRowInColumn(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  columnIndex: number
): number {
  const maxRows = sheet.getLastRow();
  if (maxRows <= 1) {
    return 1;
  }
  const values = sheet.getRange(1, columnIndex, maxRows, 1).getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    const val = values[i][0];
    if (val !== '' && val !== null && val !== undefined) {
      return i + 1;
    }
  }
  return 1;
}

/**
 * 安全寫入一筆或多筆紀錄至 CashFlow_Log
 * 僅寫入非公式欄位（A, C:G, I:K），保留 B 欄（年月）與 H 欄（台幣金額）由表頭 ARRAYFORMULA 自動計算，
 * 避免寫入空白字串覆蓋陣列公式導致 #REF!。
 */
function appendCashFlowRows(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  entries: CashFlowInput[]
): number {
  if (entries.length === 0) {
    return 0;
  }

  const startRow = findLastDataRowInColumn(sheet, 1) + 1;
  const neededRows = startRow + entries.length - 1;
  if (sheet.getMaxRows() < neededRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), neededRows - sheet.getMaxRows() + 50);
  }

  const colAValues: Date[][] = [];
  const colCtoGValues: Array<[string, string, string, number, string]> = [];
  const colItoKValues: Array<[number, string, string]> = [];

  for (const entry of entries) {
    colAValues.push([entry.date]);
    colCtoGValues.push([
      entry.type,
      entry.category,
      entry.itemName,
      entry.amount,
      entry.currency,
    ]);
    colItoKValues.push([entry.fxRate, entry.source, entry.note]);
  }

  const count = entries.length;
  sheet.getRange(startRow, 1, count, 1).setValues(colAValues).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(startRow, 3, count, 5).setValues(colCtoGValues);
  sheet.getRange(startRow, 6, count, 1).setNumberFormat('#,##0.00');
  sheet.getRange(startRow, 9, count, 3).setValues(colItoKValues);
  sheet.getRange(startRow, 9, count, 1).setNumberFormat('#,##0.0000');

  return count;
}

/**
 * 嘗試在試算表右下角顯示 Toast 訊息（在無 UI 的 Trigger 背景執行時自動靜默）
 */
function safeToast(message: string, title = '個人財務系統', timeoutSeconds = 5): void {
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(message, title, timeoutSeconds);
  } catch (_err) {
    // Trigger 背景執行環境無 UI，忽略即可
  }
}

/**
 * 嘗試取得 Spreadsheet UI（背景排程無 UI 時回傳 null）
 */
function getUiOrNull(): GoogleAppsScript.Base.Ui | null {
  try {
    return SpreadsheetApp.getUi();
  } catch (_err) {
    return null;
  }
}

/**
 * 安全轉換數值
 */
function toSafeNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return isNaN(num) || !isFinite(num) ? fallback : num;
}

/**
 * 產生常態性項目去重鍵值（防止同月份重複入帳）
 */
function buildRecurringDedupKey(type: string, itemName: string): string {
  return `${type.trim()}||${itemName.trim()}`;
}
