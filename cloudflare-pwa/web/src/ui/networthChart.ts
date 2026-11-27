import { computeNetWorthTrendSeries, type NetWorthTrendPoint } from '../../../shared/analytics';
import { fmtMoney, fmtPct } from './helpers';
import type { UiContext } from './state';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  return node;
}

function shortMoneyAxis(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 100_000_000) return `${sign}${(abs / 100_000_000).toFixed(1)}億`;
  if (abs >= 10_000) return `${sign}${Math.round(abs / 10_000)}萬`;
  return `${sign}${Math.round(abs)}`;
}

function buildLineChartSvg(
  points: NetWorthTrendPoint[],
  selectedYm: string | null,
  masked: boolean,
  onSelect: (ym: string) => void
): SVGSVGElement {
  const W = 360;
  const H = 176;
  const padL = 44;
  const padR = 14;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'nw-svg',
    role: 'img',
    'aria-label': '淨資產歷史折線圖',
  });

  const allVals: number[] = [];
  for (const p of points) {
    allVals.push(p.netWorth, p.totalAssets, p.totalLiabilities);
  }
  let minVal = Math.min(...allVals, 0);
  let maxVal = Math.max(...allVals, 1);
  if (maxVal === minVal) {
    maxVal = minVal + 1;
  }
  const span = maxVal - minVal;
  // Add slight top headroom
  maxVal += span * 0.08;
  if (minVal < 0) minVal -= span * 0.06;
  const finalSpan = Math.max(1, maxVal - minVal);

  const xAt = (i: number) =>
    points.length <= 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW;
  const yAt = (v: number) => padT + plotH - ((v - minVal) / finalSpan) * plotH;

  // Horizontal grid lines (3 ticks)
  for (let t = 0; t <= 2; t++) {
    const val = minVal + (finalSpan * t) / 2;
    const y = yAt(val);
    svg.appendChild(
      svgEl('line', {
        x1: padL,
        y1: y.toFixed(1),
        x2: W - padR,
        y2: y.toFixed(1),
        stroke: 'var(--sep)',
        'stroke-width': 0.8,
      })
    );
    if (!masked) {
      const lbl = svgEl('text', {
        x: padL - 6,
        y: (y + 3.5).toFixed(1),
        'text-anchor': 'end',
        class: 'nw-axis-text',
      });
      lbl.textContent = shortMoneyAxis(val);
      svg.appendChild(lbl);
    }
  }

  // Zero baseline when negative net worth exists (hidden when masked so sign is not leaked)
  if (!masked && minVal < 0 && maxVal > 0) {
    const y0 = yAt(0);
    svg.appendChild(
      svgEl('line', {
        x1: padL,
        y1: y0.toFixed(1),
        x2: W - padR,
        y2: y0.toFixed(1),
        stroke: 'var(--text-muted)',
        'stroke-width': 1,
        'stroke-dasharray': '3 3',
      })
    );
  }

  const makePath = (getter: (p: NetWorthTrendPoint) => number) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(getter(p)).toFixed(1)}`).join(' ');

  if (points.length >= 2) {
    // Soft fill under Net Worth line
    const nwAreaPath =
      `${makePath((p) => p.netWorth)} L ${xAt(points.length - 1).toFixed(1)} ${yAt(Math.max(0, minVal)).toFixed(1)} ` +
      `L ${xAt(0).toFixed(1)} ${yAt(Math.max(0, minVal)).toFixed(1)} Z`;
    svg.appendChild(
      svgEl('path', {
        d: nwAreaPath,
        fill: 'var(--primary-soft)',
        opacity: 0.7,
      })
    );

    // Total assets (dashed green/pos)
    svg.appendChild(
      svgEl('path', {
        d: makePath((p) => p.totalAssets),
        fill: 'none',
        stroke: 'var(--pos-bar)',
        'stroke-width': 1.4,
        'stroke-dasharray': '4 3',
        opacity: 0.75,
      })
    );

    // Total liabilities (dashed red/neg, only if any > 0)
    if (points.some((p) => p.totalLiabilities > 0)) {
      svg.appendChild(
        svgEl('path', {
          d: makePath((p) => p.totalLiabilities),
          fill: 'none',
          stroke: 'var(--neg-bar)',
          'stroke-width': 1.3,
          'stroke-dasharray': '3 3',
          opacity: 0.7,
        })
      );
    }

    // Net Worth main solid line
    svg.appendChild(
      svgEl('path', {
        d: makePath((p) => p.netWorth),
        fill: 'none',
        stroke: 'var(--primary)',
        'stroke-width': 2.4,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      })
    );
  }

  // X-axis labels (first, middle, last) + clickable dots
  const labelIndices = new Set<number>([0, points.length - 1]);
  if (points.length >= 5) labelIndices.add(Math.floor((points.length - 1) / 2));

  points.forEach((p, i) => {
    const cx = xAt(i);
    const cy = yAt(p.netWorth);
    const isSel = p.yearMonth === selectedYm;

    if (labelIndices.has(i)) {
      const xl = svgEl('text', {
        x: cx.toFixed(1),
        y: H - 6,
        'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle',
        class: 'nw-axis-text',
      });
      xl.textContent = p.yearMonth.slice(2); // YY-MM
      svg.appendChild(xl);
    }

    if (isSel) {
      svg.appendChild(
        svgEl('line', {
          x1: cx.toFixed(1),
          y1: padT,
          x2: cx.toFixed(1),
          y2: H - padB,
          stroke: 'var(--primary)',
          'stroke-width': 1,
          'stroke-dasharray': '2 2',
          opacity: 0.6,
        })
      );
    }

    svg.appendChild(
      svgEl('circle', {
        cx: cx.toFixed(1),
        cy: cy.toFixed(1),
        r: isSel ? 4.8 : 3.2,
        fill: isSel ? 'var(--primary)' : 'var(--surface)',
        stroke: 'var(--primary)',
        'stroke-width': isSel ? 2 : 1.8,
      })
    );

    const leftX = i === 0 ? padL : (xAt(i - 1) + cx) / 2;
    const rightX = i === points.length - 1 ? W - padR : (cx + xAt(i + 1)) / 2;
    const hit = svgEl('rect', {
      x: leftX.toFixed(1),
      y: padT,
      width: Math.max(1, rightX - leftX).toFixed(1),
      height: plotH,
      fill: 'transparent',
      style: 'cursor:pointer',
    });
    hit.addEventListener('click', () => onSelect(p.yearMonth));
    svg.appendChild(hit);
  });

  return svg;
}

function buildStackedAreaSvg(
  points: NetWorthTrendPoint[],
  selectedYm: string | null,
  masked: boolean,
  onSelect: (ym: string) => void
): SVGSVGElement {
  const W = 360;
  const H = 176;
  const padL = 44;
  const padR = 14;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'nw-svg',
    role: 'img',
    'aria-label': '資產結構堆疊面積圖',
  });

  const maxTotal = Math.max(
    1,
    ...points.map((p) => p.highLiquidityAssets + p.investmentAssets + p.insuranceAssets + p.otherAssets)
  ) * 1.08;

  const xAt = (i: number) =>
    points.length <= 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW;
  const yAt = (v: number) => padT + plotH - (v / maxTotal) * plotH;

  for (let t = 0; t <= 2; t++) {
    const val = (maxTotal * t) / 2;
    const y = yAt(val);
    svg.appendChild(
      svgEl('line', {
        x1: padL,
        y1: y.toFixed(1),
        x2: W - padR,
        y2: y.toFixed(1),
        stroke: 'var(--sep)',
        'stroke-width': 0.8,
      })
    );
    if (!masked) {
      const lbl = svgEl('text', {
        x: padL - 6,
        y: (y + 3.5).toFixed(1),
        'text-anchor': 'end',
        class: 'nw-axis-text',
      });
      lbl.textContent = shortMoneyAxis(val);
      svg.appendChild(lbl);
    }
  }

  const layers: Array<{ color: string; getter: (p: NetWorthTrendPoint) => number }> = [
    { color: '#34C759', getter: (p) => p.highLiquidityAssets },
    { color: '#4E8FE6', getter: (p) => p.investmentAssets },
    { color: '#5856D6', getter: (p) => p.insuranceAssets },
    { color: '#8E8E93', getter: (p) => p.otherAssets },
  ];

  const base = points.map(() => 0);
  if (points.length >= 2) {
    for (const layer of layers) {
      const top = points.map((p, i) => base[i] + layer.getter(p));
      const hasAny = top.some((v, i) => v > base[i]);
      if (hasAny) {
        const topPath = top.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`).join(' ');
        const botPath = base
          .map((v, i) => `L ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`)
          .reverse()
          .join(' ');
        svg.appendChild(
          svgEl('path', {
            d: `${topPath} ${botPath} Z`,
            fill: layer.color,
            opacity: 0.72,
          })
        );
      }
      for (let i = 0; i < base.length; i++) base[i] = top[i];
    }
  } else if (points.length === 1) {
    const p = points[0];
    const barW = 42;
    const x = xAt(0) - barW / 2;
    let cur = 0;
    for (const layer of layers) {
      const val = layer.getter(p);
      if (val <= 0) continue;
      const yTop = yAt(cur + val);
      const yBot = yAt(cur);
      svg.appendChild(
        svgEl('rect', {
          x: x.toFixed(1),
          y: yTop.toFixed(1),
          width: barW,
          height: Math.max(1, yBot - yTop).toFixed(1),
          fill: layer.color,
          opacity: 0.8,
        })
      );
      cur += val;
    }
  }

  const labelIndices = new Set<number>([0, points.length - 1]);
  if (points.length >= 5) labelIndices.add(Math.floor((points.length - 1) / 2));

  points.forEach((p, i) => {
    const cx = xAt(i);
    const total = p.highLiquidityAssets + p.investmentAssets + p.insuranceAssets + p.otherAssets;
    const isSel = p.yearMonth === selectedYm;

    if (labelIndices.has(i)) {
      const xl = svgEl('text', {
        x: cx.toFixed(1),
        y: H - 6,
        'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle',
        class: 'nw-axis-text',
      });
      xl.textContent = p.yearMonth.slice(2);
      svg.appendChild(xl);
    }

    if (isSel) {
      svg.appendChild(
        svgEl('line', {
          x1: cx.toFixed(1),
          y1: padT,
          x2: cx.toFixed(1),
          y2: H - padB,
          stroke: 'var(--text)',
          'stroke-width': 1.2,
          'stroke-dasharray': '2 2',
          opacity: 0.7,
        })
      );
    }

    const leftX = i === 0 ? padL : (xAt(i - 1) + cx) / 2;
    const rightX = i === points.length - 1 ? W - padR : (cx + xAt(i + 1)) / 2;
    const hit = svgEl('rect', {
      x: leftX.toFixed(1),
      y: padT,
      width: Math.max(1, rightX - leftX).toFixed(1),
      height: plotH,
      fill: 'transparent',
      style: 'cursor:pointer',
    });
    hit.addEventListener('click', () => onSelect(p.yearMonth));
    svg.appendChild(hit);

    if (isSel) {
      svg.appendChild(
        svgEl('circle', {
          cx: cx.toFixed(1),
          cy: yAt(total).toFixed(1),
          r: 4,
          fill: 'var(--text)',
        })
      );
    }
  });

  return svg;
}

export function renderNetWorthChartCard(ctx: UiContext, container: HTMLElement): void {
  const snap = ctx.engine.getSnapshot();
  const masked = ctx.state.masked;
  const range = ctx.state.networthChartRange;
  const mode = ctx.state.networthChartMode;
  const trend = computeNetWorthTrendSeries(snap.netWorthHistory || [], range);

  container.innerHTML = '';
  if (!trend.points.length) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';

  const latestYm = trend.points[trend.points.length - 1].yearMonth;
  if (!ctx.state.networthChartSelectedYm || !trend.points.some((p) => p.yearMonth === ctx.state.networthChartSelectedYm)) {
    ctx.state.networthChartSelectedYm = latestYm;
  }
  const selectedPoint =
    trend.points.find((p) => p.yearMonth === ctx.state.networthChartSelectedYm) ||
    trend.points[trend.points.length - 1];

  // Header
  const head = document.createElement('div');
  head.className = 'card-header';
  head.style.marginBottom = '8px';

  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = '淨資產歷史走勢';
  const sub = document.createElement('div');
  sub.className = 'muted tnum';
  if (trend.points.length >= 2) {
    const sign = trend.deltaAmount > 0 ? '+' : '';
    const pctPart = trend.deltaPct !== null && !masked ? ` (${fmtPct(trend.deltaPct, 1, true)})` : '';
    sub.textContent = masked
      ? `期間變化：•••••`
      : `期間變化：${sign}${fmtMoney(trend.deltaAmount, false)}${pctPart}`;
    sub.style.color = masked
      ? 'var(--text-secondary)'
      : trend.deltaAmount > 0
        ? 'var(--pos)'
        : trend.deltaAmount < 0
          ? 'var(--neg)'
          : 'var(--text-secondary)';
  } else {
    sub.textContent = '累積 2 期以上快照即可檢視成長曲線';
  }
  titleWrap.appendChild(title);
  titleWrap.appendChild(sub);

  const controls = document.createElement('div');
  controls.className = 'nw-chart-controls';

  const modeSeg = document.createElement('div');
  modeSeg.className = 'mini-seg';
  for (const [val, label] of [
    ['line', '折線'],
    ['area', '堆疊'],
  ] as const) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini-seg-btn' + (mode === val ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      ctx.state.networthChartMode = val;
      renderNetWorthChartCard(ctx, container);
    });
    modeSeg.appendChild(btn);
  }

  const rangeSeg = document.createElement('div');
  rangeSeg.className = 'mini-seg';
  for (const [val, label] of [
    ['12m', '12月'],
    ['all', '全部'],
  ] as const) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini-seg-btn' + (range === val ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      ctx.state.networthChartRange = val;
      renderNetWorthChartCard(ctx, container);
    });
    rangeSeg.appendChild(btn);
  }

  controls.appendChild(modeSeg);
  controls.appendChild(rangeSeg);
  head.appendChild(titleWrap);
  head.appendChild(controls);
  container.appendChild(head);

  // Legend
  const legend = document.createElement('div');
  legend.className = 'nw-legend';
  const legendItems =
    mode === 'line'
      ? [
          { color: 'var(--primary)', label: '淨資產' },
          { color: 'var(--pos-bar)', label: '總資產' },
          { color: 'var(--neg-bar)', label: '總負債' },
        ]
      : [
          { color: '#34C759', label: '高流動' },
          { color: '#4E8FE6', label: '投資' },
          { color: '#5856D6', label: '保單' },
          { color: '#8E8E93', label: '其他' },
        ];
  for (const it of legendItems) {
    const span = document.createElement('span');
    span.className = 'nw-legend-item';
    const dot = document.createElement('i');
    dot.className = 'cal-dot';
    dot.style.background = it.color;
    span.appendChild(dot);
    span.appendChild(document.createTextNode(it.label));
    legend.appendChild(span);
  }
  container.appendChild(legend);

  // SVG
  const onSelect = (ym: string) => {
    ctx.state.networthChartSelectedYm = ym;
    renderNetWorthChartCard(ctx, container);
  };
  const svg =
    mode === 'line'
      ? buildLineChartSvg(trend.points, selectedPoint.yearMonth, masked, onSelect)
      : buildStackedAreaSvg(trend.points, selectedPoint.yearMonth, masked, onSelect);
  container.appendChild(svg);

  // Selected point detail strip
  const detail = document.createElement('div');
  detail.className = 'nw-detail-strip tnum';
  const dHead = document.createElement('div');
  dHead.className = 'nw-detail-head';
  const dTitle = document.createElement('strong');
  dTitle.textContent = `${selectedPoint.yearMonth} 快照明細`;
  const dRate = document.createElement('span');
  dRate.className = 'muted';
  dRate.textContent = `儲蓄率 ${masked ? '••%' : fmtPct(selectedPoint.savingsRate * 100, 1)}`;
  dHead.appendChild(dTitle);
  dHead.appendChild(dRate);
  detail.appendChild(dHead);

  const dGrid = document.createElement('div');
  dGrid.className = 'nw-detail-grid';
  const pairs: Array<[string, string, string]> =
    mode === 'line'
      ? [
          ['淨資產', fmtMoney(selectedPoint.netWorth, masked), masked ? '' : selectedPoint.netWorth >= 0 ? 'pos' : 'neg'],
          ['總資產', fmtMoney(selectedPoint.totalAssets, masked), ''],
          ['總負債', fmtMoney(selectedPoint.totalLiabilities, masked), masked ? '' : selectedPoint.totalLiabilities > 0 ? 'neg' : ''],
        ]
      : [
          ['高流動', fmtMoney(selectedPoint.highLiquidityAssets, masked), ''],
          ['投資資產', fmtMoney(selectedPoint.investmentAssets, masked), 'inv'],
          ['保單 / 其他', fmtMoney(selectedPoint.insuranceAssets + selectedPoint.otherAssets, masked), ''],
        ];
  for (const [k, v, cls] of pairs) {
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
    dGrid.appendChild(cell);
  }
  detail.appendChild(dGrid);
  container.appendChild(detail);
}
