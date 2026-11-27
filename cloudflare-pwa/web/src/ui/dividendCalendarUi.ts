import { computeDividendCalendar } from '../../../shared/analytics';
import { aggregatePeriodMetrics, filterCashFlowsByLedgerScope } from '../../../shared/calculations';
import { fmtMoney, fmtPct, fmtRaw } from './helpers';
import { getActiveLedgers } from './ledgerUi';
import type { UiContext } from './state';

function estimateMonthlyConsumptionTwd(ctx: UiContext, year: number): number {
  const snap = ctx.engine.getSnapshot();
  const ledgers = getActiveLedgers(ctx);
  const netWorthLogs = filterCashFlowsByLedgerScope(snap.cashflowLogs, 'net_worth', ledgers);
  const yearLogs = netWorthLogs.filter((l) => l.yearMonth.startsWith(`${year}-`));
  if (!yearLogs.length) return 0;
  const distinctMonths = new Set(yearLogs.map((l) => l.yearMonth)).size;
  if (distinctMonths <= 0) return 0;
  const metrics = aggregatePeriodMetrics(yearLogs, 0, false);
  return Math.round(metrics.totalConsumption / distinctMonths);
}

export function renderDividendCalendarCard(ctx: UiContext, container: HTMLElement): void {
  const snap = ctx.engine.getSnapshot();
  const masked = ctx.state.masked;
  const rate = snap.settings.usdTwdRate || 32.5;
  const year = ctx.state.dividendCalendarYear || ctx.state.selectedYear;
  const monthlyCons = estimateMonthlyConsumptionTwd(ctx, year);

  const cal = computeDividendCalendar(
    snap.assetItems,
    snap.stockTransactions || [],
    rate,
    year,
    monthlyCons
  );

  container.innerHTML = '';
  // Show card whenever user has at least 1 holding or any dividend record
  const hasAnyHolding = snap.assetItems.some(
    (a) => !a.deletedAt && !a.isWatchlist && (a.subCategory === '台股' || a.subCategory === '美股/ETF')
  );
  if (!hasAnyHolding && cal.txCount === 0 && cal.availableYears.length <= 1) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';

  // Header + Year switcher
  const head = document.createElement('div');
  head.className = 'card-header';
  head.style.marginBottom = '10px';

  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = '持股配息月曆';
  const sub = document.createElement('div');
  sub.className = 'muted';
  sub.textContent = '點擊月份柱狀檢視各檔配息明細';
  titleWrap.appendChild(title);
  titleWrap.appendChild(sub);

  const yearSel = document.createElement('select');
  yearSel.className = 'div-year-select tnum';
  yearSel.setAttribute('aria-label', '選擇配息年份');
  for (const y of cal.availableYears) {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = `${y} 年`;
    if (y === cal.year) opt.selected = true;
    yearSel.appendChild(opt);
  }
  yearSel.addEventListener('change', () => {
    ctx.state.dividendCalendarYear = Number(yearSel.value) || year;
    ctx.state.dividendCalendarSelectedMonth = null;
    renderDividendCalendarCard(ctx, container);
  });

  head.appendChild(titleWrap);
  head.appendChild(yearSel);
  container.appendChild(head);

  // KPI strip
  const kpiRow = document.createElement('div');
  kpiRow.className = 'nw-detail-grid tnum';
  const kpis: Array<[string, string, string]> = [
    ['全年累計配息', fmtMoney(cal.annualTotalTwd, masked), cal.annualTotalTwd > 0 ? 'pos' : ''],
    ['月均被動收入', fmtMoney(cal.monthlyAverageTwd, masked), 'inv'],
    [
      '月均消費覆蓋率',
      cal.expenseCoveragePct !== null
        ? masked
          ? '••%'
          : fmtPct(cal.expenseCoveragePct, 1)
        : '--',
      cal.expenseCoveragePct !== null && cal.expenseCoveragePct >= 10 ? 'pos' : '',
    ],
  ];
  for (const [k, v, cls] of kpis) {
    const cell = document.createElement('div');
    cell.className = 'nw-detail-cell';
    const kl = document.createElement('span');
    kl.className = 'ledger-summary-k';
    kl.textContent = k;
    const vl = document.createElement('strong');
    vl.className = 'ledger-summary-v' + (cls ? ' ' + cls : '');
    vl.textContent = v;
    cell.appendChild(kl);
    cell.appendChild(vl);
    kpiRow.appendChild(cell);
  }
  container.appendChild(kpiRow);

  if (cal.txCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.cssText = 'text-align:center;padding:12px 4px;font-size:12.5px';
    empty.textContent = `${cal.year} 年尚無現金配息紀錄，可於持股卡片點「配息」登錄`;
    container.appendChild(empty);
    return;
  }

  // Pick default selected month (peak month if none selected)
  const selectedMonth =
    ctx.state.dividendCalendarSelectedMonth && ctx.state.dividendCalendarSelectedMonth >= 1 && ctx.state.dividendCalendarSelectedMonth <= 12
      ? ctx.state.dividendCalendarSelectedMonth
      : cal.peakMonth || 1;

  // 12-month bar chart
  const barsWrap = document.createElement('div');
  barsWrap.className = 'div-bars-grid tnum';
  const maxVal = Math.max(1, cal.maxMonthTwd);

  for (const bucket of cal.months) {
    const col = document.createElement('button');
    col.type = 'button';
    col.className =
      'div-bar-col' +
      (bucket.month === selectedMonth ? ' active' : '') +
      (bucket.totalTwd > 0 ? ' has-val' : '');
    col.setAttribute('aria-label', `${bucket.month} 月配息 ${fmtMoney(bucket.totalTwd, masked)}`);

    const valLabel = document.createElement('span');
    valLabel.className = 'div-bar-val';
    if (bucket.totalTwd > 0 && !masked) {
      valLabel.textContent =
        bucket.totalTwd >= 10_000
          ? `${(bucket.totalTwd / 1000).toFixed(1)}k`
          : String(Math.round(bucket.totalTwd));
    }

    const track = document.createElement('div');
    track.className = 'div-bar-track';
    const fill = document.createElement('div');
    fill.className = 'div-bar-fill';
    const pct = bucket.totalTwd > 0 ? Math.max(8, Math.round((bucket.totalTwd / maxVal) * 100)) : 0;
    fill.style.height = `${pct}%`;
    track.appendChild(fill);

    const mLabel = document.createElement('span');
    mLabel.className = 'div-bar-month';
    mLabel.textContent = `${bucket.month}月`;

    col.appendChild(valLabel);
    col.appendChild(track);
    col.appendChild(mLabel);
    col.addEventListener('click', () => {
      ctx.state.dividendCalendarSelectedMonth = bucket.month;
      renderDividendCalendarCard(ctx, container);
    });
    barsWrap.appendChild(col);
  }
  container.appendChild(barsWrap);

  // Selected month detail items
  const selBucket = cal.months[selectedMonth - 1];
  const detailBox = document.createElement('div');
  detailBox.className = 'nw-detail-strip tnum';
  const dHead = document.createElement('div');
  dHead.className = 'nw-detail-head';
  const dTitle = document.createElement('strong');
  dTitle.textContent = `${cal.year} 年 ${selBucket.month} 月配息明細`;
  const dSum = document.createElement('strong');
  dSum.style.color = selBucket.totalTwd > 0 ? 'var(--pos)' : 'var(--text-muted)';
  dSum.textContent = fmtMoney(selBucket.totalTwd, masked);
  dHead.appendChild(dTitle);
  dHead.appendChild(dSum);
  detailBox.appendChild(dHead);

  if (!selBucket.items.length) {
    const none = document.createElement('div');
    none.className = 'muted';
    none.style.fontSize = '12px';
    none.textContent = '本月無配息入帳';
    detailBox.appendChild(none);
  } else {
    const list = document.createElement('div');
    list.className = 'div-detail-list';
    for (const item of selBucket.items) {
      const row = document.createElement('div');
      row.className = 'div-detail-row';
      const left = document.createElement('div');
      const name = document.createElement('div');
      name.style.fontWeight = '600';
      name.textContent = item.ticker ? `${item.assetName} (${item.ticker})` : item.assetName;
      const meta = document.createElement('div');
      meta.className = 'muted';
      meta.style.fontSize = '11px';
      meta.textContent = `${item.date}${item.currency === 'USD' ? ` · 原幣 ${fmtRaw(item.rawAmount, 'USD', masked)}` : ''}${item.note ? ` · ${item.note}` : ''}`;
      left.appendChild(name);
      left.appendChild(meta);

      const amt = document.createElement('strong');
      amt.style.color = 'var(--pos)';
      amt.textContent = `+${fmtMoney(item.twdAmount, masked)}`;
      row.appendChild(left);
      row.appendChild(amt);
      list.appendChild(row);
    }
    detailBox.appendChild(list);
  }
  container.appendChild(detailBox);
}
