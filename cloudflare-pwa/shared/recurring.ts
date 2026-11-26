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
