/**
 * 判斷常態項目在指定年月是否應自動入帳，支援月繳 / 年繳 / 特定月份 / 一次性
 */
export function shouldPostRecurringItem(
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
    if (!Number.isNaN(singleMonth) && singleMonth >= 1 && singleMonth <= 12) {
      return singleMonth === targetMonth;
    }
    return false;
  }

  if (normalizedCycle === '年繳' || normalizedCycle === '特定月份') {
    if (!rawSpec) {
      return false;
    }
    const tokens = rawSpec.split(/[,、，/\s]+/).filter(Boolean);
    for (const token of tokens) {
      const m = Number(token);
      if (!Number.isNaN(m) && m >= 1 && m <= 12 && m === targetMonth) {
        return true;
      }
    }
    return false;
  }

  return false;
}

export function buildRecurringDedupKey(type: string, itemName: string): string {
  return `${type.trim()}||${itemName.trim()}`;
}

export function buildMonthlyDedupKey(
  yearMonth: string,
  type: string,
  itemName: string,
  ledgerId = 'default'
): string {
  const base = `${yearMonth.trim()}||${buildRecurringDedupKey(type, itemName)}`;
  const lid = String(ledgerId || 'default').trim() || 'default';
  return lid === 'default' ? base : `${lid}||${base}`;
}

/**
 * M5 (v1.8.12): dedup key of an auto-posted entry — one entry per recurring item per month, so two items that
 * share a name and type are both posted. Rows posted before v1.8.12 carry the legacy name-based key
 * (`buildMonthlyDedupKey`) and are still honoured when deciding what has already been posted.
 */
export function buildRecurringItemMonthKey(recurringItemId: string, yearMonth: string): string {
  return `rec:${String(recurringItemId).trim()}:${yearMonth.trim()}`;
}

/** v1.13.1: posting day of a recurring item (day of month the auto-posted entry is dated). */
export const DEFAULT_RECURRING_POST_DAY = 1;

/**
 * v1.13.1: normalizes a stored / received posting day to an integer 1..31. Anything missing or invalid means the
 * pre-v1.13.1 behaviour (the 1st).
 */
export function normalizeRecurringPostDay(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_RECURRING_POST_DAY;
  const day = Math.round(n);
  return day >= 1 && day <= 31 ? day : DEFAULT_RECURRING_POST_DAY;
}

/**
 * v1.13.1: the date (YYYY-MM-DD) an auto-posted entry of `yearMonth` gets for a posting day. A day the month does
 * not have (e.g. 31 in November, 29-31 in February) becomes the month's last day.
 */
export function resolveRecurringEntryDate(yearMonth: string, postDay: unknown): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = Math.min(normalizeRecurringPostDay(postDay), lastDay);
  return `${yearMonth}-${String(day).padStart(2, '0')}`;
}
