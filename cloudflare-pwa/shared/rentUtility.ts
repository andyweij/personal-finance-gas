import type { RentUtilityRecord, RentUtilityRents } from './types';

export const UTILITY_SUB_METER_MOD = 10000;   // 6F 與 5F A/B/C 四位數電表（滿 10,000 歸零）
export const UTILITY_MAIN_METER_MOD = 100000; // 總表五位數電表（滿 100,000 歸零）

export const DEFAULT_UTILITY_RENTS: RentUtilityRents = {
  rent6F: 0,
  rentA: 0,
  rentB: 0,
  rentC: 0,
  updatedAt: '',
};

export interface ChainedUtilityRecord extends RentUtilityRecord {
  prevTotal: number;
  prev6F: number;
  prevA: number;
  prevB: number;
  prevC: number;
}

export interface UtilityComputeInput {
  prevTotal: number;
  curTotal: number;
  prev6F: number;
  cur6F: number;
  totalElec: number;
  totalWater: number;
  f6People: number;
  f5People: number;
  prevA: number;
  curA: number;
  prevB: number;
  curB: number;
  prevC: number;
  curC: number;
}

export interface UtilityComputeResult {
  totalKwh: number;
  f6Kwh: number;
  f5Kwh: number;
  avgRate: number;
  f6Elec: number;
  f6Water: number;
  f6Total: number;
  f5Elec: number;
  f5Water: number;
  f5Total: number;
  f5Rate: number;
  aKwh: number;
  bKwh: number;
  cKwh: number;
  pubKwh: number;
  pubEachKwh: number;
  aPriv: number;
  bPriv: number;
  cPriv: number;
  pubEachElec: number;
  waterEach: number;
  aTotal: number;
  bTotal: number;
  cTotal: number;
  checkDiff: number;
}

export interface UtilityRecordInputPayload {
  period: string;
  isBaseline?: boolean;
  curTotal: number;
  cur6F: number;
  totalElec?: number;
  totalWater?: number;
  f6People?: number;
  f5People?: number;
  curA: number;
  curB: number;
  curC: number;
  prevTotal?: number;
  prev6F?: number;
  prevA?: number;
  prevB?: number;
  prevC?: number;
}

export function meterDiffUtility(cur: number, prev: number, mod: number): number {
  return (((cur - prev) % mod) + mod) % mod;
}

export function didMeterRollover(cur: number, prev: number, mod: number): boolean {
  return (((cur % mod) + mod) % mod) < (((prev % mod) + mod) % mod);
}

export function nextUtilityPeriodCode(code: string): string {
  const s = String(code || '').trim();
  if (!/^\d{5}$/.test(s)) return '';
  let y = parseInt(s.slice(0, 3), 10);
  let m = parseInt(s.slice(3, 5), 10);
  m += 2;
  if (m > 12) {
    m -= 12;
    y += 1;
  }
  return `${y}${String(m).padStart(2, '0')}`;
}

export function sortUtilityRecords(records: RentUtilityRecord[]): RentUtilityRecord[] {
  return records
    .filter((r) => !r.deletedAt)
    .slice()
    .sort((a, b) => {
      if (a.isBaseline !== b.isBaseline) return a.isBaseline ? -1 : 1;
      return a.period.localeCompare(b.period, undefined, { numeric: true });
    });
}

/**
 * 依期別順序自動將上一期的 cur* 串接為下一期的 prev*，確保編輯/刪除歷史紀錄後自動連動
 */
export function chainUtilityRecords(records: RentUtilityRecord[]): ChainedUtilityRecord[] {
  const sorted = sortUtilityRecords(records);
  const result: ChainedUtilityRecord[] = [];
  let prev: RentUtilityRecord | null = null;

  for (const rec of sorted) {
    result.push({
      ...rec,
      prevTotal: prev ? prev.curTotal : rec.curTotal,
      prev6F: prev ? prev.cur6F : rec.cur6F,
      prevA: prev ? prev.curA : rec.curA,
      prevB: prev ? prev.curB : rec.curB,
      prevC: prev ? prev.curC : rec.curC,
    });
    prev = rec;
  }
  return result;
}

export function computeUtilityBill(d: UtilityComputeInput): UtilityComputeResult {
  const totalKwh = meterDiffUtility(d.curTotal, d.prevTotal, UTILITY_MAIN_METER_MOD);
  const f6Kwh = meterDiffUtility(d.cur6F, d.prev6F, UTILITY_SUB_METER_MOD);
  const f5Kwh = totalKwh - f6Kwh;
  const avgRate = totalKwh > 0 ? d.totalElec / totalKwh : Number.NaN;

  const f5Elec = totalKwh > 0 ? Math.round((d.totalElec * f5Kwh) / totalKwh) : Number.NaN;
  const f6Elec = totalKwh > 0 ? d.totalElec - f5Elec : Number.NaN;

  const totalPpl = d.f6People + d.f5People;
  let f5Water = 0;
  let f6Water = 0;
  if (d.f6People === 0) {
    f5Water = d.totalWater;
    f6Water = 0;
  } else if (totalPpl > 0) {
    const perPerson = Math.floor(d.totalWater / totalPpl);
    f5Water = perPerson * d.f5People;
    f6Water = d.totalWater - f5Water;
  }

  const f6Total = f6Elec + f6Water;
  const f5Total = f5Elec + f5Water;

  const aKwh = meterDiffUtility(d.curA, d.prevA, UTILITY_SUB_METER_MOD);
  const bKwh = meterDiffUtility(d.curB, d.prevB, UTILITY_SUB_METER_MOD);
  const cKwh = meterDiffUtility(d.curC, d.prevC, UTILITY_SUB_METER_MOD);
  const pubKwh = f5Kwh - (aKwh + bKwh + cKwh);

  const f5Rate = f5Kwh > 0 ? f5Elec / f5Kwh : Number.NaN;
  const pubEachKwh = d.f5People > 0 ? pubKwh / d.f5People : Number.NaN;
  const pubEachElec = pubEachKwh * f5Rate;
  const waterEach = d.f5People > 0 ? f5Water / d.f5People : Number.NaN;

  const aPriv = aKwh * f5Rate;
  const bPriv = bKwh * f5Rate;
  const cPriv = cKwh * f5Rate;

  const aTotal = aPriv + pubEachElec + waterEach;
  const bTotal = bPriv + pubEachElec + waterEach;
  const cTotal = cPriv + pubEachElec + waterEach;

  const checkDiff =
    Math.round(((f6Total + aTotal + bTotal + cTotal) - (d.totalElec + d.totalWater)) * 100) / 100;

  return {
    totalKwh, f6Kwh, f5Kwh, avgRate,
    f6Elec, f6Water, f6Total,
    f5Elec, f5Water, f5Total, f5Rate,
    aKwh, bKwh, cKwh, pubKwh, pubEachKwh,
    aPriv, bPriv, cPriv, pubEachElec, waterEach,
    aTotal, bTotal, cTotal, checkDiff,
  };
}

function fmtTW(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function buildUtilityLineMessages(
  period: string,
  d: UtilityComputeInput,
  r: UtilityComputeResult,
  rents: Pick<RentUtilityRents, 'rent6F' | 'rentA' | 'rentB' | 'rentC'>
): { line6F: string; line5F: string } {
  const line6F = [
    `【${period}期 6F水電費明細】`,
    `電表：${d.prev6F} → ${d.cur6F}（用電 ${r.f6Kwh} 度，平均 ${fmtTW(r.avgRate, 2)} 元/度）`,
    `電費：$${fmtTW(r.f6Elec)} ＋ 水費：$${fmtTW(r.f6Water)} ＝ 應繳 $${fmtTW(r.f6Total)}` +
      (rents.rent6F > 0
        ? `\n（含房租 $${fmtTW(rents.rent6F)}，共應匯款 $${fmtTW(r.f6Total + rents.rent6F)}）`
        : ''),
  ].join('\n');

  const line5F = [
    `【${period}期 5F水電費明細】`,
    `5F總用電 ${r.f5Kwh} 度（電費 $${fmtTW(r.f5Elec)}，平均 ${fmtTW(r.f5Rate, 2)} 元/度）`,
    `公用電 ${r.pubKwh} 度（每房 $${fmtTW(r.pubEachElec, 0)}），水費每房 $${fmtTW(r.waterEach, 0)}`,
    `• A房（${d.prevA}→${d.curA}，${r.aKwh}度）：$${fmtTW(Math.round(r.aTotal))}` +
      (rents.rentA > 0 ? `（含房租共 $${fmtTW(Math.round(r.aTotal) + rents.rentA)}）` : ''),
    `• B房（${d.prevB}→${d.curB}，${r.bKwh}度）：$${fmtTW(Math.round(r.bTotal))}` +
      (rents.rentB > 0 ? `（含房租共 $${fmtTW(Math.round(r.bTotal) + rents.rentB)}）` : ''),
    `• C房（${d.prevC}→${d.curC}，${r.cKwh}度）：$${fmtTW(Math.round(r.cTotal))}` +
      (rents.rentC > 0 ? `（含房租共 $${fmtTW(Math.round(r.cTotal) + rents.rentC)}）` : ''),
  ].join('\n');

  return { line6F, line5F };
}

export function buildUtilityCsv(chained: ChainedUtilityRecord[]): string {
  const headers = [
    '期別','總表上期','總表本期','總表用量','6F上期','6F本期','6F用量','5F用量',
    '總電費','總水費','6F人數','5F人數','6F電費','6F水費','6F應繳','5F電費','5F水費',
    'A上期','A本期','A用量','B上期','B本期','B用量','C上期','C本期','C用量',
    '5F公用度數','A應繳','B應繳','C應繳',
  ];
  const lines = [headers.join(',')];
  for (const rec of chained) {
    if (rec.isBaseline) continue;
    const r = computeUtilityBill(rec);
    lines.push([
      rec.period, rec.prevTotal, rec.curTotal, r.totalKwh,
      rec.prev6F, rec.cur6F, r.f6Kwh, r.f5Kwh,
      rec.totalElec, rec.totalWater, rec.f6People, rec.f5People,
      r.f6Elec, r.f6Water, r.f6Total, r.f5Elec, r.f5Water,
      rec.prevA, rec.curA, r.aKwh, rec.prevB, rec.curB, r.bKwh, rec.prevC, rec.curC, r.cKwh,
      r.pubKwh, r.aTotal.toFixed(2), r.bTotal.toFixed(2), r.cTotal.toFixed(2),
    ].join(','));
  }
  return '\uFEFF' + lines.join('\n');
}

export function validateUtilityRecordInput(input: UtilityRecordInputPayload): {
  period: string;
  isBaseline: boolean;
  curTotal: number;
  cur6F: number;
  totalElec: number;
  totalWater: number;
  f6People: number;
  f5People: number;
  curA: number;
  curB: number;
  curC: number;
} {
  const period = String(input.period || '').trim().slice(0, 20);
  if (!period) throw new Error('請填寫期別（例如 11511）。');

  const isBaseline = Boolean(input.isBaseline);
  const curTotal = Math.round(Number(input.curTotal));
  const cur6F = Math.round(Number(input.cur6F));
  const curA = Math.round(Number(input.curA));
  const curB = Math.round(Number(input.curB));
  const curC = Math.round(Number(input.curC));
  const totalElec = isBaseline ? 0 : Math.round(Number(input.totalElec ?? 0));
  const totalWater = isBaseline ? 0 : Math.round(Number(input.totalWater ?? 0));
  const f6People = Math.round(Number(input.f6People ?? 2));
  const f5People = Math.round(Number(input.f5People ?? 3));

  const nums = [curTotal, cur6F, curA, curB, curC, totalElec, totalWater, f6People, f5People];
  if (nums.some((n) => Number.isNaN(n) || !Number.isFinite(n) || n < 0)) {
    throw new Error('度數、帳單金額與人數皆必須為大於等於 0 的有效數字。');
  }
  if (!isBaseline && f5People < 1) {
    throw new Error('5F 人數至少需為 1 人。');
  }

  return {
    period,
    isBaseline,
    curTotal,
    cur6F,
    totalElec,
    totalWater,
    f6People,
    f5People,
    curA,
    curB,
    curC,
  };
}

export function validateUtilityRentsInput(input: Partial<RentUtilityRents>): {
  rent6F: number;
  rentA: number;
  rentB: number;
  rentC: number;
} {
  const rent6F = Math.max(0, Math.round(Number(input.rent6F ?? 0)));
  const rentA = Math.max(0, Math.round(Number(input.rentA ?? 0)));
  const rentB = Math.max(0, Math.round(Number(input.rentB ?? 0)));
  const rentC = Math.max(0, Math.round(Number(input.rentC ?? 0)));
  if ([rent6F, rentA, rentB, rentC].some((n) => Number.isNaN(n) || !Number.isFinite(n))) {
    throw new Error('固定月租金必須為有效數字。');
  }
  return { rent6F, rentA, rentB, rentC };
}
