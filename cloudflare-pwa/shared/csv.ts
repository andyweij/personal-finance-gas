import { DEFAULT_USD_TWD_RATE } from './constants';
import type { CashFlowLog } from './types';
import { validateCashFlowInput, type ValidatedCashFlowInput } from './validation';

function escapeCsvCell(val: unknown): string {
  const str = val === null || val === undefined ? '' : String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
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
 * 解析由原 Google Sheets CashFlow_Log 匯出的 CSV（支援中英文欄位順序）
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
    const dateRaw = String(cols[0] || '').trim().replace(/\//g, '-');
    if (!dateRaw) continue;

    // 正規化如 2026-1-5 -> 2026-01-05
    const dateParts = dateRaw.split('-');
    const normalizedDate =
      dateParts.length === 3
        ? `${dateParts[0]}-${dateParts[1].padStart(2, '0')}-${dateParts[2].padStart(2, '0')}`
        : dateRaw;

    const amountClean = String(cols[5] || '').replace(/,/g, '').trim();
    const fxClean = String(cols[8] || '').replace(/,/g, '').trim();

    const validated = validateCashFlowInput(
      {
        date: normalizedDate,
        type: cols[2] || '',
        category: cols[3] || '其他',
        itemName: cols[4] || cols[3] || '項目',
        amount: Number(amountClean),
        currency: cols[6] || 'TWD',
        fxRate: fxClean ? Number(fxClean) : undefined,
        source: cols[9] || '匯入',
        note: cols[10] || '',
      },
      defaultUsdTwdRate
    );
    results.push(validated);
  }

  return results;
}
