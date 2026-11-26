import { DEFAULT_USD_TWD_RATE } from './constants';
import type { CashFlowLog, NetWorthHistory } from './types';
import {
  validateAssetInput,
  validateCashFlowInput,
  validateRecurringInput,
  validateSinkingInput,
  type ValidatedCashFlowInput,
} from './validation';

export type GoogleSheetCsvKind = 'cashflow' | 'recurring' | 'sinking' | 'asset' | 'networth';

// v1.8.15: shared escaping with CSV formula-injection protection (= + - @ prefixed with ')
import { escapeCsvCell } from './format';
export { escapeCsvCell };

function cleanNumber(raw: unknown, fallback = 0): number {
  const s = String(raw ?? '')
    .replace(/[,$\s]|NT\$|US\$/gi, '')
    .trim();
  if (!s) return fallback;
  const n = Number(s);
  return Number.isNaN(n) || !Number.isFinite(n) ? fallback : n;
}

function normalizeYmd(raw: unknown): string {
  const dateRaw = String(raw ?? '').trim().replace(/\//g, '-');
  const parts = dateRaw.split('-');
  if (parts.length === 3) {
    return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
  }
  return dateRaw;
}

export function parseCsvRows(csvText: string): string[][] {
  const cleaned = csvText.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inQuotes) {
      if (ch === '"') {
        if (cleaned[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') {
      if (cleaned[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function detectGoogleSheetCsvKind(csvText: string): GoogleSheetCsvKind | null {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) return null;
  const headerLine = rows[0].map((c) => c.trim()).join('|');

  if (headerLine.includes('入帳/扣款週期') || headerLine.includes('月均換算')) {
    return 'recurring';
  }
  if (headerLine.includes('分攤月數') || headerLine.includes('每月應提撥')) {
    return 'sinking';
  }
  if (headerLine.includes('更新方式') && (headerLine.includes('流動性') || headerLine.includes('細分類別'))) {
    return 'asset';
  }
  if (headerLine.includes('快照日期') && headerLine.includes('淨資產')) {
    return 'networth';
  }
  if (headerLine.includes('日期') && headerLine.includes('收支類型') && headerLine.includes('原幣金額')) {
    return 'cashflow';
  }
  return null;
}

export function exportCashFlowCsv(logs: CashFlowLog[]): string {
  const headers = [
    '日期',
    '年月',
    '收支類型',
    '分類',
    '項目名稱',
    '原幣金額',
    '幣別',
    '台幣金額(TWD)',
    '入帳匯率',
    '來源',
    '備註',
  ];
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const l of logs) {
    if (l.deletedAt) continue;
    lines.push(
      [
        l.date,
        l.yearMonth,
        l.type,
        l.category,
        l.itemName,
        l.amount,
        l.currency,
        l.twdAmount,
        l.fxRate,
        l.source,
        l.note,
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }
  return `\uFEFF${lines.join('\n')}`;
}

/**
 * 1. 解析原 Google Sheets CashFlow_Log CSV
 */
export function parseCashFlowCsv(
  csvText: string,
  defaultUsdTwdRate = DEFAULT_USD_TWD_RATE
): ValidatedCashFlowInput[] {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return [];

  const results: ValidatedCashFlowInput[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    const normalizedDate = normalizeYmd(cols[0]);
    if (!normalizedDate) continue;

    const amount = cleanNumber(cols[5], NaN);
    if (Number.isNaN(amount) || amount <= 0) continue;
    const fxClean = cleanNumber(cols[8], NaN);

    results.push(
      validateCashFlowInput(
        {
          date: normalizedDate,
          type: cols[2] || '',
          category: cols[3] || '其他',
          itemName: cols[4] || cols[3] || '項目',
          amount,
          currency: cols[6] || 'TWD',
          fxRate: !Number.isNaN(fxClean) && fxClean > 0 ? fxClean : undefined,
          source: cols[9] || '匯入',
          note: cols[10] || '',
        },
        defaultUsdTwdRate
      )
    );
  }
  return results;
}

/**
 * 2. 解析原 Google Sheets Recurring_Config CSV（固定收支與訂閱）
 */
export function parseRecurringCsv(csvText: string) {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return [];

  const results = [];
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    const itemName = String(cols[0] || '').trim();
    if (!itemName) continue;
    const amount = cleanNumber(cols[3], NaN);
    if (Number.isNaN(amount) || amount <= 0) continue;

    results.push(
      validateRecurringInput({
        itemName,
        category: cols[1] || '其他',
        type: cols[2] || '訂閱扣款',
        amount,
        currency: cols[4] || 'TWD',
        cycle: cols[5] || '月繳',
        billingSpec: cols[6] || '',
        status: cols[7] || '啟用',
        note: cols[9] || '',
      })
    );
  }
  return results;
}

/**
 * 3. 解析原 Google Sheets Annual_Sinking_Fund CSV（不定期稅金與大額攤提）
 */
export function parseSinkingFundCsv(csvText: string) {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return [];

  const results = [];
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    const itemName = String(cols[0] || '').trim();
    if (!itemName) continue;
    const totalAmount = cleanNumber(cols[2], NaN);
    if (Number.isNaN(totalAmount) || totalAmount <= 0) continue;

    // 處理原試算表格式如 "12 個月"
    const monthsDigits = String(cols[3] || '').replace(/[^\d]/g, '');
    const months = monthsDigits ? Number(monthsDigits) : 12;

    results.push(
      validateSinkingInput({
        itemName,
        category: cols[1] || '其他',
        totalAmount,
        months,
        dueNote: cols[4] || '',
        status: cols[6] || '啟用',
        note: cols[9] || '',
      })
    );
  }
  return results;
}

/**
 * 4. 解析原 Google Sheets Assets_Liabilities CSV（資產負債明細）
 */
export function parseAssetsCsv(csvText: string) {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return [];

  const results = [];
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    const itemName = String(cols[4] || '').trim();
    if (!itemName) continue;

    const quantityOrAmount = cleanNumber(cols[6], 0);
    const unitPriceRaw = cleanNumber(cols[8], NaN);
    const unitPrice = !Number.isNaN(unitPriceRaw) && unitPriceRaw >= 0 ? unitPriceRaw : 1;

    results.push(
      validateAssetInput({
        updateMode: cols[0] || '手動快照',
        majorType: cols[1] || '資產',
        subCategory: cols[2] || '其他資產',
        liquidity: cols[3] || '中流動',
        itemName,
        ticker: cols[5] || '',
        quantityOrAmount,
        currency: cols[7] || 'TWD',
        unitPrice,
        note: cols[10] || '',
      })
    );
  }
  return results;
}

/**
 * 5. 解析原 Google Sheets NetWorth_History CSV（淨資產歷史快照）
 */
export function parseNetWorthHistoryCsv(csvText: string): Array<Omit<NetWorthHistory, 'updatedAt'>> {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return [];

  const results: Array<Omit<NetWorthHistory, 'updatedAt'>> = [];
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    const yearMonth = String(cols[1] || '').trim();
    if (!/^\d{4}-\d{2}$/.test(yearMonth)) continue;

    const snapshotDate = normalizeYmd(cols[0]) || `${yearMonth}-28`;
    const rateRaw = String(cols[10] || '').trim();
    const savingsRate = rateRaw.endsWith('%')
      ? Math.round((cleanNumber(rateRaw.slice(0, -1), 0) / 100) * 10000) / 10000
      : cleanNumber(rateRaw, 0);

    results.push({
      yearMonth,
      snapshotDate,
      totalAssets: Math.round(cleanNumber(cols[2], 0)),
      totalLiabilities: Math.round(cleanNumber(cols[3], 0)),
      netWorth: Math.round(cleanNumber(cols[4], 0)),
      highLiquidityAssets: Math.round(cleanNumber(cols[5], 0)),
      investmentAssets: Math.round(cleanNumber(cols[6], 0)),
      insuranceAssets: Math.round(cleanNumber(cols[7], 0)),
      monthlyIncome: Math.round(cleanNumber(cols[8], 0)),
      monthlyConsumption: Math.round(cleanNumber(cols[9], 0)),
      savingsRate,
      note: String(cols[11] || '').trim(),
    });
  }
  return results;
}
