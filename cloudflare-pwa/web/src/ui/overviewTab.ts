import {
  aggregatePeriodMetrics,
  computeMonthlyTrend,
  computeNetWorthSummary,
  computeSinkingMonthlyReserve,
} from '../../../shared/calculations';
import { el, fmtMoney } from './helpers';
import { getSelectedYearMonth } from './logTab';
import type { UiContext } from './state';

export function renderOverviewTab(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const year = ctx.state.selectedYear;
  const month = ctx.state.selectedMonth;
  const ym = getSelectedYearMonth(year, month);

  el('overviewMonthLabel').textContent = ym;

  const activeLogs = snap.cashflowLogs.filter((l) => !l.deletedAt);
  const monthLogs = activeLogs.filter((l) => l.yearMonth === ym);
  const yearLogs = activeLogs.filter((l) => l.yearMonth.startsWith(`${year}-`));

  const monthlySinking = snap.sinkingItems
    .filter((s) => !s.deletedAt)
    .reduce((sum, s) => sum + computeSinkingMonthlyReserve(s), 0);

  const monthly = aggregatePeriodMetrics(monthLogs, monthlySinking, true);
  const yearly = aggregatePeriodMetrics(yearLogs, monthlySinking * 12, false);
  const nw = computeNetWorthSummary(
    snap.assetItems,
    snap.settings.usdTwdRate,
    monthly.totalConsumption,
    snap.cashflowLogs,
    snap.savingsAdjustments || [],
    snap.stockTransactions || []
  );

  const m = ctx.state.overviewPeriod === 'monthly' ? monthly : yearly;
  const kpiGrid = el('overviewKpis');
  kpiGrid.innerHTML = '';

  const kpis = [
    { label: '總收入', val: fmtMoney(m.totalIncome, ctx.state.masked), cls: 'pos' },
    { label: '消費性總支出', val: fmtMoney(m.totalConsumption, ctx.state.masked), cls: '' },
    { label: '投資流出（強制儲蓄）', val: fmtMoney(m.investment, ctx.state.masked), cls: 'inv' },
    {
      label: '真實儲蓄率',
      val: ctx.state.masked ? '••%' : `${m.savingsRate.toFixed(1)}%`,
      cls: m.savingsRate >= 30 ? 'pos' : m.savingsRate < 10 ? 'neg' : '',
    },
    {
      label: '自由現金流',
      val: fmtMoney(m.freeCashFlow, ctx.state.masked),
      cls: m.freeCashFlow >= 0 ? 'pos' : 'neg',
    },
    {
      label: '緊急預備金可支撐',
      val: ctx.state.masked ? '•• 個月' : `${nw.emergencyMonths.toFixed(1)} 個月`,
      cls: nw.emergencyMonths >= snap.settings.emergencyTargetMonths ? 'pos' : 'neg',
    },
  ];

  for (const k of kpis) {
    const box = document.createElement('div');
    box.className = 'kpi-box';
    const lbl = document.createElement('div');
    lbl.className = 'kpi-label';
    lbl.textContent = k.label;
    const val = document.createElement('div');
    val.className = 'kpi-val ' + k.cls;
    val.textContent = k.val;
    box.appendChild(lbl);
    box.appendChild(val);
    kpiGrid.appendChild(box);
  }

  const tbody = el('majorStatsBody');
  tbody.innerHTML = '';
  const rows: Array<[string, number, number, boolean?]> = [
    ['薪資收入', monthly.salary, yearly.salary],
    ['房租 / 其他收入', monthly.rentIncome + monthly.otherIncome, yearly.rentIncome + yearly.otherIncome],
    ['房貸 / 車貸固定支出', monthly.fixedExpense, yearly.fixedExpense],
    ['常態性訂閱扣款', monthly.subscription, yearly.subscription],
    ['日常花費', monthly.dailyExpense, yearly.dailyExpense],
    ['稅金攤提(月) / 實支(年)', monthly.sinkingReserve, yearly.taxLargeActual],
    ['台股定期定額 / 加碼', monthly.investmentStock, yearly.investmentStock],
    ['中信基金 / 其他投資', monthly.investmentFund + monthly.investmentOther, yearly.investmentFund + yearly.investmentOther],
    ['總儲蓄（投資＋結餘）', monthly.totalSavings, yearly.totalSavings, true],
  ];

  for (const [label, mv, yv, isTotal] of rows) {
    const tr = document.createElement('tr');
    if (isTotal) tr.className = 'total-row';
    const td1 = document.createElement('td');
    td1.textContent = label;
    const td2 = document.createElement('td');
    td2.className = 'num';
    td2.textContent = fmtMoney(mv, ctx.state.masked, '');
    const td3 = document.createElement('td');
    td3.className = 'num';
    td3.textContent = fmtMoney(yv, ctx.state.masked, '');
    tr.appendChild(td1);
    tr.appendChild(td2);
    tr.appendChild(td3);
    tbody.appendChild(tr);
  }

  el<HTMLInputElement>('budgetInput').value = String(snap.settings.monthlyDailyBudget);
  el<HTMLInputElement>('emergencyInput').value = String(snap.settings.emergencyTargetMonths);

  renderTrendChart(ctx);
}

export function renderTrendChart(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const year = ctx.state.selectedYear;
  const trend = computeMonthlyTrend(snap.cashflowLogs, year);
  const metric = ctx.state.chartMetric;
  const values = trend.map((p) => p[metric]);
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));

  el('chartTitle').textContent = `${year} 年 12 個月趨勢`;
  const chart = el('trendBarChart');
  chart.innerHTML = '';

  const curPoint = trend[ctx.state.selectedMonth - 1];
  const metricLabels: Record<string, string> = {
    netCashFlow: '淨現金流',
    investment: '投資流出',
    totalSavings: '總儲蓄',
    daily: '日常花費',
    income: '總收入',
  };
  el('chartSummaryHint').textContent = curPoint
    ? `${curPoint.ym} ${metricLabels[metric]}：${fmtMoney(curPoint[metric], ctx.state.masked)}`
    : '';

  for (const pt of trend) {
    const val = pt[metric];
    const pct = Math.max(5, Math.round((Math.abs(val) / maxAbs) * 100));
    const isCur = pt.month === ctx.state.selectedMonth;

    const col = document.createElement('div');
    col.className = 'bar-col';
    const track = document.createElement('div');
    track.className = 'bar-track';
    const rect = document.createElement('div');
    rect.className = 'bar-rect' + (val < 0 ? ' neg' : '') + (isCur ? ' cur' : '');
    rect.style.height = `${pct}%`;
    track.appendChild(rect);

    const lbl = document.createElement('div');
    lbl.className = 'bar-lbl' + (isCur ? ' cur' : '');
    lbl.textContent = `${pt.month}月`;

    col.appendChild(track);
    col.appendChild(lbl);
    col.addEventListener('click', () => {
      ctx.state.selectedMonth = pt.month;
      ctx.state.ledgerPage = 1;
      ctx.renderAll();
    });
    chart.appendChild(col);
  }
}
