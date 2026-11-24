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

export function buildMonthlyDedupKey(yearMonth: string, type: string, itemName: string): string {
  return `${yearMonth.trim()}||${buildRecurringDedupKey(type, itemName)}`;
}
