/**
 * 5F & 6F 房租與水電費自動分攤模組 (rentUtility.ts)
 * 整合自 rent-utility-calculator，與個人現金流系統共用試算表、PIN 安全鎖與 Web App UI。
 *
 * 試算表結構（分頁：Rent_Utility）：
 * - Row 1：標題列
 * - Row 2：分區群組標題
 * - Row 3：欄位名稱（A~J 輸入區、K~T 6F/5F 整層計算、U~AC 5F A/B/C 分攤、AD 驗算差額）
 * - Row 4：起點表底（11409(起點)）
 * - Row 5+：各期紀錄（11411 起）
 * - AF3:AG7：固定月租金設定區（6F、5F-A、5F-B、5F-C）
 */

const UTILITY_SUB_METER_MOD = 10000;   // 6F 與 5F A/B/C 四位數分表（滿 10,000 歸零）
const UTILITY_MAIN_METER_MOD = 100000; // 整棟五位數總表（滿 100,000 歸零）
const UTILITY_BASELINE_ROW = 4;
const UTILITY_DATA_START_ROW = 5;

interface UtilityRecordDto {
  period: string;
  isBaseline?: boolean;
  prevTotal?: number;
  curTotal: number;
  prev6F?: number;
  cur6F: number;
  totalElec?: number;
  totalWater?: number;
  f6People?: number;
  f5People?: number;
  prevA?: number;
  curA: number;
  prevB?: number;
  curB: number;
  prevC?: number;
  curC: number;
}

interface UtilityRentsDto {
  rent6F: number;
  rentA: number;
  rentB: number;
  rentC: number;
}

interface UtilityComputeResult {
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

interface RentUtilityBundleDto {
  ok: boolean;
  records: UtilityRecordDto[];
  rents: UtilityRentsDto;
  sheetUrl: string;
  updatedAt: string;
}

const DEFAULT_UTILITY_BASELINE: [string, number, number, string, string, string, string, number, number, number] = [
  '11409(起點)', 52803, 4486, '', '', '', '', 8989, 5251, 6026,
];

const DEFAULT_UTILITY_HISTORY: Array<[string, number, number, number, number, number, number, number, number, number]> = [
  ['11411', 54090, 4778, 3828, 570, 0, 3, 9235, 5454, 6140],
  ['11501', 55048, 4998, 2328, 583, 2, 3, 9294, 5499, 6157],
  ['11503', 55893, 5173, 1974, 515, 2, 3, 9324, 5531, 6172],
  ['11505', 57232, 5682, 3896, 656, 2, 3, 9443, 5585, 6205],
  ['11507', 59341, 6607, 9201, 595, 2, 3, 9826, 5732, 6295],
  ['11509', 61261, 7762, 8214, 494, 2, 3, 105, 5852, 6374],
];

const DEFAULT_FUTURE_UTILITY_PERIODS: string[] = [
  '11511', '11601', '11603', '11605', '11607', '11609', '11611',
  '11701', '11703', '11705', '11707', '11709', '11711',
];

function isNumericCell(v: unknown): boolean {
  return v !== '' && v !== null && v !== undefined && !isNaN(Number(v));
}

/**
 * 計算電表度數差（支援五位數 100,000 與四位數 10,000 歸零自動換算）
 */
function meterDiffUtility(cur: number, prev: number, mod: number): number {
  return (((cur - prev) % mod) + mod) % mod;
}

/**
 * 推算下一期雙月期別（如 11509 → 11511、11511 → 11601）
 */
function nextUtilityPeriodCode(code: string): string {
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

/**
 * 純函式水電分攤計算核心（與原始 Excel 公式 100% 一致）
 */
function computeUtilityBill(d: {
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
}): UtilityComputeResult {
  const totalKwh = meterDiffUtility(d.curTotal, d.prevTotal, UTILITY_MAIN_METER_MOD);
  const f6Kwh = meterDiffUtility(d.cur6F, d.prev6F, UTILITY_SUB_METER_MOD);
  const f5Kwh = totalKwh - f6Kwh;
  const avgRate = totalKwh > 0 ? d.totalElec / totalKwh : NaN;

  const f5Elec = totalKwh > 0 ? Math.round((d.totalElec * f5Kwh) / totalKwh) : NaN;
  const f6Elec = totalKwh > 0 ? d.totalElec - f5Elec : NaN;

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

  const f5Rate = f5Kwh > 0 ? f5Elec / f5Kwh : NaN;
  const pubEachKwh = d.f5People > 0 ? pubKwh / d.f5People : NaN;
  const pubEachElec = pubEachKwh * f5Rate;
  const waterEach = d.f5People > 0 ? f5Water / d.f5People : NaN;

  const aPriv = aKwh * f5Rate;
  const bPriv = bKwh * f5Rate;
  const cPriv = cKwh * f5Rate;

  const aTotal = aPriv + pubEachElec + waterEach;
  const bTotal = bPriv + pubEachElec + waterEach;
  const cTotal = cPriv + pubEachElec + waterEach;

  const checkDiff = Math.round(((f6Total + aTotal + bTotal + cTotal) - (d.totalElec + d.totalWater)) * 100) / 100;

  return {
    totalKwh, f6Kwh, f5Kwh, avgRate,
    f6Elec, f6Water, f6Total,
    f5Elec, f5Water, f5Total, f5Rate,
    aKwh, bKwh, cKwh, pubKwh, pubEachKwh,
    aPriv, bPriv, cPriv, pubEachElec, waterEach,
    aTotal, bTotal, cTotal, checkDiff,
  };
}

/**
 * 產生指定列的 K~AD 欄（第 11~30 欄）自動計算公式陣列
 */
function buildUtilityRowFormulas(r: number): string[] {
  const prevR = r - 1;
  const guard = `OR(B${r}="",C${r}="",B${prevR}="")`;
  const guardBill = `OR(K${r}="",K${r}=0,D${r}="")`;
  const guard5f = `OR(H${r}="",I${r}="",J${r}="",R${r}="",M${r}="",M${r}=0)`;

  return [
    `=IF(${guard},"",MOD(B${r}-B${prevR},${UTILITY_MAIN_METER_MOD}))`,                                // K: 總表用量
    `=IF(${guard},"",MOD(C${r}-C${prevR},${UTILITY_SUB_METER_MOD}))`,                                 // L: 6F用量
    `=IF(${guard},"",K${r}-L${r})`,                                                                   // M: 5F用量
    `=IF(${guardBill},"",D${r}/K${r})`,                                                               // N: 平均每度電價
    `=IF(${guardBill},"",D${r}-R${r})`,                                                               // O: 6F電費
    `=IF(S${r}="","",E${r}-S${r})`,                                                                   // P: 6F水費
    `=IF(OR(O${r}="",P${r}=""),"",O${r}+P${r})`,                                                      // Q: 6F應繳總額
    `=IF(${guardBill},"",ROUND(D${r}*M${r}/K${r},0))`,                                                // R: 5F電費
    `=IF(OR(E${r}="",G${r}=""),"",IF(F${r}=0,E${r},INT(E${r}/(F${r}+G${r}))*G${r}))`,                 // S: 5F水費
    `=IF(OR(R${r}="",S${r}=""),"",R${r}+S${r})`,                                                      // T: 5F總計
    `=IF(OR(H${r}="",H${prevR}=""),"",MOD(H${r}-H${prevR},${UTILITY_SUB_METER_MOD}))`,                // U: A房用量
    `=IF(OR(I${r}="",I${prevR}=""),"",MOD(I${r}-I${prevR},${UTILITY_SUB_METER_MOD}))`,                // V: B房用量
    `=IF(OR(J${r}="",J${prevR}=""),"",MOD(J${r}-J${prevR},${UTILITY_SUB_METER_MOD}))`,                // W: C房用量
    `=IF(OR(M${r}="",U${r}="",V${r}="",W${r}=""),"",M${r}-(U${r}+V${r}+W${r}))`,                      // X: 5F公用度數
    `=IF(${guard5f},"",(X${r}/G${r})*(R${r}/M${r}))`,                                                 // Y: 每房公用電費
    `=IF(OR(S${r}="",G${r}="",G${r}=0),"",S${r}/G${r})`,                                              // Z: 每房水費
    `=IF(OR(Y${r}="",Z${r}=""),"",U${r}*(R${r}/M${r})+Y${r}+Z${r})`,                                  // AA: A房應繳
    `=IF(OR(Y${r}="",Z${r}=""),"",V${r}*(R${r}/M${r})+Y${r}+Z${r})`,                                  // AB: B房應繳
    `=IF(OR(Y${r}="",Z${r}=""),"",W${r}*(R${r}/M${r})+Y${r}+Z${r})`,                                  // AC: C房應繳
    `=IF(OR(Q${r}="",AA${r}=""),"",ROUND((Q${r}+AA${r}+AB${r}+AC${r})-(D${r}+E${r}),2))`,             // AD: 驗算差額
  ];
}

/**
 * 建置 Rent_Utility 分頁（含歷史抄表 11409~11509、預留未來期別與固定月租金設定區）
 */
function buildRentUtilitySheet(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  seedDefaultHistory = true
): void {
  // 確保至少有 33 欄 (A ~ AG)
  if (sheet.getMaxColumns() < 33) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), 33 - sheet.getMaxColumns());
  }

  // Row 1: 標題
  sheet
    .getRange('A1:AD1')
    .merge()
    .setValue('🏠 5F & 6F 水電費自動分攤總表（每次抄表填寫黃底欄位或透過 Web App 同步，其餘全自動計算）')
    .setBackground(THEME_COLORS.PRIMARY_DARK)
    .setFontColor(THEME_COLORS.WHITE)
    .setFontWeight('bold')
    .setFontSize(13)
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 34);

  // Row 2: 分區標頭
  sheet.getRange('A2:J2').merge().setValue('✏️ 步驟一：填入本期抄表度數與帳單金額（黃底區）').setBackground('#D97706').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.getRange('K2:T2').merge().setValue('🏢 自動計算：6F 與 5F 整層分攤結果').setBackground('#059669').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.getRange('U2:AC2').merge().setValue('🚪 自動計算：5F 各房（A / B / C）分攤結果').setBackground('#2563EB').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.getRange('AD2').setValue('✅ 驗算').setBackground('#475569').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.setRowHeight(2, 24);

  // Row 3: 欄位名稱
  const headers = [
    '期別\n(如11511)', '總表\n本期度數', '6F\n本期度數', '總電費\n(台電帳單)', '總水費\n(水費帳單)',
    '6F\n人數', '5F\n人數', '5F-A房\n本期度數', '5F-B房\n本期度數', '5F-C房\n本期度數',
    '總表\n本期用量', '6F\n本期用量', '5F\n本期用量', '平均\n每度電價', '6F\n電費',
    '6F\n水費', '⭐ 6F\n應繳總額', '5F\n電費', '5F\n水費', '5F\n總計',
    'A房\n用量', 'B房\n用量', 'C房\n用量', '5F公用\n度數', '每房公用\n電費',
    '每房\n水費', '⭐ A房\n應繳總額', '⭐ B房\n應繳總額', '⭐ C房\n應繳總額', '驗算差額\n(應為0)',
  ];
  sheet.getRange(3, 1, 1, 30).setValues([headers]).setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sheet.getRange('A3:J3').setBackground('#FEF3C7');
  sheet.getRange('K3:T3').setBackground('#D1FAE5');
  sheet.getRange('U3:AC3').setBackground('#DBEAFE');
  sheet.getRange('AD3').setBackground('#E2E8F0');
  sheet.setRowHeight(3, 34);

  // Row 4: 起點表底
  sheet.getRange(UTILITY_BASELINE_ROW, 1, 1, 10).setValues([DEFAULT_UTILITY_BASELINE]);
  sheet.getRange(UTILITY_BASELINE_ROW, 11).setValue('← 此列為起始表底，請勿刪除');
  sheet.getRange(UTILITY_BASELINE_ROW, 1, 1, 30).setBackground('#F3F4F6').setFontColor('#4B5563').setFontStyle('italic');
  sheet.getRange(UTILITY_BASELINE_ROW, 1).setNumberFormat('@').setHorizontalAlignment('center');

  // Row 5+: 歷史與未來期別列
  const rowsToCreate = seedDefaultHistory
    ? DEFAULT_UTILITY_HISTORY.length + DEFAULT_FUTURE_UTILITY_PERIODS.length
    : DEFAULT_FUTURE_UTILITY_PERIODS.length;

  const inputMatrix: Array<Array<string | number>> = [];
  const formulaMatrix: string[][] = [];

  for (let i = 0; i < rowsToCreate; i++) {
    const r = UTILITY_DATA_START_ROW + i;
    if (seedDefaultHistory && i < DEFAULT_UTILITY_HISTORY.length) {
      inputMatrix.push([...DEFAULT_UTILITY_HISTORY[i]]);
    } else {
      const idx = seedDefaultHistory ? i - DEFAULT_UTILITY_HISTORY.length : i;
      const p = DEFAULT_FUTURE_UTILITY_PERIODS[idx] || '';
      inputMatrix.push([p, '', '', '', '', 2, 3, '', '', '']);
    }
    formulaMatrix.push(buildUtilityRowFormulas(r));
  }

  sheet.getRange(UTILITY_DATA_START_ROW, 1, rowsToCreate, 1).setNumberFormat('@');
  sheet.getRange(UTILITY_DATA_START_ROW, 1, rowsToCreate, 10).setValues(inputMatrix).setBackground('#FFFBEB');
  sheet.getRange(UTILITY_DATA_START_ROW, 11, rowsToCreate, 20).setFormulas(formulaMatrix);

  // 數值格式與重點上色
  sheet.getRange(UTILITY_DATA_START_ROW, 1, rowsToCreate, 1).setHorizontalAlignment('center').setFontWeight('bold');
  sheet.getRange(UTILITY_DATA_START_ROW, 2, rowsToCreate, 4).setNumberFormat('#,##0');
  sheet.getRange(UTILITY_DATA_START_ROW, 6, rowsToCreate, 2).setNumberFormat('0').setHorizontalAlignment('center');
  sheet.getRange(UTILITY_DATA_START_ROW, 8, rowsToCreate, 6).setNumberFormat('#,##0');
  sheet.getRange(UTILITY_DATA_START_ROW, 14, rowsToCreate, 1).setNumberFormat('0.00');
  sheet.getRange(UTILITY_DATA_START_ROW, 15, rowsToCreate, 10).setNumberFormat('#,##0');
  sheet.getRange(UTILITY_DATA_START_ROW, 17, rowsToCreate, 1).setBackground('#ECFDF5').setFontColor('#065F46').setFontWeight('bold');
  sheet.getRange(UTILITY_DATA_START_ROW, 25, rowsToCreate, 1).setNumberFormat('#,##0.0');
  sheet.getRange(UTILITY_DATA_START_ROW, 26, rowsToCreate, 1).setNumberFormat('#,##0');
  sheet.getRange(UTILITY_DATA_START_ROW, 27, rowsToCreate, 3).setNumberFormat('#,##0.0').setBackground('#EFF6FF').setFontColor('#1E3A8A').setFontWeight('bold');
  sheet.getRange(UTILITY_DATA_START_ROW, 30, rowsToCreate, 1).setNumberFormat('0.00');

  // 格線
  sheet
    .getRange(3, 1, rowsToCreate + 2, 30)
    .setBorder(true, true, true, true, true, true, THEME_COLORS.BORDER, SpreadsheetApp.BorderStyle.SOLID);

  // 右側 AF3:AG7 固定月租金設定區（與 Web App 雙向同步）
  sheet.getRange('AF2:AG2').merge().setValue('💰 固定月租金設定').setBackground(THEME_COLORS.PRIMARY_ACCENT).setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.getRange('AF3:AG3').setValues([['房型 / 樓層', '月租金 (TWD)']]).setBackground(THEME_COLORS.SUBHEADER_BG).setFontWeight('bold').setHorizontalAlignment('center');
  sheet.getRange('AF4:AG7').setValues([
    ['6F 月租金', 0],
    ['5F A 房月租金', 0],
    ['5F B 房月租金', 0],
    ['5F C 房月租金', 0],
  ]);
  sheet.getRange('AG4:AG7').setNumberFormat('#,##0').setBackground('#FFFBEB');
  sheet.getRange('AF3:AG7').setBorder(true, true, true, true, true, true, THEME_COLORS.BORDER, SpreadsheetApp.BorderStyle.SOLID);

  // 欄寬與凍結
  for (let c = 1; c <= 30; c++) {
    sheet.setColumnWidth(c, c === 6 || c === 7 ? 68 : 92);
  }
  sheet.setColumnWidth(31, 24);
  sheet.setColumnWidth(32, 120);
  sheet.setColumnWidth(33, 110);
  sheet.setFrozenRows(4);
  sheet.setFrozenColumns(1);
}

/**
 * 確保 Rent_Utility 分頁存在（若舊試算表尚未建立，會自動非破壞性建置）
 */
function ensureRentUtilitySheet(
  ss: GoogleAppsScript.Spreadsheet.Spreadsheet
): GoogleAppsScript.Spreadsheet.Sheet {
  let sheet = ss.getSheetByName(SHEET_NAMES.RENT_UTILITY);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.RENT_UTILITY);
    buildRentUtilitySheet(sheet, true);
    SpreadsheetApp.flush();
  }
  return sheet;
}

/**
 * 選單專用：僅建立或重置 Rent_Utility（絕不動到其他 6 個財務分頁）
 */
function initRentUtilitySheetOnly(): void {
  const ss = getActiveSpreadsheetOrThrow();
  let sheet = ss.getSheetByName(SHEET_NAMES.RENT_UTILITY);
  const ui = getUiOrNull();

  if (sheet && ui) {
    const res = ui.alert(
      '重置確認',
      '「Rent_Utility」分頁已存在。要重置為初始 11409～11509 歷史紀錄與公式嗎？（其他 6 個財務分頁不會受影響）',
      ui.ButtonSet.YES_NO
    );
    if (res !== ui.Button.YES) return;
    resetSheetCompletely(sheet);
  } else if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.RENT_UTILITY);
  }

  buildRentUtilitySheet(sheet, true);
  ss.setActiveSheet(sheet);
  SpreadsheetApp.flush();
  safeToast('已建立「Rent_Utility」5F & 6F 水電費分攤分頁！', '水電費模組', 6);
}

/**
 * 讀取 Rent_Utility 分頁全部歷史抄表紀錄與固定月租金
 */
function readRentUtilityDataInternal(ss: GoogleAppsScript.Spreadsheet.Spreadsheet): RentUtilityBundleDto {
  const sheet = ensureRentUtilitySheet(ss);
  const lastRow = Math.max(sheet.getLastRow(), UTILITY_DATA_START_ROW);
  const values = sheet.getRange(UTILITY_BASELINE_ROW, 1, lastRow - UTILITY_BASELINE_ROW + 1, 10).getValues();

  const baseRow = values[0];
  const baseline: UtilityRecordDto = {
    period: String(baseRow[0] || '11409').replace(/\(起點\)/, '').trim() || '11409',
    isBaseline: true,
    curTotal: toSafeNumber(baseRow[1], 0),
    cur6F: toSafeNumber(baseRow[2], 0),
    curA: toSafeNumber(baseRow[7], 0),
    curB: toSafeNumber(baseRow[8], 0),
    curC: toSafeNumber(baseRow[9], 0),
  };

  const records: UtilityRecordDto[] = [baseline];
  let prev: UtilityRecordDto = baseline;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const period = String(row[0] || '').trim();
    if (!period || !isNumericCell(row[1])) continue;

    const rec: UtilityRecordDto = {
      period,
      prevTotal: prev.curTotal,
      curTotal: toSafeNumber(row[1], 0),
      prev6F: prev.cur6F,
      cur6F: toSafeNumber(row[2], 0),
      totalElec: toSafeNumber(row[3], 0),
      totalWater: toSafeNumber(row[4], 0),
      f6People: isNumericCell(row[5]) ? Number(row[5]) : 2,
      f5People: isNumericCell(row[6]) ? Number(row[6]) : 3,
      prevA: prev.curA,
      curA: toSafeNumber(row[7], 0),
      prevB: prev.curB,
      curB: toSafeNumber(row[8], 0),
      prevC: prev.curC,
      curC: toSafeNumber(row[9], 0),
    };
    records.push(rec);
    prev = rec;
  }

  let rents: UtilityRentsDto = { rent6F: 0, rentA: 0, rentB: 0, rentC: 0 };
  if (sheet.getMaxColumns() >= 33) {
    const rentVals = sheet.getRange('AG4:AG7').getValues();
    rents = {
      rent6F: toSafeNumber(rentVals[0][0], 0),
      rentA: toSafeNumber(rentVals[1][0], 0),
      rentB: toSafeNumber(rentVals[2][0], 0),
      rentC: toSafeNumber(rentVals[3][0], 0),
    };
  }

  return {
    ok: true,
    records,
    rents,
    sheetUrl: ss.getUrl(),
    updatedAt: new Date().toISOString(),
  };
}

function saveUtilityRentsInternal(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  rents?: Partial<UtilityRentsDto>
): void {
  if (!rents || sheet.getMaxColumns() < 33) return;
  if (isNumericCell(rents.rent6F)) sheet.getRange('AG4').setValue(Number(rents.rent6F));
  if (isNumericCell(rents.rentA)) sheet.getRange('AG5').setValue(Number(rents.rentA));
  if (isNumericCell(rents.rentB)) sheet.getRange('AG6').setValue(Number(rents.rentB));
  if (isNumericCell(rents.rentC)) sheet.getRange('AG7').setValue(Number(rents.rentC));
}

// ==================== Web App 受保護 API ====================

function getRentUtilityData(token?: string): RentUtilityBundleDto {
  assertAuthorized(token);
  const ss = getActiveSpreadsheetOrThrow();
  return readRentUtilityDataInternal(ss);
}

function saveRentUtilityRecord(
  token: string,
  rec: UtilityRecordDto,
  rents?: Partial<UtilityRentsDto>
): RentUtilityBundleDto {
  assertAuthorized(token);
  const periodStr = String(rec && rec.period ? rec.period : '').trim();
  if (!periodStr) throw new Error('請填寫期別（例如 11511）。');
  if (!isNumericCell(rec.curTotal) || !isNumericCell(rec.cur6F)) {
    throw new Error('請填寫有效的總表與 6F 度數。');
  }

  return withScriptLock(() => {
    const ss = getActiveSpreadsheetOrThrow();
    const sheet = ensureRentUtilitySheet(ss);
    const lastRow = Math.max(sheet.getLastRow(), UTILITY_DATA_START_ROW);
    const rangeVals = sheet.getRange(UTILITY_DATA_START_ROW, 1, lastRow - UTILITY_DATA_START_ROW + 1, 10).getValues();

    let targetRow = -1;
    let firstEmptyRow = -1;
    for (let i = 0; i < rangeVals.length; i++) {
      const rowNum = UTILITY_DATA_START_ROW + i;
      const p = String(rangeVals[i][0] || '').trim();
      const hasMeter = isNumericCell(rangeVals[i][1]);
      if (p === periodStr) {
        targetRow = rowNum;
        break;
      }
      if (!hasMeter && firstEmptyRow === -1) {
        firstEmptyRow = rowNum;
      }
    }

    if (targetRow === -1) {
      targetRow = firstEmptyRow !== -1 ? firstEmptyRow : lastRow + 1;
    }

    if (sheet.getMaxRows() < targetRow) {
      sheet.insertRowsAfter(sheet.getMaxRows(), targetRow - sheet.getMaxRows() + 10);
    }

    // 確保 K~AD 公式完整存在
    if (!sheet.getRange(targetRow, 11).getFormula()) {
      sheet.getRange(targetRow, 11, 1, 20).setFormulas([buildUtilityRowFormulas(targetRow)]);
    }

    // 若更新的是第一期（Row 5），可同步更新起點表底（Row 4）
    if (targetRow === UTILITY_DATA_START_ROW && isNumericCell(rec.prevTotal)) {
      sheet.getRange(UTILITY_BASELINE_ROW, 2).setValue(Number(rec.prevTotal));
      sheet.getRange(UTILITY_BASELINE_ROW, 3).setValue(Number(rec.prev6F));
      sheet.getRange(UTILITY_BASELINE_ROW, 8).setValue(Number(rec.prevA));
      sheet.getRange(UTILITY_BASELINE_ROW, 9).setValue(Number(rec.prevB));
      sheet.getRange(UTILITY_BASELINE_ROW, 10).setValue(Number(rec.prevC));
    }

    sheet.getRange(targetRow, 1).setNumberFormat('@');
    sheet.getRange(targetRow, 1, 1, 10).setValues([[
      periodStr,
      Number(rec.curTotal),
      Number(rec.cur6F),
      toSafeNumber(rec.totalElec, 0),
      toSafeNumber(rec.totalWater, 0),
      toSafeNumber(rec.f6People, 2),
      toSafeNumber(rec.f5People, 3),
      toSafeNumber(rec.curA, 0),
      toSafeNumber(rec.curB, 0),
      toSafeNumber(rec.curC, 0),
    ]]);

    if (rents) saveUtilityRentsInternal(sheet, rents);
    SpreadsheetApp.flush();
    return readRentUtilityDataInternal(ss);
  });
}

function deleteRentUtilityRecord(token: string, period: string): RentUtilityBundleDto {
  assertAuthorized(token);
  const periodStr = String(period || '').trim();
  if (!periodStr) throw new Error('請指定要刪除的期別。');

  return withScriptLock(() => {
    const ss = getActiveSpreadsheetOrThrow();
    const sheet = ensureRentUtilitySheet(ss);
    const lastRow = Math.max(sheet.getLastRow(), UTILITY_DATA_START_ROW);
    const rangeVals = sheet.getRange(UTILITY_DATA_START_ROW, 1, lastRow - UTILITY_DATA_START_ROW + 1, 10).getValues();

    const filledIndices: number[] = [];
    let deletePos = -1;
    for (let i = 0; i < rangeVals.length; i++) {
      const p = String(rangeVals[i][0] || '').trim();
      if (isNumericCell(rangeVals[i][1])) {
        filledIndices.push(i);
        if (p === periodStr) deletePos = filledIndices.length - 1;
      }
    }

    if (deletePos !== -1) {
      for (let k = deletePos; k < filledIndices.length - 1; k++) {
        const dstRowNum = UTILITY_DATA_START_ROW + filledIndices[k];
        const srcVals = rangeVals[filledIndices[k + 1]];
        sheet.getRange(dstRowNum, 1, 1, 10).setValues([srcVals]);
      }
      const lastFilledRowNum = UTILITY_DATA_START_ROW + filledIndices[filledIndices.length - 1];
      sheet.getRange(lastFilledRowNum, 2, 1, 4).clearContent();
      sheet.getRange(lastFilledRowNum, 8, 1, 3).clearContent();
      SpreadsheetApp.flush();
    }

    return readRentUtilityDataInternal(ss);
  });
}

function saveRentUtilityRents(token: string, rents: UtilityRentsDto): RentUtilityBundleDto {
  assertAuthorized(token);
  return withScriptLock(() => {
    const ss = getActiveSpreadsheetOrThrow();
    const sheet = ensureRentUtilitySheet(ss);
    saveUtilityRentsInternal(sheet, rents);
    SpreadsheetApp.flush();
    return readRentUtilityDataInternal(ss);
  });
}

/**
 * 選用連動功能：一鍵將本期水電帳單（或代收水電費收入）寫入 CashFlow_Log
 */
function postUtilityToCashFlow(
  token: string,
  payload: {
    mode: 'bill_expense' | 'tenant_income';
    period: string;
    amount: number;
    note?: string;
  },
  viewYear?: number,
  viewMonth?: number
): { ok: boolean; message: string; bundle: AppBundleDto } {
  assertAuthorized(token);
  const amount = Math.round(Number(payload.amount));
  const period = String(payload.period || '').trim() || '本期';
  if (isNaN(amount) || amount <= 0) throw new Error('寫入金額必須大於 0。');

  return withScriptLock(() => {
    const ss = getActiveSpreadsheetOrThrow();
    const logSheet = getSheetOrThrow(ss, SHEET_NAMES.CASHFLOW_LOG);
    const today = new Date();
    const isIncome = payload.mode === 'tenant_income';

    appendCashFlowRows(logSheet, [
      {
        date: today,
        type: isIncome ? CASHFLOW_TYPES.OTHER_INCOME : CASHFLOW_TYPES.FIXED_EXPENSE,
        category: isIncome ? '房租收入' : '水電瓦斯/管理費',
        itemName: isIncome ? `${period}期 房客代收水電費` : `${period}期 5F&6F 台電與水費帳單`,
        amount,
        currency: 'TWD',
        fxRate: 1,
        source: '手機記帳',
        note: String(payload.note || `由 5F&6F 水電計算機匯入 (${period}期)`).slice(0, 200),
      },
    ]);
    SpreadsheetApp.flush();

    return {
      ok: true,
      message: `已寫入流水帳：${isIncome ? '代收水電收入' : '水電帳單支出'} NT$ ${amount.toLocaleString()}`,
      bundle: buildAppBundleInternal(ss, viewYear, viewMonth),
    };
  });
}
