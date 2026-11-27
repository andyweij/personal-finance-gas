import { computeRebalancePlan, type RebalanceMode } from '../../../shared/analytics';
import { DEFAULT_STOCK_CATEGORIES } from '../../../shared/constants';
import { roundTo } from '../../../shared/format';
import type { RebalanceTargetKind, RebalanceTargetRule, StockPortfolioSummary } from '../../../shared/types';
import { MAX_REBALANCE_TARGETS_PER_KIND, validateRebalanceTargetsForSave } from '../../../shared/validation';
import { bindSubmit, closeModal, fmtMoney, fmtPct, openModal, showToast } from './helpers';
import type { UiContext } from './state';

function buildEditableCandidates(
  ctx: UiContext,
  portfolio: StockPortfolioSummary,
  kind: RebalanceTargetKind
): Array<{ key: string; label: string; currentPct: number; targetPct: number; isMissing: boolean }> {
  const existing = (ctx.engine.getSnapshot().settings.rebalanceTargets || []).filter((r) => r.kind === kind);
  const existingMap = new Map(existing.map((r) => [r.key, r]));
  const totalVal = Math.max(1, portfolio.totalMarketValueTwd);

  const map = new Map<
    string,
    { key: string; label: string; currentVal: number; targetPct: number; matched: boolean }
  >();
  for (const r of existing) {
    map.set(r.key, { key: r.key, label: r.label, currentVal: 0, targetPct: r.targetPct, matched: false });
  }

  if (kind === 'category') {
    for (const c of DEFAULT_STOCK_CATEGORIES) {
      if (!map.has(c)) map.set(c, { key: c, label: c, currentVal: 0, targetPct: 0, matched: true });
      else map.get(c)!.matched = true;
    }
    for (const c of ctx.engine.getSnapshot().settings.customStockCategories || []) {
      if (!map.has(c)) map.set(c, { key: c, label: c, currentVal: 0, targetPct: 0, matched: true });
      else map.get(c)!.matched = true;
    }
    for (const pos of portfolio.positions) {
      const key = String(pos.asset.stockCategory || '').trim() || '未分類';
      const cur = map.get(key) || {
        key,
        label: key,
        currentVal: 0,
        targetPct: existingMap.get(key)?.targetPct ?? 0,
        matched: true,
      };
      cur.matched = true;
      cur.currentVal += Math.max(0, pos.marketValueTwd);
      map.set(key, cur);
    }
  } else {
    for (const pos of portfolio.positions) {
      const idKey = pos.asset.id;
      const label = pos.asset.ticker ? `${pos.asset.itemName} (${pos.asset.ticker})` : pos.asset.itemName;
      let resolvedKey = idKey;
      if (!map.has(idKey) && pos.asset.ticker) {
        const upperTicker = pos.asset.ticker.trim().toUpperCase();
        for (const rk of map.keys()) {
          if (rk.trim().toUpperCase() === upperTicker) {
            resolvedKey = rk;
            break;
          }
        }
      }
      const cur = map.get(resolvedKey) || {
        key: resolvedKey,
        label,
        currentVal: 0,
        targetPct: existingMap.get(resolvedKey)?.targetPct ?? 0,
        matched: true,
      };
      cur.label = label;
      cur.matched = true;
      cur.currentVal += Math.max(0, pos.marketValueTwd);
      map.set(resolvedKey, cur);
    }
  }

  return Array.from(map.values())
    .map((v) => ({
      key: v.key,
      label: v.label,
      currentPct: portfolio.totalMarketValueTwd > 0 ? roundTo((v.currentVal / totalVal) * 100, 1) : 0,
      targetPct: v.targetPct,
      isMissing: kind === 'ticker' && !v.matched,
    }))
    .sort((a, b) => Number(a.isMissing) - Number(b.isMissing) || b.targetPct - a.targetPct || b.currentPct - a.currentPct);
}

export function openRebalanceTargetsModal(
  ctx: UiContext,
  portfolio: StockPortfolioSummary,
  kind: RebalanceTargetKind
): void {
  const kindTitle = kind === 'category' ? '持股分類' : '個別標的';
  const body = openModal(`設定再平衡目標比例（${kindTitle}）`);

  const hint = document.createElement('div');
  hint.className = 'muted';
  hint.style.cssText = 'font-size:12.5px;margin-bottom:10px';
  hint.textContent = '各項目目標比例合計須為 100%（留 0 代表不配置）；設定將同步至雲端。';
  body.appendChild(hint);

  const candidates = buildEditableCandidates(ctx, portfolio, kind);
  if (!candidates.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = '目前尚無可設定的項目，請先新增持股。';
    body.appendChild(empty);
    return;
  }

  const form = document.createElement('form');
  form.className = 'reb-modal-form';

  const sumBanner = document.createElement('div');
  sumBanner.className = 'reb-sum-banner tnum';
  const sumText = document.createElement('span');
  const eqBtn = document.createElement('button');
  eqBtn.type = 'button';
  eqBtn.className = 'btn btn-outline btn-sm';
  eqBtn.textContent = '平均分配';
  sumBanner.appendChild(sumText);
  sumBanner.appendChild(eqBtn);
  form.appendChild(sumBanner);

  const list = document.createElement('div');
  list.className = 'reb-edit-list';

  const inputs: Array<{
    key: string;
    label: string;
    currentPct: number;
    isMissing: boolean;
    input: HTMLInputElement;
    row: HTMLDivElement;
  }> = [];

  const updateSum = () => {
    const activeCount = inputs.filter((it) => Number(it.input.value || 0) > 0).length;
    const sum = roundTo(
      inputs.reduce((s, it) => s + Math.max(0, Number(it.input.value || 0)), 0),
      2
    );
    const overLimit = activeCount > MAX_REBALANCE_TARGETS_PER_KIND;
    const ok = !overLimit && Math.abs(sum - 100) <= 0.01;
    sumText.textContent = overLimit
      ? `超過上限：已設 ${activeCount} / ${MAX_REBALANCE_TARGETS_PER_KIND} 筆`
      : `目前合計：${sum.toFixed(1)}%${ok ? ' ✓' : '（須為 100%）'}`;
    sumBanner.classList.toggle('ok', ok);
    sumBanner.classList.toggle('warn', !ok);
  };

  for (const item of candidates) {
    const row = document.createElement('div');
    row.className = 'reb-edit-row';

    const left = document.createElement('div');
    left.className = 'reb-edit-left';
    const lblWrap = document.createElement('div');
    lblWrap.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';
    const lbl = document.createElement('strong');
    lbl.textContent = item.label;
    lblWrap.appendChild(lbl);
    if (item.isMissing) {
      const missBadge = document.createElement('span');
      missBadge.className = 'badge';
      missBadge.style.cssText = 'margin-right:0;background:var(--neg-soft,rgba(255,59,48,.12));color:var(--neg)';
      missBadge.textContent = '已不存在';
      lblWrap.appendChild(missBadge);
    }
    const cur = document.createElement('span');
    cur.className = 'muted tnum';
    cur.style.fontSize = '11px';
    cur.textContent = item.isMissing ? '目前無對應持股，建議移除或歸零' : `目前 ${fmtPct(item.currentPct, 1)}`;
    left.appendChild(lblWrap);
    left.appendChild(cur);

    const right = document.createElement('div');
    right.className = 'reb-edit-right';
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.inputMode = 'decimal';
    // v1.12.3: a 0.5 step made the browser block e.g. 33.33 / 33.33 / 33.34 (stepMismatch) before our own checks
    inp.step = 'any';
    inp.min = '0';
    inp.max = '100';
    inp.className = 'tnum reb-pct-input';
    inp.value = item.targetPct > 0 ? String(item.targetPct) : '';
    inp.placeholder = '0';
    inp.addEventListener('input', updateSum);
    const unit = document.createElement('span');
    unit.className = 'muted';
    unit.textContent = '%';
    right.appendChild(inp);
    right.appendChild(unit);

    const entry = {
      key: item.key,
      label: item.label,
      currentPct: item.currentPct,
      isMissing: item.isMissing,
      input: inp,
      row,
    };

    if (item.isMissing) {
      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn btn-outline btn-sm';
      rmBtn.style.cssText = 'padding:3px 7px;font-size:11px;min-height:auto';
      rmBtn.textContent = '移除';
      rmBtn.addEventListener('click', () => {
        inp.value = '';
        const idx = inputs.indexOf(entry);
        if (idx >= 0) inputs.splice(idx, 1);
        row.remove();
        updateSum();
      });
      right.appendChild(rmBtn);
    }

    row.appendChild(left);
    row.appendChild(right);
    list.appendChild(row);
    inputs.push(entry);
  }
  form.appendChild(list);

  eqBtn.addEventListener('click', () => {
    const nonMissing = inputs.filter((it) => !it.isMissing);
    const targets = nonMissing.filter((it) => it.currentPct > 0);
    const active = targets.length > 0 ? targets : nonMissing.length > 0 ? nonMissing : inputs;
    if (!active.length) return;
    const base = Math.floor(10000 / active.length) / 100;
    let rem = roundTo(100 - base * active.length, 2);
    const activeSet = new Set(active);
    for (const it of inputs) {
      if (!activeSet.has(it)) {
        it.input.value = '';
      } else {
        const val = roundTo(base + (rem > 0 ? rem : 0), 2);
        rem = 0;
        it.input.value = String(val);
      }
    }
    updateSum();
  });

  updateSum();

  const footer = document.createElement('div');
  footer.className = 'reb-modal-footer';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn-outline btn-sm';
  clearBtn.textContent = '清除此模式目標';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn btn-primary btn-sm';
  saveBtn.textContent = '儲存目標比例';

  let clearing = false;
  clearBtn.addEventListener('click', async () => {
    if (clearing) return;
    clearing = true;
    clearBtn.disabled = true;
    saveBtn.disabled = true;
    try {
      const otherKindRules = (ctx.engine.getSnapshot().settings.rebalanceTargets || []).filter(
        (r) => r.kind !== kind
      );
      await ctx.engine.saveRebalanceTargets(otherKindRules);
      closeModal();
      showToast(`已清除${kindTitle}目標比例`, 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '清除目標比例失敗', 'error');
    } finally {
      clearing = false;
      clearBtn.disabled = false;
      saveBtn.disabled = false;
    }
  });

  footer.appendChild(clearBtn);
  footer.appendChild(saveBtn);
  form.appendChild(footer);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    const newKindRules: RebalanceTargetRule[] = [];
    for (const it of inputs) {
      const pct = roundTo(Number(it.input.value || 0), 2);
      if (pct > 0) {
        newKindRules.push({
          id: `${kind}:${it.key}`,
          kind,
          key: it.key,
          label: it.label,
          targetPct: pct,
        });
      }
    }
    const otherKindRules = (ctx.engine.getSnapshot().settings.rebalanceTargets || []).filter(
      (r) => r.kind !== kind
    );
    try {
      const merged = validateRebalanceTargetsForSave([...otherKindRules, ...newKindRules]);
      await ctx.engine.saveRebalanceTargets(merged);
      closeModal();
      showToast(`已儲存${kindTitle}再平衡目標`, 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '目標比例驗證失敗', 'error');
    }
  });

  body.appendChild(form);
}

export function renderRebalanceCard(
  ctx: UiContext,
  portfolio: StockPortfolioSummary,
  container: HTMLElement
): void {
  container.innerHTML = '';
  if (!portfolio.positions.length) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';

  const masked = ctx.state.masked;
  const kind = ctx.state.rebalanceKind;
  const mode = ctx.state.rebalanceMode;

  // Header
  const head = document.createElement('div');
  head.className = 'card-header';
  head.style.marginBottom = '10px';

  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = '資產再平衡試算';
  const sub = document.createElement('div');
  sub.className = 'muted';
  sub.textContent = mode === 'buy_only' ? '新資金只買不賣，優先補齊低配項目' : '依目標比例計算買賣調倉金額';
  titleWrap.appendChild(title);
  titleWrap.appendChild(sub);

  const configBtn = document.createElement('button');
  configBtn.type = 'button';
  configBtn.className = 'btn btn-tinted btn-sm';
  configBtn.textContent = '⚙ 設定目標';
  configBtn.addEventListener('click', () => openRebalanceTargetsModal(ctx, portfolio, kind));

  head.appendChild(titleWrap);
  head.appendChild(configBtn);
  container.appendChild(head);

  // Mode toggles row
  const ctrlRow = document.createElement('div');
  ctrlRow.className = 'reb-ctrl-row';

  const kindSeg = document.createElement('div');
  kindSeg.className = 'mini-seg';
  for (const [val, label] of [
    ['category', '依分類'],
    ['ticker', '依標的'],
  ] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mini-seg-btn' + (kind === val ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      ctx.state.rebalanceKind = val;
      renderRebalanceCard(ctx, portfolio, container);
    });
    kindSeg.appendChild(b);
  }

  const modeSeg = document.createElement('div');
  modeSeg.className = 'mini-seg';
  for (const [val, label] of [
    ['buy_only', '只買不賣'],
    ['full', '買賣調倉'],
  ] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mini-seg-btn' + (mode === val ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      ctx.state.rebalanceMode = val as RebalanceMode;
      renderRebalanceCard(ctx, portfolio, container);
    });
    modeSeg.appendChild(b);
  }

  ctrlRow.appendChild(kindSeg);
  ctrlRow.appendChild(modeSeg);
  container.appendChild(ctrlRow);

  // Contribution input + quick chips (kept mounted across live recalculations so typing + chip clicks never drop)
  const contribWrap = document.createElement('div');
  contribWrap.className = 'reb-contrib-wrap';
  const contribLabel = document.createElement('label');
  contribLabel.className = 'section-label';
  contribLabel.style.marginBottom = '4px';
  contribLabel.textContent = '本次新投入資金 (TWD)';
  const contribRow = document.createElement('div');
  contribRow.className = 'reb-contrib-row';

  const contribInput = document.createElement('input');
  contribInput.type = 'number';
  contribInput.inputMode = 'numeric';
  contribInput.min = '0';
  contribInput.step = '1000';
  contribInput.className = 'tnum reb-contrib-input';
  contribInput.placeholder = '0（純調倉可填 0）';
  contribInput.value = ctx.state.rebalanceContribution;

  const calcBtn = document.createElement('button');
  calcBtn.type = 'button';
  calcBtn.className = 'btn btn-outline btn-sm';
  calcBtn.textContent = '試算';
  contribRow.appendChild(contribInput);
  contribRow.appendChild(calcBtn);

  const quickRow = document.createElement('div');
  quickRow.className = 'quick-row';
  quickRow.style.margin = '6px 0 0';

  contribWrap.appendChild(contribLabel);
  contribWrap.appendChild(contribRow);
  contribWrap.appendChild(quickRow);
  container.appendChild(contribWrap);

  const resultsWrap = document.createElement('div');
  resultsWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  container.appendChild(resultsWrap);

  const renderResults = () => {
    resultsWrap.innerHTML = '';
    const liveContribution = Math.max(0, Number(ctx.state.rebalanceContribution || 0) || 0);
    const rules = ctx.engine.getSnapshot().settings.rebalanceTargets || [];
    const plan = computeRebalancePlan(portfolio, rules, kind, liveContribution, mode, {
      excludeUntargeted: ctx.state.rebalanceExcludeUntargeted,
    });

    if (!plan.isValidTargets) {
      const empty = document.createElement('div');
      empty.className = 'reb-empty-box';
      const msg = document.createElement('div');
      msg.className = 'muted';
      msg.textContent = `尚未設定「${kind === 'category' ? '依分類' : '依標的'}」目標比例（合計須為 100%）`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm';
      btn.textContent = '+ 立即設定目標比例';
      btn.addEventListener('click', () => openRebalanceTargetsModal(ctx, portfolio, kind));
      empty.appendChild(msg);
      empty.appendChild(btn);
      resultsWrap.appendChild(empty);
      return;
    }

    const hasMissingRows = plan.rows.some((r) => r.isMissingHolding);
    if (hasMissingRows) {
      const missBox = document.createElement('div');
      missBox.className = 'muted';
      missBox.style.cssText =
        'font-size:11.5px;padding:6px 10px;border-radius:8px;background:var(--fill);display:flex;align-items:center;justify-content:space-between;gap:8px';
      const missTxt = document.createElement('span');
      missTxt.textContent = '⚠ 部分目標規則已無對應持股（標記為「已無持股」），可前往設定目標移除。';
      const fixBtn = document.createElement('button');
      fixBtn.type = 'button';
      fixBtn.className = 'btn btn-outline btn-sm';
      fixBtn.style.cssText = 'padding:2px 8px;font-size:11px;min-height:auto;flex-shrink:0';
      fixBtn.textContent = '整理目標';
      fixBtn.addEventListener('click', () => openRebalanceTargetsModal(ctx, portfolio, kind));
      missBox.appendChild(missTxt);
      missBox.appendChild(fixBtn);
      resultsWrap.appendChild(missBox);
    }

    const hasUntargetedHoldings = plan.rows.some((r) => r.isUntargeted && r.currentValueTwd > 0);
    if (mode === 'full' && hasUntargetedHoldings) {
      const optBox = document.createElement('div');
      optBox.style.cssText =
        'font-size:11.5px;padding:7px 10px;border-radius:8px;background:var(--fill);display:flex;flex-direction:column;gap:4px';
      const chkLabel = document.createElement('label');
      chkLabel.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:600';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = ctx.state.rebalanceExcludeUntargeted;
      chk.addEventListener('change', () => {
        ctx.state.rebalanceExcludeUntargeted = chk.checked;
        renderResults();
      });
      chkLabel.appendChild(chk);
      chkLabel.appendChild(document.createTextNode('排除未設目標的項目（保留不動、不建議賣出）'));
      optBox.appendChild(chkLabel);

      if (!ctx.state.rebalanceExcludeUntargeted) {
        const warn = document.createElement('div');
        warn.style.color = 'var(--warning, #d97706)';
        warn.textContent =
          '⚠ 「未設」項目目標比例視為 0%，系統將建議全數賣出；可勾選上方排除或前往設定目標。';
        optBox.appendChild(warn);
      }
      resultsWrap.appendChild(optBox);
    }

    // Results table
    const table = document.createElement('table');
    table.className = 'stat-table reb-table tnum';
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const [text, cls] of [
      ['項目', ''],
      ['現況 → 目標', 'num'],
      ['建議操作', 'num'],
    ] as const) {
      const th = document.createElement('th');
      if (cls) th.className = cls;
      th.textContent = text;
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of plan.rows) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      const nameEl = document.createElement('div');
      nameEl.style.fontWeight = '600';
      const suffix = row.isMissingHolding
        ? ' (已無持股)'
        : row.isUntargeted
          ? plan.excludeUntargeted && mode === 'full'
            ? ' (未設·已排除)'
            : ' (未設)'
          : '';
      nameEl.textContent = row.label + suffix;
      const driftEl = document.createElement('div');
      driftEl.className = 'muted';
      driftEl.style.fontSize = '11px';
      driftEl.textContent =
        row.isUntargeted && plan.excludeUntargeted && mode === 'full'
          ? '已排除於本次調倉計算'
          : `偏離 ${fmtPct(row.driftPct, 1, true)} · 調後 ${fmtPct(row.postPct, 1)}`;
      td1.appendChild(nameEl);
      td1.appendChild(driftEl);

      const td2 = document.createElement('td');
      td2.className = 'num';
      td2.textContent =
        row.isUntargeted && plan.excludeUntargeted && mode === 'full'
          ? `${fmtPct(row.currentPct, 1)} · 保留`
          : `${fmtPct(row.currentPct, 1)} → ${fmtPct(row.targetPct, 0)}`;

      const td3 = document.createElement('td');
      td3.className = 'num';
      const actSpan = document.createElement('strong');
      if (row.actionTwd > 0) {
        actSpan.style.color = 'var(--primary)';
        actSpan.textContent = `買 +${fmtMoney(row.actionTwd, masked, '')}`;
      } else if (row.actionTwd < 0) {
        actSpan.style.color = 'var(--neg)';
        actSpan.textContent = `賣 -${fmtMoney(Math.abs(row.actionTwd), masked, '')}`;
      } else {
        actSpan.className = 'muted';
        actSpan.textContent = '持平';
      }
      td3.appendChild(actSpan);

      tr.appendChild(td1);
      tr.appendChild(td2);
      tr.appendChild(td3);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    resultsWrap.appendChild(table);

    // Footer summary
    const foot = document.createElement('div');
    foot.className = 'nw-detail-grid tnum';
    const fItems: Array<[string, string, string]> = [
      ['建議買進合計', fmtMoney(plan.totalBuyTwd, masked), plan.totalBuyTwd > 0 ? 'inv' : ''],
      ['建議賣出合計', fmtMoney(plan.totalSellTwd, masked), plan.totalSellTwd > 0 ? 'neg' : ''],
      ['調倉後總市值', fmtMoney(plan.projectedTotalTwd, masked), ''],
    ];
    for (const [k, v, cls] of fItems) {
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
      foot.appendChild(cell);
    }
    resultsWrap.appendChild(foot);
  };

  contribInput.addEventListener('input', () => {
    ctx.state.rebalanceContribution = contribInput.value;
    renderResults();
  });
  calcBtn.addEventListener('click', () => {
    ctx.state.rebalanceContribution = contribInput.value;
    renderResults();
  });

  for (const [amt, label] of [
    [0, '0'],
    [10000, '+1萬'],
    [30000, '+3萬'],
    [50000, '+5萬'],
  ] as const) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip-btn sm tnum';
    chip.textContent = label;
    chip.addEventListener('click', () => {
      const cur = Math.max(0, Number(ctx.state.rebalanceContribution || 0) || 0);
      const next = amt === 0 ? 0 : cur + amt;
      ctx.state.rebalanceContribution = next > 0 ? String(next) : '';
      contribInput.value = ctx.state.rebalanceContribution;
      renderResults();
    });
    quickRow.appendChild(chip);
  }

  renderResults();
}
