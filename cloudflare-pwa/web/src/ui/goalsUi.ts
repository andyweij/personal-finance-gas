import { compareBySortOrder, getEffectiveLedgerId } from '../../../shared/calculations';
import { DEFAULT_LEDGER_ID } from '../../../shared/constants';
import { todayInTimeZone } from '../../../shared/dates';
import {
  computeSuggestedFireTargetTwd,
  estimateTrailingMonthlyMetrics,
  evaluateFinancialGoal,
  type FinancialGoalProgress,
  type GoalEvaluationContext,
} from '../../../shared/goals';
import type { FinancialGoal, FinancialGoalType } from '../../../shared/types';
import { normalizeEnabledCurrencies, validateFinancialGoalInput } from '../../../shared/validation';
import { bindSubmit, closeModal, fmtMoney, fmtPct, openModal, showToast } from './helpers';
import { getActiveLedgers } from './ledgerUi';
import type { UiContext } from './state';

const GOAL_TYPE_META: Record<FinancialGoalType, { label: string; desc: string }> = {
  net_worth: { label: '總淨資產', desc: '自動追蹤「納入淨值帳本」之總淨資產' },
  fire: { label: 'FIRE 自由', desc: '依安全提領率 (如 4%) 追蹤總淨資產進度' },
  ledger_bucket: { label: '特定帳本桶', desc: '追蹤單一獨立帳本淨值（如旅遊／購車基金）' },
  asset_bucket: { label: '指定資產組合', desc: '加總勾選的活存、定存或持股即時市值' },
  manual: { label: '手動存錢桶', desc: '手動輸入目前累積金額與目標額' },
};

function formatDurationMonths(months: number): string {
  if (months <= 0) return '0 個月';
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m} 個月`;
  if (m === 0) return `${y} 年`;
  return `${y} 年 ${m} 個月`;
}

function buildEvalContext(ctx: UiContext): GoalEvaluationContext {
  const snap = ctx.engine.getSnapshot();
  return {
    assetItems: snap.assetItems,
    cashflowLogs: snap.cashflowLogs,
    savingsAdjustments: snap.savingsAdjustments || [],
    stockTransactions: snap.stockTransactions || [],
    ledgers: getActiveLedgers(ctx),
    fxSource: snap.settings,
    referenceDateYmd: todayInTimeZone(),
  };
}

export function openFinancialGoalModal(
  ctx: UiContext,
  existing: FinancialGoal | null,
  preset?: Partial<FinancialGoal>
): void {
  const snap = ctx.engine.getSnapshot();
  const ledgers = getActiveLedgers(ctx);
  const evalCtx = buildEvalContext(ctx);
  const trailing = estimateTrailingMonthlyMetrics(
    evalCtx.cashflowLogs,
    evalCtx.ledgers,
    evalCtx.referenceDateYmd
  );

  const base: Partial<FinancialGoal> = existing || preset || {
    goalType: 'net_worth',
    currency: 'TWD',
    expectedAnnualReturnPct: 5,
    fireSwrPct: 4,
    currentManualAmount: 0,
    linkedAssetIds: [],
    linkedLedgerId: DEFAULT_LEDGER_ID,
  };

  const body = openModal(existing ? `編輯財務目標 · ${existing.name}` : '新增財務目標');
  const form = document.createElement('form');
  form.className = 'reb-modal-form';

  const makeField = (labelText: string, inputEl: Node, subHint?: string) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.style.marginBottom = '0';
    const lbl = document.createElement('label');
    lbl.className = 'section-label';
    lbl.textContent = labelText;
    wrap.appendChild(lbl);
    wrap.appendChild(inputEl);
    if (subHint) {
      const h = document.createElement('div');
      h.className = 'muted';
      h.style.cssText = 'font-size:11px;margin-top:3px';
      h.textContent = subHint;
      wrap.appendChild(h);
    }
    return wrap;
  };

  const nameInp = document.createElement('input');
  nameInp.type = 'text';
  nameInp.maxLength = 60;
  nameInp.required = true;
  nameInp.placeholder = '例如：退休金 FIRE、日本旅遊基金、頭期款';
  nameInp.value = base.name || '';
  form.appendChild(makeField('目標名稱', nameInp));

  const typeSel = document.createElement('select');
  for (const key of Object.keys(GOAL_TYPE_META) as FinancialGoalType[]) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = `${GOAL_TYPE_META[key].label} — ${GOAL_TYPE_META[key].desc}`;
    if (key === (base.goalType || 'net_worth')) o.selected = true;
    typeSel.appendChild(o);
  }
  form.appendChild(makeField('目標追蹤方式', typeSel));

  // Target amount & currency row
  const targetInp = document.createElement('input');
  targetInp.type = 'number';
  targetInp.inputMode = 'decimal';
  targetInp.step = 'any';
  targetInp.min = '0.01';
  targetInp.required = true;
  targetInp.className = 'tnum';
  targetInp.placeholder = '例如：1000000';
  targetInp.value = base.targetAmount ? String(base.targetAmount) : '';

  const currSel = document.createElement('select');
  const enabledCurrs = normalizeEnabledCurrencies(snap.settings.enabledCurrencies);
  const currOptions =
    base.currency && !enabledCurrs.includes(base.currency)
      ? [...enabledCurrs, base.currency]
      : enabledCurrs;
  for (const c of currOptions) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    if (c === (base.currency || 'TWD')) o.selected = true;
    currSel.appendChild(o);
  }

  const rowTarget = document.createElement('div');
  rowTarget.className = 'row-2';
  rowTarget.appendChild(makeField('目標金額', targetInp));
  rowTarget.appendChild(makeField('計價幣別', currSel));
  form.appendChild(rowTarget);

  // FIRE section (only for 'fire')
  const fireWrap = document.createElement('div');
  fireWrap.className = 'goal-conditional-box';
  const swrInp = document.createElement('input');
  swrInp.type = 'number';
  swrInp.inputMode = 'decimal';
  swrInp.step = 'any';
  swrInp.min = '1';
  swrInp.max = '15';
  swrInp.className = 'tnum';
  swrInp.value = String(base.fireSwrPct ?? 4);
  const fireHintBtn = document.createElement('button');
  fireHintBtn.type = 'button';
  fireHintBtn.className = 'btn btn-tinted btn-sm';
  fireHintBtn.style.marginTop = '6px';
  const updateFireSuggestionBtn = () => {
    const swrVal = Number(swrInp.value || 4);
    const sug = computeSuggestedFireTargetTwd(trailing.annualizedConsumptionTwd, swrVal);
    if (sug && sug > 0) {
      fireHintBtn.style.display = '';
      fireHintBtn.textContent = `依近 12 月年支出自動填入建議目標（${fmtMoney(sug, ctx.state.masked)}）`;
    } else {
      fireHintBtn.style.display = 'none';
    }
  };
  fireHintBtn.addEventListener('click', () => {
    const sug = computeSuggestedFireTargetTwd(trailing.annualizedConsumptionTwd, Number(swrInp.value || 4));
    if (sug && sug > 0) {
      currSel.value = 'TWD';
      targetInp.value = String(sug);
      updatePreview();
    }
  });
  fireWrap.appendChild(
    makeField('安全提領率 SWR (%)', swrInp, '經典 4% 法則代表年支出的 25 倍')
  );
  fireWrap.appendChild(fireHintBtn);
  form.appendChild(fireWrap);

  // Ledger bucket section (only for 'ledger_bucket')
  const ledgerWrap = document.createElement('div');
  ledgerWrap.className = 'goal-conditional-box';
  const ledgerSel = document.createElement('select');
  for (const lg of ledgers) {
    const o = document.createElement('option');
    o.value = lg.id;
    o.textContent = lg.includeInNetWorth ? lg.name : `${lg.name}（獨立帳本）`;
    if (lg.id === (base.linkedLedgerId || DEFAULT_LEDGER_ID)) o.selected = true;
    ledgerSel.appendChild(o);
  }
  ledgerWrap.appendChild(makeField('綁定帳本', ledgerSel));
  form.appendChild(ledgerWrap);

  // Asset bucket section (only for 'asset_bucket')
  const assetWrap = document.createElement('div');
  assetWrap.className = 'goal-conditional-box';
  const assetListBox = document.createElement('div');
  assetListBox.className = 'goal-asset-checklist';
  const activeAssets = snap.assetItems
    .filter((a) => !a.deletedAt && !a.isWatchlist)
    .slice()
    .sort(compareBySortOrder);
  const selectedAssetSet = new Set(base.linkedAssetIds || []);
  const assetCheckboxes: HTMLInputElement[] = [];
  if (!activeAssets.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.fontSize = '12px';
    empty.textContent = '目前尚無可勾選的資產或活存帳戶，請先於資產頁新增。';
    assetListBox.appendChild(empty);
  } else {
    const ledgerNameMap = new Map(ledgers.map((l) => [l.id, l.name]));
    for (const a of activeAssets) {
      const lbl = document.createElement('label');
      lbl.className = 'goal-asset-check-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = a.id;
      cb.checked = selectedAssetSet.has(a.id);
      cb.addEventListener('change', () => updatePreview());
      const span = document.createElement('span');
      const lgTag =
        ledgers.length > 1 ? `[${ledgerNameMap.get(getEffectiveLedgerId(a)) || '主帳本'}] ` : '';
      span.textContent = `${lgTag}${a.itemName}（${a.subCategory} · ${a.currency}）`;
      lbl.appendChild(cb);
      lbl.appendChild(span);
      assetListBox.appendChild(lbl);
      assetCheckboxes.push(cb);
    }
  }
  assetWrap.appendChild(makeField('勾選納入目標的資產 / 活存', assetListBox));
  form.appendChild(assetWrap);

  // Manual amount section (only for 'manual')
  const manualWrap = document.createElement('div');
  manualWrap.className = 'goal-conditional-box';
  const manualInp = document.createElement('input');
  manualInp.type = 'number';
  manualInp.inputMode = 'decimal';
  manualInp.step = 'any';
  manualInp.min = '0';
  manualInp.className = 'tnum';
  manualInp.value = String(base.currentManualAmount ?? 0);
  manualWrap.appendChild(makeField('目前已累積金額（依計價幣別）', manualInp));
  form.appendChild(manualWrap);

  // Projection parameters row: expected return % + monthly contribution override
  const retInp = document.createElement('input');
  retInp.type = 'number';
  retInp.inputMode = 'decimal';
  retInp.step = 'any';
  retInp.min = '0';
  retInp.max = '30';
  retInp.className = 'tnum';
  retInp.value = String(base.expectedAnnualReturnPct ?? 0);

  const contribInp = document.createElement('input');
  contribInp.type = 'number';
  contribInp.inputMode = 'decimal';
  contribInp.step = 'any';
  contribInp.min = '0';
  contribInp.className = 'tnum';
  contribInp.placeholder =
    trailing.monthsCount > 0
      ? `留空＝自動 ${fmtMoney(trailing.avgMonthlySavingsTwd, ctx.state.masked)}/月`
      : '留空＝依近 12 月儲蓄';
  contribInp.value =
    base.monthlyContributionOverride !== null && base.monthlyContributionOverride !== undefined
      ? String(base.monthlyContributionOverride)
      : '';

  const rowProj = document.createElement('div');
  rowProj.className = 'row-2';
  rowProj.appendChild(makeField('預期年化報酬率 (%)', retInp, '0% 採線性計算；投資目標可設 4~7%'));
  rowProj.appendChild(makeField('每月投入（選填）', contribInp, '留空自動取近 12 月平均儲蓄'));
  form.appendChild(rowProj);

  // Target date (YYYY-MM) + note
  const dateInp = document.createElement('input');
  dateInp.type = 'month';
  dateInp.className = 'tnum';
  dateInp.value = base.targetDate || '';

  const noteInp = document.createElement('input');
  noteInp.type = 'text';
  noteInp.maxLength = 200;
  noteInp.placeholder = '選填備註';
  noteInp.value = base.note || '';

  const rowMeta = document.createElement('div');
  rowMeta.className = 'row-2';
  rowMeta.appendChild(makeField('期望達成月份（選填）', dateInp, '填寫可反推每月需存金額'));
  rowMeta.appendChild(makeField('備註', noteInp));
  form.appendChild(rowMeta);

  // Live preview box
  const previewBox = document.createElement('div');
  previewBox.className = 'stock-live-preview tnum';
  previewBox.style.cssText = 'display:flex;flex-direction:column;gap:4px;line-height:1.5';
  form.appendChild(previewBox);

  const syncVisibility = () => {
    const t = typeSel.value as FinancialGoalType;
    fireWrap.style.display = t === 'fire' ? 'block' : 'none';
    ledgerWrap.style.display = t === 'ledger_bucket' ? 'block' : 'none';
    assetWrap.style.display = t === 'asset_bucket' ? 'block' : 'none';
    manualWrap.style.display = t === 'manual' ? 'block' : 'none';
    updateFireSuggestionBtn();
  };

  const updatePreview = () => {
    previewBox.innerHTML = '';
    const t = typeSel.value as FinancialGoalType;
    const rawTarget = Number(targetInp.value);
    if (!Number.isFinite(rawTarget) || rawTarget <= 0) {
      const msg = document.createElement('div');
      msg.className = 'muted';
      msg.textContent = '輸入目標金額後即刻試算達成日期與每月應存金額。';
      previewBox.appendChild(msg);
      return;
    }

    const draft: FinancialGoal = {
      id: existing?.id || 'draft',
      name: nameInp.value.trim() || '試算目標',
      goalType: t,
      targetAmount: rawTarget,
      currency: currSel.value || 'TWD',
      linkedLedgerId: t === 'ledger_bucket' ? ledgerSel.value : null,
      linkedAssetIds:
        t === 'asset_bucket' ? assetCheckboxes.filter((c) => c.checked).map((c) => c.value) : [],
      currentManualAmount: t === 'manual' ? Math.max(0, Number(manualInp.value || 0)) : 0,
      expectedAnnualReturnPct: Math.min(30, Math.max(0, Number(retInp.value || 0))),
      monthlyContributionOverride: contribInp.value.trim() ? Number(contribInp.value) : null,
      fireSwrPct: t === 'fire' ? Number(swrInp.value || 4) : null,
      targetDate: dateInp.value.trim() || null,
      note: '',
      createdAt: '',
      updatedAt: '',
    };

    const prog = evaluateFinancialGoal(draft, evalCtx, trailing);
    const line1 = document.createElement('div');
    line1.textContent = `目前進度：${fmtMoney(prog.currentAmountTwd, ctx.state.masked)} / ${fmtMoney(prog.targetAmountTwd, ctx.state.masked)} (${ctx.state.masked ? '••%' : fmtPct(prog.progressPct, 1)})`;
    previewBox.appendChild(line1);

    const line2 = document.createElement('div');
    if (prog.projectionStatus === 'achieved') {
      line2.style.color = ctx.state.masked ? 'var(--text)' : 'var(--pos)';
      line2.textContent = '✓ 目前已達成此財務目標！';
    } else if (prog.projectionStatus === 'projected' && prog.monthsToTarget !== null) {
      line2.textContent = `推估達成：${prog.estimatedAchieveYm}（約 ${formatDurationMonths(prog.monthsToTarget)}，依月投入 ${fmtMoney(prog.monthlyContributionTwd, ctx.state.masked)}）`;
    } else {
      line2.style.color = 'var(--text-secondary)';
      line2.textContent = '以目前月投入與報酬率推估超過 100 年尚無法達標，可調高月投入金額。';
    }
    previewBox.appendChild(line2);

    if (draft.targetDate) {
      const line3 = document.createElement('div');
      if (prog.requiredMonthlyTwd !== null) {
        line3.textContent = `若於 ${draft.targetDate} 達標：每月需投入 ${fmtMoney(prog.requiredMonthlyTwd, ctx.state.masked)}`;
      } else {
        line3.textContent = `目標月份 ${draft.targetDate} 已屆期或早於本月。`;
      }
      previewBox.appendChild(line3);
    }
  };

  typeSel.addEventListener('change', () => {
    syncVisibility();
    updatePreview();
  });
  for (const elInp of [targetInp, currSel, swrInp, ledgerSel, manualInp, retInp, contribInp, dateInp]) {
    elInp.addEventListener('input', () => {
      if (elInp === swrInp) updateFireSuggestionBtn();
      updatePreview();
    });
    elInp.addEventListener('change', () => {
      if (elInp === swrInp) updateFireSuggestionBtn();
      updatePreview();
    });
  }

  syncVisibility();
  updatePreview();

  const footer = document.createElement('div');
  footer.className = 'reb-modal-footer';

  const leftBtn = document.createElement('button');
  leftBtn.type = 'button';
  leftBtn.className = 'btn btn-outline btn-sm';
  if (existing) {
    leftBtn.style.color = 'var(--danger)';
    leftBtn.textContent = '刪除目標';
    let deleting = false;
    leftBtn.addEventListener('click', async () => {
      if (deleting) return;
      if (!confirm(`確定刪除財務目標「${existing.name}」？`)) return;
      deleting = true;
      leftBtn.disabled = true;
      saveBtn.disabled = true;
      try {
        await ctx.engine.deleteFinancialGoal(existing.id);
        closeModal();
        showToast(`已刪除目標「${existing.name}」`, 'success');
        ctx.scheduleSync();
      } catch (err) {
        showToast(err instanceof Error ? err.message : '刪除目標失敗', 'error');
        deleting = false;
        leftBtn.disabled = false;
        saveBtn.disabled = false;
      }
    });
  } else {
    leftBtn.textContent = '取消';
    leftBtn.addEventListener('click', closeModal);
  }

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn btn-primary btn-sm';
  saveBtn.textContent = existing ? '儲存變更' : '建立目標';

  footer.appendChild(leftBtn);
  footer.appendChild(saveBtn);
  form.appendChild(footer);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    const t = typeSel.value as FinancialGoalType;
    try {
      const payload = validateFinancialGoalInput({
        name: nameInp.value,
        goalType: t,
        targetAmount: targetInp.value,
        currency: currSel.value,
        linkedLedgerId: t === 'ledger_bucket' ? ledgerSel.value : null,
        linkedAssetIds:
          t === 'asset_bucket' ? assetCheckboxes.filter((c) => c.checked).map((c) => c.value) : [],
        currentManualAmount: t === 'manual' ? manualInp.value : 0,
        expectedAnnualReturnPct: retInp.value,
        monthlyContributionOverride: contribInp.value.trim() ? contribInp.value : null,
        fireSwrPct: t === 'fire' ? swrInp.value : null,
        targetDate: dateInp.value.trim() || null,
        sortOrder: existing?.sortOrder,
        note: noteInp.value,
      });
      await ctx.engine.saveFinancialGoal({
        ...(existing ? { id: existing.id } : {}),
        ...payload,
      });
      closeModal();
      showToast(existing ? `已更新目標「${payload.name}」` : `已建立目標「${payload.name}」`, 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存目標失敗', 'error');
    }
  });

  body.appendChild(form);
}

function renderGoalItemCard(ctx: UiContext, prog: FinancialGoalProgress): HTMLElement {
  const masked = ctx.state.masked;
  const g = prog.goal;
  const item = document.createElement('div');
  item.className = 'goal-item';

  // Head row
  const head = document.createElement('div');
  head.className = 'goal-item-head';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'goal-item-title-wrap';
  const nameEl = document.createElement('strong');
  nameEl.className = 'goal-item-name';
  nameEl.textContent = g.name;
  const typeBadge = document.createElement('span');
  typeBadge.className = 'badge';
  typeBadge.style.marginRight = '0';
  typeBadge.textContent = GOAL_TYPE_META[g.goalType]?.label || g.goalType;
  titleWrap.appendChild(nameEl);
  titleWrap.appendChild(typeBadge);
  if (g.expectedAnnualReturnPct > 0) {
    const retBadge = document.createElement('span');
    retBadge.className = 'badge';
    retBadge.style.cssText = 'margin-right:0;background:var(--fill);color:var(--text-secondary)';
    retBadge.textContent = `年化 ${g.expectedAnnualReturnPct}%`;
    titleWrap.appendChild(retBadge);
  }

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn btn-outline btn-sm';
  editBtn.style.cssText = 'padding:3px 9px;font-size:11.5px;min-height:auto;flex-shrink:0';
  editBtn.textContent = '編輯';
  editBtn.addEventListener('click', () => openFinancialGoalModal(ctx, g));

  head.appendChild(titleWrap);
  head.appendChild(editBtn);
  item.appendChild(head);

  if (prog.missingReferenceWarning) {
    const warn = document.createElement('div');
    warn.className = 'goal-warn-note';
    warn.textContent = `⚠ ${prog.missingReferenceWarning}`;
    item.appendChild(warn);
  }

  // Amounts + pct row
  const amountsRow = document.createElement('div');
  amountsRow.className = 'goal-amounts-row tnum';
  const curTarget = document.createElement('span');
  curTarget.textContent = `${fmtMoney(prog.currentAmountTwd, masked)} / ${fmtMoney(prog.targetAmountTwd, masked)}`;
  const pctEl = document.createElement('strong');
  pctEl.textContent = masked ? '••%' : fmtPct(prog.progressPct, 1);
  if (!masked && prog.projectionStatus === 'achieved') {
    pctEl.style.color = 'var(--pos)';
  }
  amountsRow.appendChild(curTarget);
  amountsRow.appendChild(pctEl);
  item.appendChild(amountsRow);

  // Progress bar
  const track = document.createElement('div');
  track.className = 'goal-progress-track';
  const fill = document.createElement('div');
  fill.className =
    'goal-progress-fill' + (prog.projectionStatus === 'achieved' && !masked ? ' achieved' : '');
  fill.style.width = `${masked ? 0 : Math.min(100, Math.max(0, prog.progressPct))}%`;
  track.appendChild(fill);
  item.appendChild(track);

  // Projection footer
  const meta = document.createElement('div');
  meta.className = 'goal-meta-row tnum';
  const contribTag = prog.isAutoContribution ? '自動月均' : '自訂月投入';
  if (prog.projectionStatus === 'achieved') {
    meta.style.color = masked ? 'var(--text-secondary)' : 'var(--pos)';
    meta.textContent = '✓ 已達成目標！';
  } else if (prog.projectionStatus === 'projected' && prog.monthsToTarget !== null) {
    meta.textContent = `預計 ${prog.estimatedAchieveYm} 達成（約 ${formatDurationMonths(prog.monthsToTarget)}）· ${contribTag} ${fmtMoney(prog.monthlyContributionTwd, masked)}`;
  } else {
    meta.textContent = `以目前 ${contribTag} ${fmtMoney(prog.monthlyContributionTwd, masked)} 暫無法推估達成日`;
  }
  item.appendChild(meta);

  if (g.targetDate) {
    const tdRow = document.createElement('div');
    tdRow.className = 'goal-target-date-row tnum';
    if (prog.projectionStatus === 'achieved') {
      tdRow.textContent = `期望達成：${g.targetDate}（已提前達成）`;
    } else if (prog.requiredMonthlyTwd !== null) {
      const statusText = masked ? '' : prog.isOnTrack ? ' · 進度超前 ✓' : ' · 需加碼';
      tdRow.textContent = `目標 ${g.targetDate}：每月需存 ${fmtMoney(prog.requiredMonthlyTwd, masked)}${statusText}`;
      if (!masked) {
        tdRow.style.color = prog.isOnTrack ? 'var(--pos)' : 'var(--warning, #d97706)';
      }
    } else {
      tdRow.textContent = `目標月份 ${g.targetDate} 已過期（尚差 ${fmtMoney(prog.remainingTwd, masked)}）`;
    }
    item.appendChild(tdRow);
  }

  if (g.note) {
    const note = document.createElement('div');
    note.className = 'muted';
    note.style.fontSize = '11.5px';
    note.textContent = g.note;
    item.appendChild(note);
  }

  return item;
}

export function renderFinancialGoalsCard(ctx: UiContext, container: HTMLElement): void {
  const snap = ctx.engine.getSnapshot();
  const goals = (snap.financialGoals || [])
    .filter((g) => !g.deletedAt)
    .slice()
    .sort(compareBySortOrder);
  const evalCtx = buildEvalContext(ctx);
  const trailing = estimateTrailingMonthlyMetrics(
    evalCtx.cashflowLogs,
    evalCtx.ledgers,
    evalCtx.referenceDateYmd
  );

  container.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'card-header';
  head.style.marginBottom = '10px';

  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = '財務目標與達成推估';
  const sub = document.createElement('div');
  sub.className = 'muted tnum';
  sub.textContent =
    trailing.monthsCount > 0
      ? `近 ${trailing.monthsCount} 月平均月儲蓄 ${fmtMoney(trailing.avgMonthlySavingsTwd, ctx.state.masked)}`
      : '結合目前資產與月儲蓄，自動推估達成月份';
  titleWrap.appendChild(title);
  titleWrap.appendChild(sub);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-tinted btn-sm';
  addBtn.textContent = '+ 新增目標';
  addBtn.addEventListener('click', () => openFinancialGoalModal(ctx, null));

  head.appendChild(titleWrap);
  head.appendChild(addBtn);
  container.appendChild(head);

  if (!goals.length) {
    const empty = document.createElement('div');
    empty.className = 'goal-empty-box';
    const msg = document.createElement('div');
    msg.className = 'muted';
    msg.style.fontSize = '12.5px';
    msg.textContent = '設定存錢桶或 FIRE 財務目標，自動依儲蓄率與複利推估達成日期：';
    const presets = document.createElement('div');
    presets.className = 'quick-row';
    presets.style.cssText = 'justify-content:center;margin:8px 0 0';

    const fireSuggested = computeSuggestedFireTargetTwd(trailing.annualizedConsumptionTwd, 4) || 15_000_000;
    const presetSpecs: Array<{ label: string; preset: Partial<FinancialGoal> }> = [
      {
        label: '🔥 FIRE 財富自由',
        preset: {
          name: 'FIRE 財富自由',
          goalType: 'fire',
          targetAmount: fireSuggested,
          currency: 'TWD',
          expectedAnnualReturnPct: 6,
          fireSwrPct: 4,
        },
      },
      {
        label: '💰 第一桶金 100萬',
        preset: {
          name: '第一桶金',
          goalType: 'net_worth',
          targetAmount: 1_000_000,
          currency: 'TWD',
          expectedAnnualReturnPct: 5,
        },
      },
      {
        label: '✈️ 旅遊存錢桶',
        preset: {
          name: '旅遊基金',
          goalType: 'manual',
          targetAmount: 100_000,
          currency: 'TWD',
          currentManualAmount: 0,
          expectedAnnualReturnPct: 0,
        },
      },
    ];
    for (const sp of presetSpecs) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip-btn sm';
      chip.textContent = sp.label;
      chip.addEventListener('click', () => openFinancialGoalModal(ctx, null, sp.preset));
      presets.appendChild(chip);
    }

    empty.appendChild(msg);
    empty.appendChild(presets);
    container.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'goal-list';
  for (const g of goals) {
    const prog = evaluateFinancialGoal(g, evalCtx, trailing);
    list.appendChild(renderGoalItemCard(ctx, prog));
  }
  container.appendChild(list);
}
