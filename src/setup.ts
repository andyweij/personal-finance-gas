/**
 * 一鍵初始化腳本 (setupSpreadsheet)、保留資料重建 Dashboard (rebuildDashboardOnly)
 * 與 Google Sheets 自訂選單 (onOpen)
 */

/**
 * 開啟試算表時自動掛載自訂選單
 */
function onOpen(): void {
  const ui = getUiOrNull();
  if (!ui) return;

  ui.createMenu('💰 個人財務系統')
    .addItem('1. 一鍵初始化所有分頁與公式（含範例資料）', 'setupSpreadsheetWithConfirm')
    .addItem('2. 僅更新 Dashboard 儀表板（保留所有帳目資料）', 'rebuildDashboardOnly')
    .addItem('3. 僅建立/重置「5F&6F水電費」分頁（保留其他帳目）', 'initRentUtilitySheetOnly')
    .addSeparator()
    .addItem('4. 手動執行本月常態收支入帳', 'runMonthlyRecurringMenu')
    .addItem('5. 立即記錄本月淨資產快照', 'runMonthEndSnapshotMenu')
    .addSeparator()
    .addItem('6. 安裝 / 重設每月排程觸發器', 'installTriggers')
    .addItem('7. 檢視目前排程觸發器狀態', 'listInstalledTriggers')
    .addSeparator()
    .addItem('8. 清除 / 重設 Web App PIN 鎖', 'resetAppPinMenu')
    .addToUi();
}

/**
 * 由選單觸發的安全確認版初始化
 */
function setupSpreadsheetWithConfirm(): void {
  const ui = getUiOrNull();
  if (ui) {
    const response = ui.alert(
      '初始化確認',
      '此動作將建立或重置 6 個核心分頁（Dashboard、CashFlow_Log、Recurring_Config、Annual_Sinking_Fund、Assets_Liabilities、NetWorth_History）並填入預設結構與範例資料。\n\n若已有正式帳目，請改用「2. 僅更新 Dashboard 儀表板」或先備份後再執行。確定要重置全部嗎？',
      ui.ButtonSet.YES_NO
    );
    if (response !== ui.Button.YES) {
      return;
    }
  }
  setupSpreadsheet(true);
}

/**
 * 完整重置單一分頁：清除內容、格式、舊資料驗證、舊合併儲存格、條件式格式與圖表
 * （GAS 的 sheet.clear() 不會清除 DataValidation 與合併格，必須明確清除以避免跨版本重建報錯）
 */
function resetSheetCompletely(sheet: GoogleAppsScript.Spreadsheet.Sheet): void {
  const maxRows = Math.max(sheet.getMaxRows(), 1);
  const maxCols = Math.max(sheet.getMaxColumns(), 1);
  const fullRange = sheet.getRange(1, 1, maxRows, maxCols);
  fullRange.breakApart();
  fullRange.clearDataValidations();
  sheet.clear();
  sheet.clearConditionalFormatRules();
  sheet.getCharts().forEach((chart) => sheet.removeChart(chart));
}

/**
 * 安全重建 Dashboard（保留其他 5 個分頁所有帳目、設定與歷史紀錄）
 */
function rebuildDashboardOnly(): void {
  const ss = getActiveSpreadsheetOrThrow();
  let dash = ss.getSheetByName(SHEET_NAMES.DASHBOARD);

  // 保留使用者既有的預算與查詢設定（若存在）
  let savedBudget = DEFAULT_MONTHLY_DAILY_BUDGET;
  let savedEmergencyMonths = DEFAULT_EMERGENCY_MONTHS;
  if (dash) {
    savedBudget = toSafeNumber(dash.getRange('B3').getValue(), DEFAULT_MONTHLY_DAILY_BUDGET) || DEFAULT_MONTHLY_DAILY_BUDGET;
    savedEmergencyMonths = toSafeNumber(dash.getRange('F3').getValue(), DEFAULT_EMERGENCY_MONTHS) || DEFAULT_EMERGENCY_MONTHS;
    resetSheetCompletely(dash);
  } else {
    dash = ss.insertSheet(SHEET_NAMES.DASHBOARD, 0);
  }

  buildDashboardSheet(dash, savedBudget, savedEmergencyMonths);
  ss.setActiveSheet(dash);
  SpreadsheetApp.flush();
  safeToast('Dashboard 儀表板已升級完成（原有帳目資料皆已完整保留）！', '更新成功', 6);
}

/**
 * 一鍵初始化所有分頁、公式、驗證、條件式格式與圖表
 * @param seedSampleData 是否填入範例資料（預設 true，方便初次檢視效果）
 */
function setupSpreadsheet(seedSampleData = true): void {
  const ss = getActiveSpreadsheetOrThrow();
  ss.setSpreadsheetTimeZone(APP_TIMEZONE);
  ss.setSpreadsheetLocale('zh_TW');

  const orderedNames = [
    SHEET_NAMES.DASHBOARD,
    SHEET_NAMES.CASHFLOW_LOG,
    SHEET_NAMES.RECURRING_CONFIG,
    SHEET_NAMES.SINKING_FUND,
    SHEET_NAMES.ASSETS_LIABILITIES,
    SHEET_NAMES.NETWORTH_HISTORY,
    SHEET_NAMES.RENT_UTILITY,
  ];

  // 先確保所有目標分頁皆已存在，避免跨頁公式暫時出現 #REF!
  const sheets: Record<string, GoogleAppsScript.Spreadsheet.Sheet> = {};
  for (const name of orderedNames) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    } else {
      resetSheetCompletely(sheet);
    }
    sheets[name] = sheet;
  }

  // 依相依順序建置分頁內容
  buildCashFlowLogSheet(sheets[SHEET_NAMES.CASHFLOW_LOG], seedSampleData);
  buildRecurringConfigSheet(sheets[SHEET_NAMES.RECURRING_CONFIG], seedSampleData);
  buildSinkingFundSheet(sheets[SHEET_NAMES.SINKING_FUND], seedSampleData);
  buildAssetsLiabilitiesSheet(sheets[SHEET_NAMES.ASSETS_LIABILITIES], seedSampleData);
  buildNetWorthHistorySheet(sheets[SHEET_NAMES.NETWORTH_HISTORY], seedSampleData);
  buildRentUtilitySheet(sheets[SHEET_NAMES.RENT_UTILITY], seedSampleData);
  buildDashboardSheet(sheets[SHEET_NAMES.DASHBOARD]);

  // 排列分頁順序
  orderedNames.forEach((name, idx) => {
    ss.setActiveSheet(sheets[name]);
    ss.moveActiveSheet(idx + 1);
  });

  // 移除預設空白分頁（如 工作表1 / Sheet1）
  removeUnusedDefaultSheets(ss, orderedNames);

  // 回到 Dashboard
  ss.setActiveSheet(sheets[SHEET_NAMES.DASHBOARD]);
  SpreadsheetApp.flush();

  safeToast('所有 6 個分頁、公式、驗證與圖表已初始化完成！', '初始化成功', 6);
}

function removeUnusedDefaultSheets(
  ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
  keepNames: string[]
): void {
  const defaultCandidates = ['Sheet1', '工作表1'];
  for (const candidate of defaultCandidates) {
    if (keepNames.indexOf(candidate) !== -1) continue;
    const sheet = ss.getSheetByName(candidate);
    if (sheet && sheet.getLastRow() === 0 && ss.getSheets().length > keepNames.length) {
      ss.deleteSheet(sheet);
    }
  }
}

/**
 * 套用表頭統一視覺風格
 */
function styleHeaderRow(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  columnCount: number,
  rowHeight = 32
): void {
  const headerRange = sheet.getRange(1, 1, 1, columnCount);
  headerRange
    .setBackground(THEME_COLORS.PRIMARY_DARK)
    .setFontColor(THEME_COLORS.WHITE)
    .setFontWeight('bold')
    .setFontSize(10)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);
  sheet.setRowHeight(1, rowHeight);
  sheet.setFrozenRows(1);
}

/**
 * 1. 建置 CashFlow_Log（收支流水帳）
 */
function buildCashFlowLogSheet(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  seedSampleData: boolean
): void {
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

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet
    .getRange('B1')
    .setFormula('={"年月"; ARRAYFORMULA(IF(A2:A="", "", TEXT(A2:A, "yyyy-mm")))}');
  sheet
    .getRange('H1')
    .setFormula(
      '={"台幣金額(TWD)"; ARRAYFORMULA(IF(F2:F="", "", ROUND(F2:F * IF(G2:G="USD", IF(I2:I="", Dashboard!$F$2, I2:I), 1), 0)))}'
    );

  styleHeaderRow(sheet, headers.length);

  const maxDataRows = 1000;
  sheet
    .getRange(2, 3, maxDataRows, 1)
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(ALL_CASHFLOW_TYPES, true).build()
    );
  sheet
    .getRange(2, 7, maxDataRows, 1)
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(CURRENCIES, true).build()
    );
  sheet
    .getRange(2, 10, maxDataRows, 1)
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(SOURCE_OPTIONS, true).build()
    );

  sheet.getRange(2, 1, maxDataRows, 1).setNumberFormat('yyyy-mm-dd').setHorizontalAlignment('center');
  sheet.getRange(2, 2, maxDataRows, 1).setHorizontalAlignment('center');
  sheet.getRange(2, 6, maxDataRows, 1).setNumberFormat('#,##0.00');
  sheet.getRange(2, 7, maxDataRows, 1).setHorizontalAlignment('center');
  sheet.getRange(2, 8, maxDataRows, 1).setNumberFormat('#,##0');
  sheet.getRange(2, 9, maxDataRows, 1).setNumberFormat('#,##0.0000');
  sheet.getRange(2, 10, maxDataRows, 1).setHorizontalAlignment('center');

  const widths = [110, 90, 110, 115, 200, 115, 70, 130, 95, 95, 220];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  const typeRange = sheet.getRange(2, 3, maxDataRows, 1);
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains('收入')
      .setBackground(THEME_COLORS.SUCCESS_BG)
      .setFontColor(THEME_COLORS.SUCCESS_TEXT)
      .setRanges([typeRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(CASHFLOW_TYPES.INVESTMENT)
      .setBackground(THEME_COLORS.INFO_BG)
      .setFontColor(THEME_COLORS.INFO_TEXT)
      .setRanges([typeRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(CASHFLOW_TYPES.TAX_LARGE)
      .setBackground(THEME_COLORS.WARNING_BG)
      .setFontColor(THEME_COLORS.WARNING_TEXT)
      .setRanges([typeRange])
      .build(),
  ]);

  if (seedSampleData) {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1, 12, 0, 0);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);

    const sampleRows: CashFlowInput[] = [
      {
        date: firstDay,
        type: CASHFLOW_TYPES.FIXED_INCOME,
        category: '薪資',
        itemName: '本業月薪',
        amount: 95000,
        currency: 'TWD',
        fxRate: 1,
        source: '自動入帳',
        note: '範例資料（請至 Recurring_Config 修改實際薪資）',
      },
      {
        date: firstDay,
        type: CASHFLOW_TYPES.FIXED_INCOME,
        category: '房租收入',
        itemName: '出租套房租金',
        amount: 18000,
        currency: 'TWD',
        fxRate: 1,
        source: '自動入帳',
        note: '範例資料',
      },
      {
        date: firstDay,
        type: CASHFLOW_TYPES.FIXED_EXPENSE,
        category: '房貸',
        itemName: '房屋貸款月付金',
        amount: 28500,
        currency: 'TWD',
        fxRate: 1,
        source: '自動入帳',
        note: '本息平均攤還',
      },
      {
        date: firstDay,
        type: CASHFLOW_TYPES.FIXED_EXPENSE,
        category: '車貸',
        itemName: '汽車貸款月付金',
        amount: 11200,
        currency: 'TWD',
        fxRate: 1,
        source: '自動入帳',
        note: '60 期車貸',
      },
      {
        date: firstDay,
        type: CASHFLOW_TYPES.INVESTMENT,
        category: '台股投資',
        itemName: '定期定額 0050',
        amount: 15000,
        currency: 'TWD',
        fxRate: 1,
        source: '自動入帳',
        note: '強制儲蓄投資流出',
      },
      {
        date: firstDay,
        type: CASHFLOW_TYPES.INVESTMENT,
        category: '中信基金',
        itemName: '定期定額 中信基金',
        amount: 10000,
        currency: 'TWD',
        fxRate: 1,
        source: '自動入帳',
        note: '強制儲蓄投資流出',
      },
      {
        date: firstDay,
        type: CASHFLOW_TYPES.SUBSCRIPTION,
        category: 'AI訂閱',
        itemName: 'Google AI Pro',
        amount: 19.99,
        currency: 'USD',
        fxRate: DEFAULT_USD_TWD_RATE,
        source: '自動入帳',
        note: 'USD 訂閱（已鎖定入帳匯率）',
      },
      {
        date: firstDay,
        type: CASHFLOW_TYPES.SUBSCRIPTION,
        category: 'AI訂閱',
        itemName: 'Claude Pro',
        amount: 20,
        currency: 'USD',
        fxRate: DEFAULT_USD_TWD_RATE,
        source: '自動入帳',
        note: 'USD 訂閱（已鎖定入帳匯率）',
      },
      {
        date: today,
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        category: '餐飲',
        itemName: '午餐與咖啡',
        amount: 320,
        currency: 'TWD',
        fxRate: 1,
        source: '手機記帳',
        note: '日常花費範例',
      },
      {
        date: today,
        type: CASHFLOW_TYPES.DAILY_EXPENSE,
        category: '交通',
        itemName: '捷運與加油',
        amount: 1280,
        currency: 'TWD',
        fxRate: 1,
        source: '手機記帳',
        note: '日常花費範例',
      },
    ];
    appendCashFlowRows(sheet, sampleRows);
  }
}

/**
 * 2. 建置 Recurring_Config（常態性與排程收支管理表）
 * 支援週期：月繳 / 年繳 / 特定月份 (如 3,6,9,12) / 一次性 (入帳後自動轉停用)
 */
function buildRecurringConfigSheet(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  seedSampleData: boolean
): void {
  const headers = [
    '項目名稱',
    '分類',
    '收支類型',
    '金額',
    '幣別',
    '入帳/扣款週期',
    '生效月份(月繳留空/特定月填3,6,9,12/一次填YYYY-MM)',
    '狀態',
    '月均換算(TWD)',
    '備註',
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  // 依週期動態計算月均 TWD：月繳=原值、年繳=÷12、特定月份=×月份數÷12、一次性=0
  sheet
    .getRange('I1')
    .setFormula(
      '={"月均換算(TWD)"; ARRAYFORMULA(IF(A2:A="", "", IF(H2:H<>"啟用", 0, IF(F2:F="一次性", 0, ROUND(D2:D * IF(E2:E="USD", Dashboard!$F$2, 1) * IF(F2:F="月繳", 1, IF(F2:F="年繳", 1/12, IF(G2:G="", 0, (LEN(G2:G)-LEN(SUBSTITUTE(SUBSTITUTE(G2:G,"、",","),",",""))+1)/12))), 0)))))}'
    );

  styleHeaderRow(sheet, headers.length, 38);

  const maxRows = 200;
  sheet
    .getRange(2, 3, maxRows, 1)
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(RECURRING_CASHFLOW_TYPES, true).build()
    );
  sheet
    .getRange(2, 5, maxRows, 1)
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(CURRENCIES, true).build()
    );
  sheet
    .getRange(2, 6, maxRows, 1)
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(BILLING_CYCLES, true).build()
    );
  sheet
    .getRange(2, 8, maxRows, 1)
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(STATUS_OPTIONS, true).build()
    );

  sheet.getRange(2, 4, maxRows, 1).setNumberFormat('#,##0.00');
  sheet.getRange(2, 5, maxRows, 2).setHorizontalAlignment('center');
  // G 欄設為純文字格式，避免輸入 "3,6,9,12" 或 "2026-12" 被試算表自動誤判為日期
  sheet.getRange(2, 7, maxRows, 1).setNumberFormat('@').setHorizontalAlignment('center');
  sheet.getRange(2, 8, maxRows, 1).setHorizontalAlignment('center');
  sheet.getRange(2, 9, maxRows, 1).setNumberFormat('#,##0');

  const widths = [190, 115, 110, 110, 65, 105, 185, 80, 125, 260];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  const fullRange = sheet.getRange(2, 1, maxRows, headers.length);
  const statusCol = sheet.getRange(2, 8, maxRows, 1);
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$H2="停用"')
      .setBackground('#F1F5F9')
      .setFontColor('#94A3B8')
      .setRanges([fullRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('啟用')
      .setBackground(THEME_COLORS.SUCCESS_BG)
      .setFontColor(THEME_COLORS.SUCCESS_TEXT)
      .setRanges([statusCol])
      .build(),
  ]);

  if (seedSampleData) {
    const sampleConfig = [
      ['本業月薪', '薪資', CASHFLOW_TYPES.FIXED_INCOME, 95000, 'TWD', '月繳', '', '啟用', '修改此金額即可更新每月薪資，每月 1 號自動寫入'],
      ['出租套房租金', '房租收入', CASHFLOW_TYPES.FIXED_INCOME, 18000, 'TWD', '月繳', '', '啟用', '若為租屋支出請改收支類型為固定支出'],
      ['年終獎金(範例)', '獎金', CASHFLOW_TYPES.OTHER_INCOME, 150000, 'TWD', '年繳', '1', '停用', '年繳範例：啟用後每年 1 月自動入帳'],
      ['季配息/副業(範例)', '股息/配息', CASHFLOW_TYPES.OTHER_INCOME, 12000, 'TWD', '特定月份', '3,6,9,12', '停用', '特定月份範例：填逗號分隔月份，每年 3/6/9/12 月入帳'],
      ['一次性專案獎金(範例)', '獎金', CASHFLOW_TYPES.OTHER_INCOME, 30000, 'TWD', '一次性', '2026-12', '停用', '一次性範例：到期月份入帳後系統會自動改為停用'],
      ['房屋貸款月付金', '房貸', CASHFLOW_TYPES.FIXED_EXPENSE, 28500, 'TWD', '月繳', '', '啟用', '固定負債月付金'],
      ['汽車貸款月付金', '車貸', CASHFLOW_TYPES.FIXED_EXPENSE, 11200, 'TWD', '月繳', '', '啟用', '固定負債月付金'],
      ['定期定額 0050', '台股投資', CASHFLOW_TYPES.INVESTMENT, 15000, 'TWD', '月繳', '', '啟用', '強制儲蓄：不計入消費性支出'],
      ['定期定額 中信基金', '中信基金', CASHFLOW_TYPES.INVESTMENT, 10000, 'TWD', '月繳', '', '啟用', '強制儲蓄：不計入消費性支出'],
      ['Google AI Pro', 'AI訂閱', CASHFLOW_TYPES.SUBSCRIPTION, 19.99, 'USD', '月繳', '', '啟用', '自動換算台幣；停用不影響歷史帳目'],
      ['Claude Pro', 'AI訂閱', CASHFLOW_TYPES.SUBSCRIPTION, 20, 'USD', '月繳', '', '啟用', '自動換算台幣'],
      ['YouTube Premium', '影音訂閱', CASHFLOW_TYPES.SUBSCRIPTION, 199, 'TWD', '月繳', '', '啟用', '常態訂閱範例'],
      ['雲端備份年約', '雲端服務', CASHFLOW_TYPES.SUBSCRIPTION, 99.99, 'USD', '年繳', '6', '停用', '年繳範例：將於 6 月 1 號自動入帳'],
    ];

    const leftBlock = sampleConfig.map((r) => r.slice(0, 8));
    const noteBlock = sampleConfig.map((r) => [r[8]]);
    sheet.getRange(2, 1, sampleConfig.length, 8).setValues(leftBlock);
    sheet.getRange(2, 10, sampleConfig.length, 1).setValues(noteBlock);
  }
}

/**
 * 3. 建置 Annual_Sinking_Fund（不定期稅金與大額支出自訂月數攤提表）
 * D 欄「分攤月數」可自由控制（預設 12 個月，亦可設為 3、6、24 個月）
 */
function buildSinkingFundSheet(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  seedSampleData: boolean
): void {
  const headers = [
    '項目名稱',
    '分類',
    '預估總金額(TWD)',
    '分攤月數',
    '預計繳款月份',
    '每月應提撥(TWD)',
    '狀態',
    '本年度已實支(TWD)',
    '年度剩餘預算(TWD)',
    '備註',
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  styleHeaderRow(sheet, headers.length);

  const formulaRows = 50;
  sheet
    .getRange(2, 2, formulaRows, 1)
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(SINKING_FUND_CATEGORIES, true).build()
    );
  sheet
    .getRange(2, 4, formulaRows, 1)
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(1).setAllowInvalid(false).build()
    );
  sheet
    .getRange(2, 7, formulaRows, 1)
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(STATUS_OPTIONS, true).build()
    );

  // F 欄：每月應提撥 = 預估總金額 / 分攤月數（留空預設 12）
  const fFormulas: string[][] = [];
  const hFormulas: string[][] = [];
  const iFormulas: string[][] = [];
  for (let r = 2; r <= formulaRows + 1; r++) {
    fFormulas.push([`=IF(C${r}="", "", IF(G${r}<>"啟用", 0, ROUND(C${r}/IF(D${r}="",12,D${r}), 0)))`]);
    hFormulas.push([
      `=IF(A${r}="", "", SUMIFS(CashFlow_Log!$H$2:$H, CashFlow_Log!$A$2:$A, ">="&DATE(Dashboard!$B$2,1,1), CashFlow_Log!$A$2:$A, "<="&DATE(Dashboard!$B$2,12,31), CashFlow_Log!$C$2:$C, "稅金與大額", CashFlow_Log!$E$2:$E, A${r}))`,
    ]);
    iFormulas.push([`=IF(A${r}="", "", C${r}-H${r})`]);
  }
  sheet.getRange(2, 6, formulaRows, 1).setFormulas(fFormulas);
  sheet.getRange(2, 8, formulaRows, 1).setFormulas(hFormulas);
  sheet.getRange(2, 9, formulaRows, 1).setFormulas(iFormulas);

  sheet.getRange(2, 3, formulaRows, 1).setNumberFormat('#,##0');
  sheet
    .getRange(2, 4, formulaRows, 1)
    .setNumberFormat('0" 個月"')
    .setHorizontalAlignment('center')
    .setBackground(THEME_COLORS.INPUT_BG);
  sheet.getRange(2, 5, formulaRows, 1).setHorizontalAlignment('center');
  sheet.getRange(2, 6, formulaRows, 1).setNumberFormat('#,##0');
  sheet.getRange(2, 7, formulaRows, 1).setHorizontalAlignment('center');
  sheet.getRange(2, 8, formulaRows, 2).setNumberFormat('#,##0');

  const widths = [180, 120, 140, 95, 115, 140, 80, 145, 145, 240];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberLessThan(0)
      .setBackground(THEME_COLORS.DANGER_BG)
      .setFontColor(THEME_COLORS.DANGER_TEXT)
      .setBold(true)
      .setRanges([sheet.getRange(2, 9, formulaRows, 1)])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$G2="停用"')
      .setBackground('#F1F5F9')
      .setFontColor('#94A3B8')
      .setRanges([sheet.getRange(2, 1, formulaRows, headers.length)])
      .build(),
  ]);

  if (seedSampleData) {
    const sampleFunds = [
      ['綜合所得稅', '所得稅', 60000, 12, '5月', '啟用', '12 個月攤提；手機記帳項目填「綜合所得稅」自動對應'],
      ['房屋稅', '房屋/地價稅', 12000, 12, '5月', '啟用', '每年 5 月開徵'],
      ['地價稅', '房屋/地價稅', 6000, 12, '11月', '啟用', '每年 11 月開徵'],
      ['汽車牌照與燃料稅', '汽機車稅費', 11920, 12, '4月 / 7月', '啟用', '1800cc 範例'],
      ['年繳醫療與壽險保費', '保費', 48000, 12, '8月', '啟用', '年繳保費月攤提，避免當月現金流失真'],
      ['出國旅遊預備金(範例)', '旅遊/目標基金', 60000, 6, '半年後', '停用', '自訂分攤月數範例：填 6 代表分 6 個月提撥（每月 1 萬）'],
    ];

    sampleFunds.forEach((row, idx) => {
      const r = idx + 2;
      sheet.getRange(r, 1, 1, 5).setValues([row.slice(0, 5)]);
      sheet.getRange(r, 7).setValue(row[5]);
      sheet.getRange(r, 10).setValue(row[6]);
    });
  }
}

/**
 * 4. 建置 Assets_Liabilities（整合資產負債表 — 存量快照）
 */
function buildAssetsLiabilitiesSheet(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  seedSampleData: boolean
): void {
  const headers = [
    '更新方式',
    '大類',
    '細分類別',
    '流動性',
    '項目名稱',
    '股票代碼(台股填TPE:xxxx)',
    '持有股數 / 原幣金額',
    '幣別',
    '最新單價(原幣)',
    '折合台幣市值(TWD)',
    '最後更新日 / 備註',
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  styleHeaderRow(sheet, headers.length);

  const formulaRows = 100;
  sheet
    .getRange(2, 1, formulaRows, 1)
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(ASSET_UPDATE_MODES, true).build()
    );
  sheet
    .getRange(2, 2, formulaRows, 1)
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(ASSET_MAJOR_TYPES, true).build()
    );
  sheet
    .getRange(2, 3, formulaRows, 1)
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(ASSET_SUB_CATEGORIES, true).build()
    );
  sheet
    .getRange(2, 4, formulaRows, 1)
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(LIQUIDITY_LEVELS, true).build()
    );
  sheet
    .getRange(2, 8, formulaRows, 1)
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(CURRENCIES, true).build()
    );

  const priceFormulas: string[][] = [];
  const twdFormulas: string[][] = [];
  for (let r = 2; r <= formulaRows + 1; r++) {
    priceFormulas.push([
      `=IF(E${r}="", "", IF(F${r}<>"", IFERROR(GOOGLEFINANCE(F${r}, "price"), 0), 1))`,
    ]);
    twdFormulas.push([
      `=IF(E${r}="", "", ROUND(G${r} * I${r} * IF(H${r}="USD", Dashboard!$F$2, 1), 0))`,
    ]);
  }
  sheet.getRange(2, 9, formulaRows, 1).setFormulas(priceFormulas);
  sheet.getRange(2, 10, formulaRows, 1).setFormulas(twdFormulas);

  sheet.getRange(2, 1, formulaRows, 4).setHorizontalAlignment('center');
  sheet.getRange(2, 6, formulaRows, 1).setHorizontalAlignment('center');
  sheet.getRange(2, 7, formulaRows, 1).setNumberFormat('#,##0.00');
  sheet.getRange(2, 8, formulaRows, 1).setHorizontalAlignment('center');
  sheet.getRange(2, 9, formulaRows, 1).setNumberFormat('#,##0.00');
  sheet.getRange(2, 10, formulaRows, 1).setNumberFormat('#,##0');

  const widths = [100, 75, 125, 85, 195, 165, 145, 65, 115, 150, 230];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('自動更新')
      .setBackground(THEME_COLORS.INFO_BG)
      .setFontColor(THEME_COLORS.INFO_TEXT)
      .setRanges([sheet.getRange(2, 1, formulaRows, 1)])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('手動快照')
      .setBackground(THEME_COLORS.WARNING_BG)
      .setFontColor(THEME_COLORS.WARNING_TEXT)
      .setRanges([sheet.getRange(2, 1, formulaRows, 1)])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$B2="負債"')
      .setBackground('#FFF5F5')
      .setFontColor(THEME_COLORS.DANGER_TEXT)
      .setRanges([sheet.getRange(2, 2, formulaRows, headers.length - 1)])
      .build(),
  ]);

  if (seedSampleData) {
    const sampleAssets = [
      ['自動更新', '資產', '台股', '中流動', '元大台灣50 (0050)', 'TPE:0050', 3000, 'TWD', 'GOOGLEFINANCE 自動更新股價'],
      ['自動更新', '資產', '台股', '中流動', '台積電 (2330)', 'TPE:2330', 500, 'TWD', 'GOOGLEFINANCE 自動更新股價'],
      ['自動更新', '資產', '美金', '高流動', '美金活存 / 定存帳戶', '', 12000, 'USD', '自動連動 Dashboard 即時匯率'],
      ['手動快照', '資產', '定存/現金', '高流動', '台幣活存與定存(緊急預備金)', '', 550000, 'TWD', '每月月底手動更新餘額'],
      ['手動快照', '資產', '中信基金', '中流動', '中信成長型基金', '', 320000, 'TWD', '每月月底依對帳單更新市值'],
      ['手動快照', '資產', '結構性商品', '低流動', '銀行結構性商品', '', 250000, 'TWD', '每月月底手動更新現值'],
      ['手動快照', '資產', '保單(保價金)', '低流動', '儲蓄險保單(解約金/保價金)', '', 420000, 'TWD', '依保單年度保價金表更新'],
      ['手動快照', '負債', '房貸餘額', '負債', '房屋貸款剩餘本金', '', 6200000, 'TWD', '每月月底依銀行本金餘額更新'],
      ['手動快照', '負債', '車貸餘額', '負債', '汽車貸款剩餘本金', '', 360000, 'TWD', '每月月底依貸款餘額更新'],
    ];

    sampleAssets.forEach((row, idx) => {
      const r = idx + 2;
      sheet.getRange(r, 1, 1, 8).setValues([row.slice(0, 8)]);
      sheet.getRange(r, 11).setValue(row[8]);
    });
  }
}

/**
 * 5. 建置 NetWorth_History（每月淨資產歷史紀錄）
 */
function buildNetWorthHistorySheet(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  seedSampleData: boolean
): void {
  const headers = [
    '快照日期',
    '年月',
    '總資產(TWD)',
    '總負債(TWD)',
    '淨資產(TWD)',
    '高流動資產(TWD)',
    '投資資產(TWD)',
    '保單資產(TWD)',
    '當月總收入(TWD)',
    '當月消費總支出(TWD)',
    '當月儲蓄率',
    '備註',
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  styleHeaderRow(sheet, headers.length);

  const maxRows = 240;
  sheet.getRange(2, 1, maxRows, 1).setNumberFormat('yyyy-mm-dd').setHorizontalAlignment('center');
  sheet.getRange(2, 2, maxRows, 1).setHorizontalAlignment('center');
  sheet.getRange(2, 3, maxRows, 8).setNumberFormat('#,##0');
  sheet.getRange(2, 11, maxRows, 1).setNumberFormat('0.0%');

  const widths = [110, 85, 130, 130, 130, 130, 130, 125, 130, 140, 100, 200];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  if (seedSampleData) {
    const now = new Date();
    const prevMonth2 = new Date(now.getFullYear(), now.getMonth() - 2, 28, 12, 0, 0);
    const prevMonth1 = new Date(now.getFullYear(), now.getMonth() - 1, 28, 12, 0, 0);

    const sampleHistory = [
      [
        prevMonth2,
        formatYearMonth(prevMonth2),
        2950000,
        6620000,
        -3670000,
        900000,
        1630000,
        420000,
        113000,
        74500,
        0.341,
        '歷史範例快照（可刪除）',
      ],
      [
        prevMonth1,
        formatYearMonth(prevMonth1),
        3040000,
        6590000,
        -3550000,
        940000,
        1680000,
        420000,
        113000,
        72000,
        0.363,
        '歷史範例快照（可刪除）',
      ],
    ];
    sheet.getRange(2, 1, sampleHistory.length, headers.length).setValues(sampleHistory);
  }

  const chart = sheet
    .newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(sheet.getRange('B1:E37'))
    .setOption('title', '每月總資產 / 總負債 / 淨資產趨勢圖 (TWD)')
    .setOption('legend', { position: 'bottom' })
    .setOption('curveType', 'function')
    .setOption('pointSize', 5)
    .setOption('colors', ['#2563EB', '#DC2626', '#16A34A'])
    .setPosition(2, 13, 10, 0)
    .setOption('width', 620)
    .setOption('height', 360)
    .build();
  sheet.insertChart(chart);
}

/**
 * 6. 建置 Dashboard（年度/月度現金流、大項分類統計、單項12月明細查詢與淨資產儀表板）
 */
function buildDashboardSheet(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  monthlyDailyBudget = DEFAULT_MONTHLY_DAILY_BUDGET,
  emergencyMonths = DEFAULT_EMERGENCY_MONTHS
): void {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  // 標題列
  sheet
    .getRange('A1:G1')
    .merge()
    .setValue('個人現金流與資產負債管理儀表板')
    .setBackground(THEME_COLORS.PRIMARY_DARK)
    .setFontColor(THEME_COLORS.WHITE)
    .setFontWeight('bold')
    .setFontSize(16)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 44);

  // 控制與參數設定列 (Row 2 - Row 3)
  sheet.getRange('A2:G3').setVerticalAlignment('middle').setFontSize(10);
  sheet.getRange('A2').setValue('查詢年份').setFontWeight('bold').setBackground(THEME_COLORS.SUBHEADER_BG);
  sheet
    .getRange('B2')
    .setValue(currentYear)
    .setBackground(THEME_COLORS.INPUT_BG)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setNumberFormat('0');

  sheet.getRange('C2').setValue('查詢月份').setFontWeight('bold').setBackground(THEME_COLORS.SUBHEADER_BG);
  sheet
    .getRange('D2')
    .setValue(currentMonth)
    .setBackground(THEME_COLORS.INPUT_BG)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setNumberFormat('0')
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireNumberBetween(1, 12).setAllowInvalid(false).build()
    );

  sheet.getRange('E2').setValue('即時匯率 (USD/TWD)').setFontWeight('bold').setBackground(THEME_COLORS.SUBHEADER_BG);
  sheet
    .getRange('F2')
    .setFormula(`=IFERROR(GOOGLEFINANCE("CURRENCY:USDTWD"), ${DEFAULT_USD_TWD_RATE})`)
    .setBackground(THEME_COLORS.SECTION_BG)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setNumberFormat('#,##0.00');

  sheet
    .getRange('G2')
    .setFormula('=TEXT(DATE(B2,D2,1),"yyyy-mm")')
    .setBackground(THEME_COLORS.SUBHEADER_BG)
    .setFontColor(THEME_COLORS.TEXT_MUTED)
    .setHorizontalAlignment('center');

  sheet.getRange('A3').setValue('每月日常消費預算上限').setFontWeight('bold').setBackground(THEME_COLORS.SUBHEADER_BG);
  sheet
    .getRange('B3')
    .setValue(monthlyDailyBudget)
    .setBackground(THEME_COLORS.INPUT_BG)
    .setFontWeight('bold')
    .setNumberFormat('#,##0');

  sheet.getRange('C3').setValue('年度日常消費預算上限').setFontWeight('bold').setBackground(THEME_COLORS.SUBHEADER_BG);
  sheet.getRange('D3').setFormula('=B3*12').setNumberFormat('#,##0');

  sheet.getRange('E3').setValue('緊急預備金目標(月數)').setFontWeight('bold').setBackground(THEME_COLORS.SUBHEADER_BG);
  sheet
    .getRange('F3')
    .setValue(emergencyMonths)
    .setBackground(THEME_COLORS.INPUT_BG)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setNumberFormat('0');
  sheet
    .getRange('G3')
    .setValue('黃底欄位可直接修改')
    .setFontColor(THEME_COLORS.TEXT_MUTED)
    .setFontSize(9)
    .setHorizontalAlignment('center');

  sheet.setRowHeight(2, 28);
  sheet.setRowHeight(3, 28);

  const ytdStart = '">="&DATE($B$2,1,1)';
  const ytdEnd = '"<="&DATE($B$2,12,31)';

  // =========================================================
  // 區塊一：月度與年度現金流監控 (Row 5 - Row 15)
  // =========================================================
  styleSectionBanner(sheet, 5, '【一、現金流監控（月度 vs 年度）】');
  sheet
    .getRange('A6:G6')
    .setValues([['指標項目', '當月金額 (TWD)', '年度累計 (TWD)', '佔月收入比例', '狀態 / 警示燈號', '計算邏輯與說明', '']])
    .setBackground(THEME_COLORS.PRIMARY_ACCENT)
    .setFontColor(THEME_COLORS.WHITE)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.getRange('F6:G6').merge();

  const cashFlowRows: Array<[string, string, string, string, string, string]> = [
    [
      '總收入（固定收入 + 其他收入）',
      '=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$C$2:$C,"固定收入")+SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$C$2:$C,"其他收入")',
      `=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$C$2:$C,"固定收入")+SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$C$2:$C,"其他收入")`,
      '=IF(B7=0,0,1)',
      '=IF(B7>0,"🟢 正常入帳","⚪ 尚無收入紀錄")',
      '包含薪資、房租收入、獎金與股息',
    ],
    [
      '固定支出與負債（房貸 / 車貸 / 房租）',
      '=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$C$2:$C,"固定支出")',
      `=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$C$2:$C,"固定支出")`,
      '=IF($B$7=0,0,B8/$B$7)',
      '=IF(D8>0.4,"🟠 固定負擔偏高 (>40%)","🟢 穩健")',
      '房貸月付金、車貸月付金等剛性支出',
    ],
    [
      '常態性訂閱扣款（AI / 影音 / 雲端）',
      '=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$C$2:$C,"訂閱扣款")',
      `=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$C$2:$C,"訂閱扣款")`,
      '=IF($B$7=0,0,B9/$B$7)',
      '=IF(B9>5000,"🟡 建議檢視訂閱","🟢 正常")',
      '由 Recurring_Config 每月 1 號自動入帳',
    ],
    [
      '日常花費（手機快速記帳消費）',
      '=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$C$2:$C,"日常花費")',
      `=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$C$2:$C,"日常花費")`,
      '=IF($B$7=0,0,B10/$B$7)',
      '=IF(B10>$B$3,"🔴 超出月預算！",IF(B10>$B$3*0.85,"🟡 接近預算上限","🟢 預算內"))',
      '對照 B3 每月消費預算上限監控超支',
    ],
    [
      '稅金與年度大額支出（月欄=自訂月數攤提 / 年欄=實支）',
      '=IFERROR(SUM(Annual_Sinking_Fund!$F$2:$F),0)',
      `=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$C$2:$C,"稅金與大額")`,
      '=IF($B$7=0,0,B11/$B$7)',
      '=IF(B11>0,"🔵 每月應提撥預備金","⚪ 未設定攤提")',
      '月欄依 Annual_Sinking_Fund 分攤月數計算；年欄為實際支出',
    ],
    [
      '消費性總支出（含月攤提，不含投資流出）',
      '=B8+B9+B10+B11',
      '=C8+C9+C10+C11',
      '=IF($B$7=0,0,B12/$B$7)',
      '=IF(B12>$B$7,"🔴 消費大於收入！","🟢 控管正常")',
      '固定支出 + 訂閱 + 日常花費 + 稅金月攤提',
    ],
    [
      '投資流出（強制儲蓄：台股 / 中信基金）',
      '=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$C$2:$C,"投資流出")',
      `=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$C$2:$C,"投資流出")`,
      '=IF($B$7=0,0,B13/$B$7)',
      '=IF(B13>0,"🟢 持續累積資產","⚪ 本月無投入")',
      '與消費性支出分離，計入真實儲蓄率',
    ],
    [
      '自由淨現金流（總收入 － 消費總支出 － 投資流出）',
      '=B7-B12-B13',
      '=C7-C12-C13',
      '=IF($B$7=0,0,B14/$B$7)',
      '=IF(B14<0,"🔴 現金流赤字！","🟢 正向現金流")',
      '扣除生活費、預備金與投資後的現金存款結餘',
    ],
    [
      '當月實際總支出（含當月實繳稅金，帳面核對）',
      '=B8+B9+B10+SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$C$2:$C,"稅金與大額")',
      '=C12',
      '=IF($B$7=0,0,B15/$B$7)',
      '=IF(B7-B15-B13<0,"🟠 本月帳面流出偏高","🟢 帳面正向")',
      '用於核對銀行帳戶當月實際現金流出',
    ],
  ];

  cashFlowRows.forEach((row, i) => {
    const r = 7 + i;
    sheet.getRange(r, 1).setValue(row[0]);
    sheet.getRange(r, 2).setFormula(row[1]).setNumberFormat('#,##0');
    sheet.getRange(r, 3).setFormula(row[2]).setNumberFormat('#,##0');
    sheet.getRange(r, 4).setFormula(row[3]).setNumberFormat('0.0%');
    sheet.getRange(r, 5).setFormula(row[4]).setHorizontalAlignment('center');
    sheet.getRange(r, 6, 1, 2).merge().setValue(row[5]).setFontColor(THEME_COLORS.TEXT_MUTED).setFontSize(9);
    sheet.setRowHeight(r, 25);
  });

  sheet.getRange('A7:G7').setBackground(THEME_COLORS.TOTAL_BG).setFontWeight('bold');
  sheet.getRange('A12:G12').setBackground(THEME_COLORS.TOTAL_BG).setFontWeight('bold');
  sheet.getRange('A14:G14').setBackground('#E6FFFA').setFontWeight('bold');

  // =========================================================
  // 區塊二：財務健康關鍵指標 KPI (Row 17 - Row 21)
  // =========================================================
  styleSectionBanner(sheet, 17, '【二、財務健康指標與預算警示】');
  sheet
    .getRange('A18:G18')
    .setValues([['關鍵財務指標', '當月 / 現況', '年度 / 目標', '基準參考', '評估結果', '說明', '']])
    .setBackground(THEME_COLORS.PRIMARY_ACCENT)
    .setFontColor(THEME_COLORS.WHITE)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.getRange('F18:G18').merge();

  sheet.getRange('A19').setValue('真實儲蓄率（(投資流出 + 自由淨現金流) / 總收入）').setFontWeight('bold');
  sheet.getRange('B19').setFormula('=IF(B7=0,0,(B13+B14)/B7)').setNumberFormat('0.0%').setFontWeight('bold');
  sheet.getRange('C19').setFormula('=IF(C7=0,0,(C13+C14)/C7)').setNumberFormat('0.0%');
  sheet.getRange('D19').setValue('目標 >= 30%').setHorizontalAlignment('center');
  sheet
    .getRange('E19')
    .setFormula('=IF(B19>=0.3,"🟢 優良 (>=30%)",IF(B19>=0.15,"🟡 達標 (15-30%)","🔴 偏低 (<15%)"))')
    .setHorizontalAlignment('center');
  sheet.getRange('F19:G19').merge().setValue('將台股/基金定期定額正確計入儲蓄，不誤判為消費').setFontColor(THEME_COLORS.TEXT_MUTED).setFontSize(9);

  sheet.getRange('A20').setValue('日常消費預算使用率（日常花費 / 預算上限）').setFontWeight('bold');
  sheet.getRange('B20').setFormula('=IF($B$3=0,0,B10/$B$3)').setNumberFormat('0.0%').setFontWeight('bold');
  sheet.getRange('C20').setFormula('=IF($D$3=0,0,C10/$D$3)').setNumberFormat('0.0%');
  sheet.getRange('D20').setValue('上限 100%').setHorizontalAlignment('center');
  sheet
    .getRange('E20')
    .setFormula('=IF(B20>1,"🔴 超支 "&TEXT(B10-$B$3,"#,##0")&" 元","🟢 尚餘 "&TEXT($B$3-B10,"#,##0")&" 元")')
    .setHorizontalAlignment('center');
  sheet.getRange('F20:G20').merge().setValue('即時追蹤手機日常花費是否超出每月預算').setFontColor(THEME_COLORS.TEXT_MUTED).setFontSize(9);

  sheet.getRange('A21').setValue('緊急預備金可支撐月數（高流動資產 / 月消費總支出）').setFontWeight('bold');
  sheet
    .getRange('B21')
    .setFormula('=IF(B12=0,0,SUMIFS(Assets_Liabilities!$J$2:$J,Assets_Liabilities!$B$2:$B,"資產",Assets_Liabilities!$D$2:$D,"高流動")/B12)')
    .setNumberFormat('0.0" 個月"')
    .setFontWeight('bold');
  sheet.getRange('C21').setFormula('=F3').setNumberFormat('0" 個月"');
  sheet.getRange('D21').setValue('建議 6 個月+').setHorizontalAlignment('center');
  sheet
    .getRange('E21')
    .setFormula('=IF(B21>=$F$3,"🟢 充足（已達標）",IF(B21>=3,"🟡 偏低（建議補足）","🔴 警戒（不足3個月）"))')
    .setHorizontalAlignment('center');
  sheet.getRange('F21:G21').merge().setValue('高流動資產＝台幣定存/活存 + 美金現金').setFontColor(THEME_COLORS.TEXT_MUTED).setFontSize(9);

  // =========================================================
  // 區塊三：整合資產負債與資產配置總覽 (Row 23 - Row 28)
  // =========================================================
  styleSectionBanner(sheet, 23, '【三、整合資產負債總覽（統一換算新台幣 TWD）】');
  sheet
    .getRange('A24:G24')
    .setValues([['資產負債核心指標', '目前金額 (TWD)', '說明 / 狀態', '', '資產配置分類', '市值 (TWD)', '佔總資產比']])
    .setBackground(THEME_COLORS.PRIMARY_ACCENT)
    .setFontColor(THEME_COLORS.WHITE)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  sheet.getRange('A25').setValue('總資產 (TWD)').setFontWeight('bold');
  sheet.getRange('B25').setFormula('=SUMIFS(Assets_Liabilities!$J$2:$J,Assets_Liabilities!$B$2:$B,"資產")').setNumberFormat('#,##0').setFontWeight('bold');
  sheet.getRange('C25').setValue('台股/美金即時自動更新 + 手動快照').setFontSize(9).setFontColor(THEME_COLORS.TEXT_MUTED);

  sheet.getRange('A26').setValue('總負債 (TWD)').setFontWeight('bold');
  sheet.getRange('B26').setFormula('=SUMIFS(Assets_Liabilities!$J$2:$J,Assets_Liabilities!$B$2:$B,"負債")').setNumberFormat('#,##0').setFontColor(THEME_COLORS.DANGER_TEXT);
  sheet.getRange('C26').setValue('房貸餘額 + 車貸餘額').setFontSize(9).setFontColor(THEME_COLORS.TEXT_MUTED);

  sheet.getRange('A27').setValue('淨資產（總資產 － 總負債）').setFontWeight('bold').setBackground('#E6FFFA');
  sheet.getRange('B27').setFormula('=B25-B26').setNumberFormat('#,##0').setFontWeight('bold').setFontSize(11).setBackground('#E6FFFA');
  sheet.getRange('C27').setFormula('=IF(B27>=0,"🟢 正淨資產","🟠 房貸初期負淨資產(含自住屋未計入)")').setHorizontalAlignment('center').setBackground('#E6FFFA');

  sheet.getRange('A28').setValue('負債比率（總負債 / 總資產）');
  sheet.getRange('B28').setFormula('=IF(B25=0,0,B26/B25)').setNumberFormat('0.0%');
  sheet.getRange('C28').setFormula('=IF(B28>0.6,"🟠 槓桿較高 (>60%)","🟢 槓桿可控")').setHorizontalAlignment('center');

  const assetBreakdown: Array<[string, string]> = [
    ['台股（自動抓價）', '=SUMIFS(Assets_Liabilities!$J$2:$J,Assets_Liabilities!$B$2:$B,"資產",Assets_Liabilities!$C$2:$C,"台股")'],
    ['美金與台幣定存/現金', '=SUMIFS(Assets_Liabilities!$J$2:$J,Assets_Liabilities!$B$2:$B,"資產",Assets_Liabilities!$C$2:$C,"美金")+SUMIFS(Assets_Liabilities!$J$2:$J,Assets_Liabilities!$B$2:$B,"資產",Assets_Liabilities!$C$2:$C,"定存/現金")'],
    ['中信基金與結構性商品', '=SUMIFS(Assets_Liabilities!$J$2:$J,Assets_Liabilities!$B$2:$B,"資產",Assets_Liabilities!$C$2:$C,"中信基金")+SUMIFS(Assets_Liabilities!$J$2:$J,Assets_Liabilities!$B$2:$B,"資產",Assets_Liabilities!$C$2:$C,"結構性商品")'],
    ['保單（保價金 / 解約金）', '=SUMIFS(Assets_Liabilities!$J$2:$J,Assets_Liabilities!$B$2:$B,"資產",Assets_Liabilities!$C$2:$C,"保單(保價金)")'],
  ];
  assetBreakdown.forEach((item, idx) => {
    const r = 25 + idx;
    sheet.getRange(r, 5).setValue(item[0]);
    sheet.getRange(r, 6).setFormula(item[1]).setNumberFormat('#,##0');
    sheet.getRange(r, 7).setFormula(`=IF($B$25=0,0,F${r}/$B$25)`).setNumberFormat('0.0%');
  });

  // =========================================================
  // 區塊四：年度 12 個月現金流總覽表 (Row 30 - Row 44)
  // =========================================================
  styleSectionBanner(sheet, 30, '【四、年度 12 個月現金流趨勢表（依 B2 查詢年份自動彙總）】');
  sheet
    .getRange('A31:G31')
    .setValues([['月份', '總收入', '固定+訂閱支出', '日常花費', '稅金/大額(實支)', '投資流出', '當月淨現金流']])
    .setBackground(THEME_COLORS.PRIMARY_ACCENT)
    .setFontColor(THEME_COLORS.WHITE)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  for (let m = 1; m <= 12; m++) {
    const r = 31 + m; // 32..43
    sheet.getRange(r, 1).setFormula(`=TEXT(DATE($B$2,${m},1),"yyyy-mm")`).setHorizontalAlignment('center');
    sheet
      .getRange(r, 2)
      .setFormula(
        `=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$C$2:$C,"固定收入")+SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$C$2:$C,"其他收入")`
      );
    sheet
      .getRange(r, 3)
      .setFormula(
        `=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$C$2:$C,"固定支出")+SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$C$2:$C,"訂閱扣款")`
      );
    sheet
      .getRange(r, 4)
      .setFormula(`=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$C$2:$C,"日常花費")`);
    sheet
      .getRange(r, 5)
      .setFormula(`=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$C$2:$C,"稅金與大額")`);
    sheet
      .getRange(r, 6)
      .setFormula(`=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$C$2:$C,"投資流出")`);
    sheet.getRange(r, 7).setFormula(`=B${r}-C${r}-D${r}-E${r}-F${r}`);
  }

  sheet.getRange('A44').setValue('年度合計').setHorizontalAlignment('center');
  for (let col = 2; col <= 7; col++) {
    const colLetter = String.fromCharCode(64 + col);
    sheet.getRange(44, col).setFormula(`=SUM(${colLetter}32:${colLetter}43)`);
  }
  sheet.getRange('B32:G44').setNumberFormat('#,##0');
  sheet.getRange('A44:G44').setBackground(THEME_COLORS.TOTAL_BG).setFontWeight('bold');

  // =========================================================
  // 區塊五：大項分類月度與年度統計（投資 / 存款 / 收支分項）(Row 46 - Row 63)
  // =========================================================
  styleSectionBanner(sheet, 46, '【五、大項分類別月度與年度統計（投資 / 存款 / 核心收支單獨檢視）】');
  sheet
    .getRange('A47:G47')
    .setValues([['大項分類', '歸屬群組', '當月金額 (TWD)', '年度累計 (TWD)', '年度月均(÷12)', '佔年總收入比', '備註']])
    .setBackground(THEME_COLORS.PRIMARY_ACCENT)
    .setFontColor(THEME_COLORS.WHITE)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  const majorStats: Array<[string, string, string, string, string, boolean]> = [
    [
      '台股投資（定期定額 + 加碼）',
      '投資大項',
      '=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$D$2:$D,"台股投資")+SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$D$2:$D,"台股加碼")',
      `=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$D$2:$D,"台股投資")+SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$D$2:$D,"台股加碼")`,
      '0050 / 個股定期定額與加碼',
      false,
    ],
    [
      '中信基金（定期定額 + 加碼）',
      '投資大項',
      '=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$D$2:$D,"中信基金")+SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$D$2:$D,"中信基金加碼")',
      `=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$D$2:$D,"中信基金")+SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$D$2:$D,"中信基金加碼")`,
      '中信系列基金投入總額',
      false,
    ],
    [
      '其他投資（美股 / ETF / 其他）',
      '投資大項',
      '=MAX(0, B13 - C48 - C49)',
      '=MAX(0, C13 - D48 - D49)',
      '其餘投資流出自動歸類於此',
      false,
    ],
    [
      '▶ 投資大項總計（強制儲蓄）',
      '投資彙總',
      '=B13',
      '=C13',
      '每月與全年度所有投資投入合計',
      true,
    ],
    [
      '現金存款淨增量（自由淨現金流）',
      '存款儲蓄',
      '=B14',
      '=C14',
      '扣除支出與投資後可留存於活存/定存',
      false,
    ],
    [
      '稅金與目標預備金（月提撥 vs 年總額）',
      '存款儲蓄',
      '=B11',
      '=B11*12',
      '應每月轉入專用存款帳戶備用',
      false,
    ],
    [
      '▶ 總儲蓄合計（投資投入 + 現金存款淨增量）',
      '儲蓄彙總',
      '=B13+B14',
      '=C13+C14',
      '衡量真實資產累積速度（對應真實儲蓄率）',
      true,
    ],
    [
      '目前帳面高流動存款存量（定存/活存 + 美金）',
      '存量餘額',
      '=SUMIFS(Assets_Liabilities!$J$2:$J,Assets_Liabilities!$B$2:$B,"資產",Assets_Liabilities!$D$2:$D,"高流動")',
      '=C55',
      '來自 Assets_Liabilities 目前存款總餘額',
      false,
    ],
    [
      '本業薪資收入',
      '收入大項',
      '=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$D$2:$D,"薪資")',
      `=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$D$2:$D,"薪資")`,
      '含每月固定薪資',
      false,
    ],
    [
      '房租收入',
      '收入大項',
      '=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$D$2:$D,"房租收入")',
      `=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$D$2:$D,"房租收入")`,
      '租金收入合計',
      false,
    ],
    [
      '其他收入（獎金 / 股息 / 副業 / 一次性）',
      '收入大項',
      '=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$C$2:$C,"其他收入")',
      `=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$C$2:$C,"其他收入")`,
      '含一次性與排程之其他收入',
      false,
    ],
    [
      '房貸支出',
      '支出大項',
      '=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$D$2:$D,"房貸")',
      `=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$D$2:$D,"房貸")`,
      '房貸月付金累計',
      false,
    ],
    [
      '車貸支出',
      '支出大項',
      '=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$D$2:$D,"車貸")',
      `=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$A$2:$A,${ytdStart},CashFlow_Log!$A$2:$A,${ytdEnd},CashFlow_Log!$D$2:$D,"車貸")`,
      '車貸月付金累計',
      false,
    ],
    [
      '常態訂閱合計（AI / 影音 / 雲端）',
      '支出大項',
      '=B9',
      '=C9',
      '所有訂閱型扣款總和',
      false,
    ],
    [
      '日常花費合計',
      '支出大項',
      '=B10',
      '=C10',
      '餐飲/交通/購物等日常開銷',
      false,
    ],
    [
      '稅金與年度大額（實際支出）',
      '支出大項',
      '=SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,$G$2,CashFlow_Log!$C$2:$C,"稅金與大額")',
      '=C11',
      '實際繳納之各類稅金與保費',
      false,
    ],
  ];

  majorStats.forEach((row, idx) => {
    const r = 48 + idx; // 48..63
    sheet.getRange(r, 1).setValue(row[0]);
    sheet.getRange(r, 2).setValue(row[1]).setHorizontalAlignment('center');
    sheet.getRange(r, 3).setFormula(row[2]).setNumberFormat('#,##0');
    sheet.getRange(r, 4).setFormula(row[3]).setNumberFormat('#,##0');
    sheet.getRange(r, 5).setFormula(`=IF(B${r}="存量餘額", "-", ROUND(D${r}/12, 0))`).setNumberFormat('#,##0');
    sheet.getRange(r, 6).setFormula(`=IF(OR(B${r}="存量餘額",$C$7=0), "-", D${r}/$C$7)`).setNumberFormat('0.0%');
    sheet.getRange(r, 7).setValue(row[4]).setFontColor(THEME_COLORS.TEXT_MUTED).setFontSize(9);
    sheet.setRowHeight(r, 24);
    if (row[5]) {
      sheet.getRange(r, 1, 1, 7).setBackground('#E6FFFA').setFontWeight('bold');
    }
  });

  // =========================================================
  // 區塊六：單一項目 12 個月明細查詢器（互動式下拉）(Row 65 - Row 82)
  // =========================================================
  styleSectionBanner(sheet, 65, '【六、單一項目 12 個月明細查詢器（單獨查看投資 / 存款 / 任意分類各月與年度數字）】');
  sheet.getRange('A66').setValue('選擇要單獨查詢的大項 / 分類').setFontWeight('bold').setBackground(THEME_COLORS.SUBHEADER_BG);
  sheet
    .getRange('B66:C66')
    .merge()
    .setValue('投資流出(全部)')
    .setBackground(THEME_COLORS.INPUT_BG)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(DASHBOARD_DRILLDOWN_OPTIONS, true)
        .setAllowInvalid(true) // 允許直接輸入任意自訂分類名稱（如 餐飲、交通）
        .build()
    );
  sheet
    .getRange('D66:G66')
    .merge()
    .setValue('可下拉選擇大項，或直接輸入 CashFlow_Log 的任意分類名稱（如：餐飲、交通）')
    .setFontColor(THEME_COLORS.TEXT_MUTED)
    .setFontSize(9);
  sheet.setRowHeight(66, 28);

  sheet
    .getRange('A67:G67')
    .setValues([['月份', '選定項目當月金額 (TWD)', '佔該月總收入比', '年度累計至當月 (TWD)', '當月狀態參考', '', '']])
    .setBackground(THEME_COLORS.PRIMARY_ACCENT)
    .setFontColor(THEME_COLORS.WHITE)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.getRange('E67:G67').merge();

  for (let m = 1; m <= 12; m++) {
    const r = 67 + m; // 68..79
    const trendRow = 31 + m; // 對應區塊四第 m 月的列號 (32..43)
    sheet.getRange(r, 1).setFormula(`=TEXT(DATE($B$2,${m},1),"yyyy-mm")`).setHorizontalAlignment('center');

    const drillFormula =
      `=SWITCH($B$66,` +
      `"投資流出(全部)", SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$C$2:$C,"投資流出"),` +
      `"台股投資", SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$D$2:$D,"台股投資")+SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$D$2:$D,"台股加碼"),` +
      `"中信基金", SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$D$2:$D,"中信基金")+SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$D$2:$D,"中信基金加碼"),` +
      `"總儲蓄(投資+存款結餘)", F${trendRow}+G${trendRow},` +
      `"現金存款淨增量", G${trendRow},` +
      `"薪資", SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$D$2:$D,"薪資"),` +
      `"房租收入", SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$D$2:$D,"房租收入"),` +
      `"其他收入", SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$C$2:$C,"其他收入"),` +
      `"房貸", SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$D$2:$D,"房貸"),` +
      `"車貸", SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$D$2:$D,"車貸"),` +
      `"訂閱扣款", SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$C$2:$C,"訂閱扣款"),` +
      `"日常花費", SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$C$2:$C,"日常花費"),` +
      `"稅金與大額", SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$C$2:$C,"稅金與大額"),` +
      `SUMIFS(CashFlow_Log!$H$2:$H,CashFlow_Log!$B$2:$B,A${r},CashFlow_Log!$D$2:$D,$B$66))`;

    sheet.getRange(r, 2).setFormula(drillFormula).setNumberFormat('#,##0');
    sheet.getRange(r, 3).setFormula(`=IF(B${trendRow}=0, 0, B${r}/B${trendRow})`).setNumberFormat('0.0%');
    sheet.getRange(r, 4).setFormula(`=SUM($B$68:B${r})`).setNumberFormat('#,##0');
    sheet
      .getRange(r, 5, 1, 3)
      .merge()
      .setFormula(`=IF(B${r}=0,"—",IF(B${r}<0,"⚠️ 當月為負值","✅ 正常紀錄"))`)
      .setHorizontalAlignment('center');
  }

  // Row 80: 年度總計 / Row 81: 年度月均
  sheet.getRange('A80').setValue('年度總計').setHorizontalAlignment('center');
  sheet.getRange('B80').setFormula('=SUM(B68:B79)').setNumberFormat('#,##0');
  sheet.getRange('C80').setFormula('=IF($C$7=0,0,B80/$C$7)').setNumberFormat('0.0%');
  sheet.getRange('D80').setFormula('=B80').setNumberFormat('#,##0');
  sheet.getRange('E80:G80').merge().setFormula('=$B$66 & " 全年合計"').setHorizontalAlignment('center');
  sheet.getRange('A80:G80').setBackground(THEME_COLORS.TOTAL_BG).setFontWeight('bold');

  sheet.getRange('A81').setValue('年度月均 (÷12)').setHorizontalAlignment('center');
  sheet.getRange('B81').setFormula('=ROUND(B80/12,0)').setNumberFormat('#,##0');
  sheet.getRange('C81').setFormula('=C80').setNumberFormat('0.0%');
  sheet.getRange('D81').setValue('-').setHorizontalAlignment('center');
  sheet.getRange('E81:G81').merge().setFormula('=$B$66 & " 平均每月金額"').setHorizontalAlignment('center');
  sheet.getRange('A81:G81').setBackground(THEME_COLORS.ZEBRA_BG);

  // 格線與欄寬
  const borderRanges = [
    'A2:G3',
    'A6:G15',
    'A18:G21',
    'A24:C28',
    'E24:G28',
    'A31:G44',
    'A47:G63',
    'A66:G81',
  ];
  borderRanges.forEach((a1) => {
    sheet.getRange(a1).setBorder(true, true, true, true, true, true, THEME_COLORS.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  });

  const widths = [330, 145, 145, 125, 195, 145, 150];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  // 條件式格式
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberLessThan(0)
      .setBackground(THEME_COLORS.DANGER_BG)
      .setFontColor(THEME_COLORS.DANGER_TEXT)
      .setBold(true)
      .setRanges([sheet.getRange('B14:C14'), sheet.getRange('G32:G44'), sheet.getRange('B68:B80')])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=D32>$B$3')
      .setBackground(THEME_COLORS.DANGER_BG)
      .setFontColor(THEME_COLORS.DANGER_TEXT)
      .setBold(true)
      .setRanges([sheet.getRange('D32:D43')])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=B10>$B$3')
      .setBackground(THEME_COLORS.DANGER_BG)
      .setFontColor(THEME_COLORS.DANGER_TEXT)
      .setBold(true)
      .setRanges([sheet.getRange('B10')])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains('🔴')
      .setBackground(THEME_COLORS.DANGER_BG)
      .setFontColor(THEME_COLORS.DANGER_TEXT)
      .setBold(true)
      .setRanges([sheet.getRange('E7:E15'), sheet.getRange('E19:E21')])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains('🟡')
      .setBackground(THEME_COLORS.WARNING_BG)
      .setFontColor(THEME_COLORS.WARNING_TEXT)
      .setRanges([sheet.getRange('E7:E15'), sheet.getRange('E19:E21')])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains('🟢')
      .setBackground(THEME_COLORS.SUCCESS_BG)
      .setFontColor(THEME_COLORS.SUCCESS_TEXT)
      .setRanges([sheet.getRange('E7:E15'), sheet.getRange('E19:E21')])
      .build(),
  ]);

  // 嵌入年度 12 個月現金流圖表於右側 (Column I)
  const cashflowChart = sheet
    .newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(sheet.getRange('A31:B43'))
    .addRange(sheet.getRange('C31:D43'))
    .addRange(sheet.getRange('F31:G43'))
    .setOption('title', '年度各月收支與投資現金流總覽 (TWD)')
    .setOption('legend', { position: 'bottom' })
    .setOption('colors', ['#16A34A', '#F97316', '#EF4444', '#2563EB', '#0D9488'])
    .setPosition(5, 9, 10, 0)
    .setOption('width', 640)
    .setOption('height', 380)
    .build();
  sheet.insertChart(cashflowChart);

  sheet.setFrozenRows(1);
}

function styleSectionBanner(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  row: number,
  title: string
): void {
  sheet
    .getRange(row, 1, 1, 7)
    .merge()
    .setValue(title)
    .setBackground(THEME_COLORS.SECTION_BG)
    .setFontColor(THEME_COLORS.PRIMARY_DARK)
    .setFontWeight('bold')
    .setFontSize(11)
    .setVerticalAlignment('middle');
  sheet.setRowHeight(row, 28);
}
