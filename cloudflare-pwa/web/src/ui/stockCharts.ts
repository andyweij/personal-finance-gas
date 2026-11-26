import type { StockPortfolioSummary } from '../../../shared/types';
import { fmtMoney } from './helpers';
import type { StockChartDimension, StockChartType, UiContext } from './state';

export const STOCK_CHART_PALETTE = [
  '#4E8FE6', // Blue
  '#34C759', // Green
  '#FF9500', // Orange
  '#5856D6', // Indigo
  '#FF2D55', // Pink/Red
  '#30B0C7', // Teal
  '#AF52DE', // Purple
  '#FFCC00', // Yellow
  '#00C7BE', // Mint
  '#FF6B6B', // Coral
];

export interface StockChartItem {
  id: string;
  label: string;
  shortLabel: string;
  subLabel: string;
  value: number;
  pct: number;
  color: string;
  hasCostBasis: boolean;
  roiPct?: number;
}

export interface PieArcGeometry {
  item: StockChartItem;
  startAngle: number; // degrees, 0 = 12 o'clock clockwise
  endAngle: number;
  midAngle: number;
  sweepAngle: number;
  isFullCircle: boolean;
}

export interface TreemapRect {
  item: StockChartItem;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function buildStockChartItems(
  portfolio: StockPortfolioSummary,
  dimension: StockChartDimension
): StockChartItem[] {
  if (!portfolio.positions.length) return [];

  if (dimension === 'category') {
    const groups = new Map<
      string,
      { label: string; isUncategorized: boolean; value: number; count: number; names: string[]; cost: number; pnl: number; hasCost: boolean }
    >();
    for (const pos of portfolio.positions) {
      const cat = String(pos.asset.stockCategory || '').trim();
      const isUncategorized = !cat;
      const label = cat || '未分類';
      const key = `cat:${label}`;
      const cur = groups.get(key) || {
        label,
        isUncategorized,
        value: 0,
        count: 0,
        names: [],
        cost: 0,
        pnl: 0,
        hasCost: false,
      };
      cur.value += Math.max(0, pos.marketValueTwd);
      cur.count += 1;
      cur.names.push(pos.asset.itemName);
      if (pos.hasCostBasis) {
        cur.hasCost = true;
        cur.cost += pos.costBasisTwd;
        cur.pnl += pos.totalReturnPnlTwd;
      }
      groups.set(key, cur);
    }
    const entries = Array.from(groups.entries())
      .filter(([, g]) => g.value > 0)
      .sort((a, b) => {
        if (a[1].isUncategorized !== b[1].isUncategorized) {
          return a[1].isUncategorized ? 1 : -1;
        }
        return b[1].value - a[1].value;
      });
    const total = entries.reduce((s, [, g]) => s + g.value, 0);
    if (total <= 0) return [];

    let colorIdx = 0;
    return entries.map(([id, g]) => {
      const color = g.isUncategorized
        ? '#94A3B8'
        : STOCK_CHART_PALETTE[colorIdx++ % STOCK_CHART_PALETTE.length];
      const previewNames = g.names.slice(0, 3).join('、');
      const moreSuffix = g.names.length > 3 ? ` 等 ${g.count} 檔` : '';
      return {
        id,
        label: g.label,
        shortLabel: g.label.slice(0, 6),
        subLabel: `${g.count} 檔：${previewNames}${moreSuffix}`,
        value: Math.round(g.value),
        pct: Math.round((g.value / total) * 1000) / 10,
        color,
        hasCostBasis: g.hasCost && g.cost > 0,
        roiPct: g.hasCost && g.cost > 0 ? Math.round((g.pnl / g.cost) * 1000) / 10 : undefined,
      };
    });
  }

  if (dimension === 'market') {
    const groups = new Map<string, { label: string; value: number; count: number; cost: number; pnl: number; hasCost: boolean }>();
    for (const pos of portfolio.positions) {
      const isUs = pos.asset.subCategory === '美股/ETF' || pos.asset.currency === 'USD';
      const key = isUs ? 'market:us' : 'market:tw';
      const label = isUs ? '美股 / ETF' : '台股';
      const cur = groups.get(key) || { label, value: 0, count: 0, cost: 0, pnl: 0, hasCost: false };
      cur.value += Math.max(0, pos.marketValueTwd);
      cur.count += 1;
      if (pos.hasCostBasis) {
        cur.hasCost = true;
        cur.cost += pos.costBasisTwd;
        cur.pnl += pos.totalReturnPnlTwd;
      }
      groups.set(key, cur);
    }
    const entries = Array.from(groups.entries())
      .filter(([, g]) => g.value > 0)
      .sort((a, b) => b[1].value - a[1].value);
    const total = entries.reduce((s, [, g]) => s + g.value, 0);
    if (total <= 0) return [];
    return entries.map(([id, g], idx) => ({
      id,
      label: g.label,
      shortLabel: g.label,
      subLabel: `${g.count} 檔持股`,
      value: Math.round(g.value),
      pct: Math.round((g.value / total) * 1000) / 10,
      color: STOCK_CHART_PALETTE[idx % STOCK_CHART_PALETTE.length],
      hasCostBasis: g.hasCost && g.cost > 0,
      roiPct: g.hasCost && g.cost > 0 ? Math.round((g.pnl / g.cost) * 1000) / 10 : undefined,
    }));
  }

  const rawEntries = portfolio.positions
    .map((pos) => {
      const value =
        dimension === 'cost'
          ? pos.hasCostBasis
            ? Math.max(0, pos.costBasisTwd)
            : 0
          : Math.max(0, pos.marketValueTwd);
      const ticker = pos.asset.ticker
        ? pos.asset.ticker
            .replace(/^(?:TPE|TWSE|TPEX|OTC|TWO|TW|US|NASDAQ|NYSE|NYSEARCA|ARCA|AMEX|BATS|CBOE):/i, '')
            .replace(/\.(?:TW|TWO|US)$/i, '')
        : '';
      return {
        id: pos.asset.id,
        label: pos.asset.itemName,
        shortLabel: ticker || pos.asset.itemName.slice(0, 6),
        subLabel: ticker ? `${ticker} · ${pos.asset.subCategory}` : pos.asset.subCategory,
        value: Math.round(value),
        hasCostBasis: pos.hasCostBasis,
        roiPct: pos.hasCostBasis ? pos.totalReturnRoiPct : undefined,
      };
    })
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = rawEntries.reduce((s, e) => s + e.value, 0);
  if (total <= 0) return [];

  return rawEntries.map((entry, idx) => ({
    ...entry,
    pct: Math.round((entry.value / total) * 1000) / 10,
    color: STOCK_CHART_PALETTE[idx % STOCK_CHART_PALETTE.length],
  }));
}

export function computePieArcs(items: StockChartItem[]): PieArcGeometry[] {
  const total = items.reduce((s, i) => s + Math.max(0, i.value), 0);
  if (total <= 0 || !items.length) return [];

  let cursor = 0;
  return items.map((item, idx) => {
    const ratio = Math.max(0, item.value) / total;
    const isLast = idx === items.length - 1;
    const sweepAngle = isLast ? Math.max(0, 360 - cursor) : ratio * 360;
    const startAngle = cursor;
    const endAngle = startAngle + sweepAngle;
    const midAngle = startAngle + sweepAngle / 2;
    cursor = endAngle;
    return {
      item,
      startAngle,
      endAngle,
      midAngle,
      sweepAngle,
      isFullCircle: sweepAngle >= 359.95,
    };
  });
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function describePieSlice(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)} Z`;
}

function describeDonutSlice(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngle: number,
  endAngle: number
): string {
  const outerStart = polarToCartesian(cx, cy, outerR, endAngle);
  const outerEnd = polarToCartesian(cx, cy, outerR, startAngle);
  const innerStart = polarToCartesian(cx, cy, innerR, startAngle);
  const innerEnd = polarToCartesian(cx, cy, innerR, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return [
    `M ${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 0 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)}`,
    `L ${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 1 ${innerEnd.x.toFixed(2)} ${innerEnd.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

/**
 * Balanced binary-partition treemap layout (deterministic, zero overlap, exact area proportion).
 */
export function computeTreemapRects(
  items: StockChartItem[],
  width: number,
  height: number
): TreemapRect[] {
  const positive = items
    .filter((i) => i.value > 0)
    .slice()
    .sort((a, b) => b.value - a.value);
  if (!positive.length || width <= 0 || height <= 0) return [];

  const result: TreemapRect[] = [];

  const split = (subset: StockChartItem[], x: number, y: number, w: number, h: number): void => {
    if (subset.length === 1) {
      result.push({ item: subset[0], x, y, w, h });
      return;
    }
    const total = subset.reduce((s, i) => s + i.value, 0);
    if (total <= 0) return;

    // Partition into two groups as close to 50/50 sum as possible
    let acc = 0;
    let splitIdx = 1;
    let bestDiff = Infinity;
    for (let i = 0; i < subset.length - 1; i++) {
      acc += subset[i].value;
      const diff = Math.abs(acc - total / 2);
      if (diff < bestDiff) {
        bestDiff = diff;
        splitIdx = i + 1;
      }
    }

    const first = subset.slice(0, splitIdx);
    const second = subset.slice(splitIdx);
    const firstSum = first.reduce((s, i) => s + i.value, 0);
    const ratio = firstSum / total;

    if (w >= h) {
      const w1 = w * ratio;
      split(first, x, y, w1, h);
      split(second, x + w1, y, w - w1, h);
    } else {
      const h1 = h * ratio;
      split(first, x, y, w, h1);
      split(second, x, y + h1, w, h - h1);
    }
  };

  split(positive, 0, 0, width, height);
  return result;
}

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

function fmtSignedPct(pct: number, masked: boolean): string {
  if (masked) return '••%';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

export interface StockChartCardOptions {
  onManageCategories?: () => void;
}

export function renderStockChartCard(
  ctx: UiContext,
  portfolio: StockPortfolioSummary,
  container: HTMLElement,
  options?: StockChartCardOptions
): void {
  container.innerHTML = '';

  if (!portfolio.positions.length) {
    container.style.display = 'none';
    return;
  }
  container.style.display = '';

  const chartType = ctx.state.stockChartType;
  const dimension = ctx.state.stockChartDimension;
  const masked = ctx.state.masked;

  const items = buildStockChartItems(portfolio, dimension);
  if (
    ctx.state.stockChartHighlight &&
    !items.some((i) => i.id === ctx.state.stockChartHighlight)
  ) {
    ctx.state.stockChartHighlight = null;
  }
  const selectedItem = items.find((i) => i.id === ctx.state.stockChartHighlight) || null;
  const totalValue = items.reduce((s, i) => s + i.value, 0);

  const toggleHighlight = (id: string) => {
    ctx.state.stockChartHighlight = ctx.state.stockChartHighlight === id ? null : id;
    renderStockChartCard(ctx, portfolio, container, options);
  };

  // Header: title + chart type switcher
  const header = document.createElement('div');
  header.className = 'stock-chart-header';

  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = '持股佔比統計';

  const typeBar = document.createElement('div');
  typeBar.className = 'mini-seg';
  const chartTypes: Array<{ id: StockChartType; label: string }> = [
    { id: 'donut', label: '甜甜圈' },
    { id: 'pie', label: '圓餅圖' },
    { id: 'hbar', label: '長條圖' },
    { id: 'treemap', label: '面積圖' },
  ];
  for (const ct of chartTypes) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mini-seg-btn' + (chartType === ct.id ? ' active' : '');
    b.textContent = ct.label;
    b.addEventListener('click', () => {
      ctx.state.stockChartType = ct.id;
      localStorage.setItem('finance_stock_chart_type', ct.id);
      renderStockChartCard(ctx, portfolio, container, options);
    });
    typeBar.appendChild(b);
  }
  header.appendChild(title);
  header.appendChild(typeBar);
  container.appendChild(header);

  // Dimension switcher pills
  const dimRow = document.createElement('div');
  dimRow.className = 'quick-row';
  dimRow.style.marginBottom = '12px';
  const dims: Array<{ id: StockChartDimension; label: string }> = [
    { id: 'value', label: '市值佔比' },
    { id: 'category', label: '持股分類' },
    { id: 'cost', label: '成本佔比' },
    { id: 'market', label: '台美市場' },
  ];
  for (const d of dims) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip-btn sm' + (dimension === d.id ? ' active' : '');
    chip.textContent = d.label;
    chip.addEventListener('click', () => {
      ctx.state.stockChartDimension = d.id;
      ctx.state.stockChartHighlight = null;
      localStorage.setItem('finance_stock_chart_dim', d.id);
      renderStockChartCard(ctx, portfolio, container, options);
    });
    dimRow.appendChild(chip);
  }
  if (options?.onManageCategories) {
    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'chip-btn sm stock-cat-manage-pill';
    manageBtn.textContent = '🏷 管理分類';
    manageBtn.addEventListener('click', () => options.onManageCategories?.());
    dimRow.appendChild(manageBtn);
  }
  container.appendChild(dimRow);

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.style.padding = '16px 8px';
    empty.textContent =
      dimension === 'cost'
        ? '尚未設定持股成本，設定各檔成本後即可檢視投入成本佔比'
        : '尚無正數市值持股可繪製統計圖表';
    container.appendChild(empty);
    return;
  }

  // Prompt banner if viewing category dimension and nothing is categorized yet
  if (dimension === 'category' && items.length === 1 && items[0].id === 'cat:未分類') {
    const hint = document.createElement('div');
    hint.className = 'stock-cat-empty-hint';
    const txt = document.createElement('span');
    txt.textContent = '尚未幫持股標記分類（個股 / ETF / 特別股 / 自訂），設定後即可呈現分類佔比';
    hint.appendChild(txt);
    if (options?.onManageCategories) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-tinted btn-sm';
      btn.textContent = '快速分類';
      btn.addEventListener('click', () => options.onManageCategories?.());
      hint.appendChild(btn);
    }
    container.appendChild(hint);
  }

  // Main chart stage
  const stage = document.createElement('div');
  stage.className = 'stock-chart-stage';

  if (chartType === 'donut' || chartType === 'pie') {
    const arcs = computePieArcs(items);
    const svg = svgEl('svg', {
      viewBox: '0 0 220 220',
      class: 'stock-pie-svg',
      role: 'img',
      'aria-label': '持股佔比圖表',
    });
    const cx = 110;
    const cy = 110;
    const outerR = 92;
    const innerR = 56;

    for (const arc of arcs) {
      const isSelected = selectedItem?.id === arc.item.id;
      const isDimmed = Boolean(selectedItem && !isSelected);
      const g = svgEl('g', {
        class: 'stock-pie-slice',
        style: `cursor:pointer;opacity:${isDimmed ? '0.32' : '1'};transition:opacity 0.18s ease, transform 0.18s ease;`,
      });
      if (isSelected && !arc.isFullCircle) {
        const offset = polarToCartesian(0, 0, 6, arc.midAngle);
        g.setAttribute('transform', `translate(${offset.x.toFixed(2)}, ${offset.y.toFixed(2)})`);
      }

      if (arc.isFullCircle) {
        if (chartType === 'donut') {
          const midR = (outerR + innerR) / 2;
          const ring = svgEl('circle', {
            cx,
            cy,
            r: midR,
            fill: 'none',
            stroke: arc.item.color,
            'stroke-width': outerR - innerR,
          });
          g.appendChild(ring);
        } else {
          const circle = svgEl('circle', {
            cx,
            cy,
            r: outerR,
            fill: arc.item.color,
          });
          g.appendChild(circle);
        }
      } else {
        const d =
          chartType === 'donut'
            ? describeDonutSlice(cx, cy, outerR, innerR, arc.startAngle, arc.endAngle)
            : describePieSlice(cx, cy, outerR, arc.startAngle, arc.endAngle);
        const path = svgEl('path', {
          d,
          fill: arc.item.color,
          stroke: 'var(--surface)',
          'stroke-width': '1.6',
          'stroke-linejoin': 'round',
        });
        g.appendChild(path);
      }

      // Direct percentage label on pie slices >= 7%
      if (chartType === 'pie' && arc.item.pct >= 7) {
        const lblPos = arc.isFullCircle
          ? { x: cx, y: cy }
          : polarToCartesian(cx, cy, outerR * 0.62, arc.midAngle);
        const txt = svgEl('text', {
          x: lblPos.x.toFixed(1),
          y: (lblPos.y + 4).toFixed(1),
          'text-anchor': 'middle',
          fill: '#FFFFFF',
          'font-size': '11',
          'font-weight': '700',
          'pointer-events': 'none',
        });
        txt.textContent = `${arc.item.pct.toFixed(1)}%`;
        g.appendChild(txt);
      }

      g.addEventListener('click', () => toggleHighlight(arc.item.id));
      svg.appendChild(g);
    }

    if (chartType === 'donut') {
      const centerWrap = document.createElement('div');
      centerWrap.className = 'stock-donut-wrap';
      centerWrap.appendChild(svg);

      const hole = document.createElement('div');
      hole.className = 'stock-donut-center tnum';
      if (selectedItem) {
        const n = document.createElement('div');
        n.className = 'stock-donut-title';
        n.textContent = selectedItem.label;
        const p = document.createElement('div');
        p.className = 'stock-donut-pct';
        p.style.color = selectedItem.color;
        p.textContent = `${selectedItem.pct.toFixed(1)}%`;
        const v = document.createElement('div');
        v.className = 'stock-donut-sub';
        v.textContent = fmtMoney(selectedItem.value, masked);
        hole.appendChild(n);
        hole.appendChild(p);
        hole.appendChild(v);
      } else {
        const n = document.createElement('div');
        n.className = 'stock-donut-title';
        n.textContent =
          dimension === 'cost'
            ? '總投入成本'
            : dimension === 'category'
              ? '分類總市值'
              : '持股總市值';
        const p = document.createElement('div');
        p.className = 'stock-donut-val';
        p.textContent = fmtMoney(totalValue, masked);
        const v = document.createElement('div');
        v.className = 'stock-donut-sub';
        v.textContent = `${items.length} ${dimension === 'market' || dimension === 'category' ? '類別' : '檔持股'}`;
        hole.appendChild(n);
        hole.appendChild(p);
        hole.appendChild(v);
      }
      centerWrap.appendChild(hole);
      stage.appendChild(centerWrap);
    } else {
      const pieWrap = document.createElement('div');
      pieWrap.className = 'stock-donut-wrap';
      pieWrap.appendChild(svg);
      stage.appendChild(pieWrap);
    }
  } else if (chartType === 'hbar') {
    const hbarList = document.createElement('div');
    hbarList.className = 'stock-hbar-list';
    const maxPct = Math.max(1, ...items.map((i) => i.pct));

    items.forEach((item, idx) => {
      const isSelected = selectedItem?.id === item.id;
      const isDimmed = Boolean(selectedItem && !isSelected);

      const row = document.createElement('button');
      row.type = 'button';
      row.className =
        'stock-hbar-row' + (isSelected ? ' selected' : '') + (isDimmed ? ' dimmed' : '');

      const top = document.createElement('div');
      top.className = 'stock-hbar-top tnum';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'stock-hbar-name';
      nameSpan.textContent = `${idx + 1}. ${item.label}`;
      const valSpan = document.createElement('span');
      valSpan.className = 'stock-hbar-val';
      valSpan.textContent = `${item.pct.toFixed(1)}% · ${fmtMoney(item.value, masked)}`;
      top.appendChild(nameSpan);
      top.appendChild(valSpan);

      const track = document.createElement('div');
      track.className = 'stock-hbar-track';
      const fill = document.createElement('div');
      fill.className = 'stock-hbar-fill';
      fill.style.width = `${Math.max(4, (item.pct / maxPct) * 100)}%`;
      fill.style.background = item.color;
      track.appendChild(fill);

      row.appendChild(top);
      row.appendChild(track);
      row.addEventListener('click', () => toggleHighlight(item.id));
      hbarList.appendChild(row);
    });
    stage.appendChild(hbarList);
  } else {
    // Treemap
    const W = 320;
    const H = 186;
    const rects = computeTreemapRects(items, W, H);
    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`,
      class: 'stock-treemap-svg',
      role: 'img',
      'aria-label': '持股面積矩形圖',
    });

    for (const r of rects) {
      const isSelected = selectedItem?.id === r.item.id;
      const isDimmed = Boolean(selectedItem && !isSelected);
      const pad = 1.5;
      const rx = r.x + pad;
      const ry = r.y + pad;
      const rw = Math.max(0, r.w - pad * 2);
      const rh = Math.max(0, r.h - pad * 2);

      const g = svgEl('g', {
        style: `cursor:pointer;opacity:${isDimmed ? '0.32' : '1'};transition:opacity 0.16s ease;`,
      });
      const rect = svgEl('rect', {
        x: rx.toFixed(1),
        y: ry.toFixed(1),
        width: rw.toFixed(1),
        height: rh.toFixed(1),
        rx: '8',
        ry: '8',
        fill: r.item.color,
        stroke: isSelected ? 'var(--text)' : 'none',
        'stroke-width': isSelected ? '2' : '0',
      });
      g.appendChild(rect);

      if (rw >= 46 && rh >= 34) {
        const cx = rx + rw / 2;
        const cy = ry + rh / 2;
        const lbl = svgEl('text', {
          x: cx.toFixed(1),
          y: (rh >= 50 ? cy - 3 : cy + 4).toFixed(1),
          'text-anchor': 'middle',
          fill: '#FFFFFF',
          'font-size': rw >= 84 ? '12' : '10.5',
          'font-weight': '700',
          'pointer-events': 'none',
        });
        const maxChars = Math.max(3, Math.floor(rw / 11));
        lbl.textContent =
          r.item.label.length <= maxChars ? r.item.label : r.item.shortLabel.slice(0, maxChars);
        g.appendChild(lbl);

        if (rh >= 50) {
          const pctTxt = svgEl('text', {
            x: cx.toFixed(1),
            y: (cy + 13).toFixed(1),
            'text-anchor': 'middle',
            fill: 'rgba(255,255,255,0.92)',
            'font-size': '10.5',
            'font-weight': '600',
            'pointer-events': 'none',
          });
          pctTxt.textContent = `${r.item.pct.toFixed(1)}%`;
          g.appendChild(pctTxt);
        }
      }

      g.addEventListener('click', () => toggleHighlight(r.item.id));
      svg.appendChild(g);
    }
    stage.appendChild(svg);
  }

  container.appendChild(stage);

  // Selected detail readout strip (always shown when an item is clicked)
  if (selectedItem) {
    const detail = document.createElement('div');
    detail.className = 'stock-chart-detail tnum';
    const topLine = document.createElement('div');
    topLine.className = 'stock-chart-detail-row';

    const left = document.createElement('div');
    left.className = 'stock-chart-detail-left';
    const dot = document.createElement('span');
    dot.className = 'alloc-dot';
    dot.style.background = selectedItem.color;
    const label = document.createElement('strong');
    label.textContent = `${selectedItem.label} (${selectedItem.pct.toFixed(1)}%)`;
    left.appendChild(dot);
    left.appendChild(label);

    const right = document.createElement('div');
    right.className = 'stock-chart-detail-right';
    const valSpan = document.createElement('span');
    valSpan.textContent = fmtMoney(selectedItem.value, masked);
    right.appendChild(valSpan);
    if (selectedItem.hasCostBasis && selectedItem.roiPct !== undefined) {
      const roiSpan = document.createElement('span');
      roiSpan.style.fontWeight = '700';
      roiSpan.style.color =
        selectedItem.roiPct > 0
          ? 'var(--stock-pos)'
          : selectedItem.roiPct < 0
            ? 'var(--stock-neg)'
            : 'var(--text-secondary)';
      roiSpan.textContent = ` · 含息 ${fmtSignedPct(selectedItem.roiPct, masked)}`;
      right.appendChild(roiSpan);
    }

    topLine.appendChild(left);
    topLine.appendChild(right);
    detail.appendChild(topLine);

    if ((dimension === 'category' || dimension === 'market') && selectedItem.subLabel) {
      const sub = document.createElement('div');
      sub.className = 'stock-chart-detail-sub';
      sub.textContent = selectedItem.subLabel;
      detail.appendChild(sub);
    }

    container.appendChild(detail);
  }

  // Interactive legend grid (compact 2-column pills; hidden on hbar to avoid duplicating exact list)
  if (chartType !== 'hbar') {
    const legend = document.createElement('div');
    legend.className = 'stock-chart-legend';
    for (const item of items) {
      const isSelected = selectedItem?.id === item.id;
      const isDimmed = Boolean(selectedItem && !isSelected);

      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className =
        'stock-legend-item' + (isSelected ? ' highlighted' : '') + (isDimmed ? ' dimmed' : '');

      const left = document.createElement('span');
      left.className = 'stock-legend-name';
      const dot = document.createElement('span');
      dot.className = 'alloc-dot';
      dot.style.background = item.color;
      const txt = document.createElement('span');
      txt.className = 'stock-legend-text';
      txt.textContent = item.label;
      left.appendChild(dot);
      left.appendChild(txt);

      const right = document.createElement('span');
      right.className = 'stock-legend-pct tnum';
      right.textContent = `${item.pct.toFixed(1)}%`;

      tile.appendChild(left);
      tile.appendChild(right);
      tile.addEventListener('click', () => toggleHighlight(item.id));
      legend.appendChild(tile);
    }
    container.appendChild(legend);
  }
}
