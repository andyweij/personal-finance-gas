import { DEFAULT_LEDGER_ID } from '../../../shared/constants';
import { ensureActiveLedgers, getEffectiveLedgerId } from '../../../shared/calculations';
import type { Ledger } from '../../../shared/types';
import { closeModal, el, makeInputField, openModal, showToast } from './helpers';
import type { UiContext } from './state';

export function getActiveLedgers(ctx: UiContext): Ledger[] {
  return ensureActiveLedgers(ctx.engine.getSnapshot().ledgers);
}

export function resolveActiveLedger(ctx: UiContext): Ledger {
  const ledgers = getActiveLedgers(ctx);
  const found = ledgers.find((l) => l.id === ctx.state.activeLedgerId);
  if (found) return found;
  ctx.state.activeLedgerId = DEFAULT_LEDGER_ID;
  localStorage.setItem('finance_active_ledger_id', DEFAULT_LEDGER_ID);
  return ledgers[0];
}

export function renderLedgerSwitcherBar(
  ctx: UiContext,
  container: HTMLElement,
  opts: {
    mode: 'single' | 'scope';
    selectedValue: string;
    onSelect: (nextValue: string) => void;
    showManageButton?: boolean;
  }
): void {
  const ledgers = getActiveLedgers(ctx);
  container.innerHTML = '';
  container.className = 'ledger-bar';

  const pillsWrap = document.createElement('div');
  pillsWrap.className = 'ledger-pills-scroll';

  const addPill = (value: string, label: string, subTag?: string) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isActive = opts.selectedValue === value;
    btn.className = 'ledger-pill' + (isActive ? ' active' : '');
    const txt = document.createElement('span');
    txt.textContent = label;
    btn.appendChild(txt);
    if (subTag) {
      const tag = document.createElement('span');
      tag.className = 'ledger-pill-tag';
      tag.textContent = subTag;
      btn.appendChild(tag);
    }
    btn.addEventListener('click', () => {
      if (opts.selectedValue === value) return;
      opts.onSelect(value);
    });
    pillsWrap.appendChild(btn);
  };

  if (opts.mode === 'scope') {
    addPill('net_worth', '個人總資產帳本');
    for (const l of ledgers) {
      if (ledgers.length === 1 && l.id === DEFAULT_LEDGER_ID) continue;
      addPill(l.id, l.name, l.includeInNetWorth ? undefined : '獨立');
    }
    if (ledgers.length > 1) {
      addPill('all', '全部合併');
    }
  } else {
    for (const l of ledgers) {
      addPill(l.id, l.name, l.includeInNetWorth ? undefined : '獨立');
    }
  }

  container.appendChild(pillsWrap);

  if (opts.showManageButton !== false) {
    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'ledger-manage-btn';
    manageBtn.textContent = ledgers.length > 1 ? '⚙ 帳本' : '+ 新帳本';
    manageBtn.title = '新增或管理多帳本';
    manageBtn.addEventListener('click', () => openLedgerManagerModal(ctx));
    container.appendChild(manageBtn);
  }
}

export function openLedgerManagerModal(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const ledgers = getActiveLedgers(ctx);

  const body = openModal('多帳本管理');

  const intro = document.createElement('div');
  intro.className = 'stock-live-preview';
  intro.textContent =
    '可建立獨立帳本（如公帳、代管帳戶、副業或旅遊專戶），隔離流水帳與多項活存／資產，並設定是否納入「個人總資產與淨值統計」。';
  body.appendChild(intro);

  const listWrap = document.createElement('div');
  listWrap.className = 'list-group';
  listWrap.style.marginBottom = '14px';

  for (const l of ledgers) {
    const assetCount = snap.assetItems.filter(
      (a) => !a.deletedAt && !a.isWatchlist && getEffectiveLedgerId(a) === l.id
    ).length;
    const logCount = snap.cashflowLogs.filter(
      (c) => !c.deletedAt && getEffectiveLedgerId(c) === l.id
    ).length;
    const recCount = snap.recurringItems.filter(
      (r) => !r.deletedAt && getEffectiveLedgerId(r) === l.id
    ).length;

    const row = document.createElement('div');
    row.className = 'list-row';

    const main = document.createElement('div');
    main.className = 'item-main';
    const title = document.createElement('div');
    title.className = 'item-title';
    title.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';
    title.appendChild(document.createTextNode(l.name));

    const scopeBadge = document.createElement('span');
    scopeBadge.className = 'badge ' + (l.includeInNetWorth ? 'green' : 'warn');
    scopeBadge.style.marginRight = '0';
    scopeBadge.textContent = l.includeInNetWorth ? '計入個人總資產' : '獨立不計入總資產';
    title.appendChild(scopeBadge);

    if (l.id === DEFAULT_LEDGER_ID) {
      const defBadge = document.createElement('span');
      defBadge.className = 'badge';
      defBadge.style.marginRight = '0';
      defBadge.textContent = '預設';
      title.appendChild(defBadge);
    }

    const sub = document.createElement('div');
    sub.className = 'item-sub tnum';
    const budgetHint =
      l.monthlyDailyBudget !== null && l.monthlyDailyBudget !== undefined
        ? ` · 月預算 NT$ ${l.monthlyDailyBudget.toLocaleString('zh-TW')}`
        : '';
    sub.textContent = `${assetCount} 筆資產 · ${logCount} 筆流水 · ${recCount} 筆常態${budgetHint}${l.note ? ' · ' + l.note : ''}`;
    main.appendChild(title);
    main.appendChild(sub);

    const right = document.createElement('div');
    right.className = 'item-right';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-outline btn-sm';
    editBtn.textContent = '編輯';
    editBtn.addEventListener('click', () => openLedgerEditModal(ctx, l));
    right.appendChild(editBtn);

    row.appendChild(main);
    row.appendChild(right);
    listWrap.appendChild(row);
  }
  body.appendChild(listWrap);

  const footer = document.createElement('div');
  footer.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:8px';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-outline';
  closeBtn.textContent = '關閉';
  closeBtn.addEventListener('click', closeModal);
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-primary';
  addBtn.textContent = '+ 新增獨立帳本';
  addBtn.addEventListener('click', () => openLedgerEditModal(ctx, null));
  footer.appendChild(closeBtn);
  footer.appendChild(addBtn);
  body.appendChild(footer);
}

export function openLedgerEditModal(ctx: UiContext, existing: Ledger | null): void {
  const isDefault = existing?.id === DEFAULT_LEDGER_ID;
  const body = openModal(existing ? `編輯帳本 · ${existing.name}` : '新增帳本');
  const form = document.createElement('form');

  form.appendChild(
    makeInputField(
      '帳本名稱',
      'lgName',
      'text',
      existing?.name || '',
      '例如：代管公帳、副業帳本、旅遊專戶',
      true
    )
  );

  // Include in personal net worth toggle
  const nwLabel = document.createElement('label');
  nwLabel.style.cssText =
    'display:flex;align-items:center;gap:10px;padding:11px 13px;margin-bottom:14px;border-radius:12px;background:var(--surface-alt);border:0.5px solid var(--sep);font-size:13px;cursor:pointer;';
  const nwCb = document.createElement('input');
  nwCb.id = 'lgIncludeNw';
  nwCb.type = 'checkbox';
  nwCb.style.cssText = 'width:18px;height:18px;accent-color:var(--primary)';
  nwCb.checked = existing ? existing.includeInNetWorth : false;
  nwCb.disabled = isDefault;
  const nwTxt = document.createElement('span');
  nwTxt.innerHTML = isDefault
    ? '<strong>納入個人總資產與淨值統計（預設主帳本固定啟用）</strong><small style="display:block;color:var(--text-secondary);font-size:11px">個人主帳本會計入總覽、整合淨資產與月底歷史快照</small>'
    : '<strong>納入個人總資產與淨值統計</strong><small style="display:block;color:var(--text-secondary);font-size:11px">未勾選＝完全獨立帳本，其資產、活存與流水帳不會被算進你的個人總資產與儲蓄率</small>';
  nwLabel.appendChild(nwCb);
  nwLabel.appendChild(nwTxt);
  form.appendChild(nwLabel);

  if (!isDefault) {
    form.appendChild(
      makeInputField(
        '此帳本每月日常預算（選填，留空則顯示收支結餘摘要）',
        'lgBudget',
        'number',
        existing?.monthlyDailyBudget ?? '',
        '留空表示不設預算上限'
      )
    );
  }

  form.appendChild(
    makeInputField('備註（選填）', 'lgNote', 'text', existing?.note || '', '例如：協助管理帳戶、工作室營運資金')
  );

  const btns = document.createElement('div');
  btns.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:8px;margin-top:14px';

  if (existing && !isDefault) {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger';
    delBtn.textContent = '刪除帳本';
    delBtn.addEventListener('click', async () => {
      const snap = ctx.engine.getSnapshot();
      const linkedAssets = snap.assetItems.filter(
        (a) => !a.deletedAt && getEffectiveLedgerId(a) === existing.id
      ).length;
      const linkedLogs = snap.cashflowLogs.filter(
        (l) => !l.deletedAt && getEffectiveLedgerId(l) === existing.id
      ).length;
      const linkedRec = snap.recurringItems.filter(
        (r) => !r.deletedAt && getEffectiveLedgerId(r) === existing.id
      ).length;
      const total = linkedAssets + linkedLogs + linkedRec;

      let migrate = false;
      if (total > 0) {
        migrate = confirm(
          `帳本「${existing.name}」內尚有 ${total} 筆紀錄（${linkedAssets} 資產、${linkedLogs} 流水帳、${linkedRec} 常態收支）。\n\n按「確定」將這些紀錄全部移回「個人主帳本」並刪除此帳本；按「取消」放棄刪除。`
        );
        if (!migrate) return;
      } else {
        if (!confirm(`確定刪除空帳本「${existing.name}」？`)) return;
      }

      try {
        const res = await ctx.engine.deleteLedger(
          existing.id,
          migrate ? { migrateToLedgerId: DEFAULT_LEDGER_ID } : undefined
        );
        if (ctx.state.activeLedgerId === existing.id) {
          ctx.state.activeLedgerId = DEFAULT_LEDGER_ID;
          localStorage.setItem('finance_active_ledger_id', DEFAULT_LEDGER_ID);
          ctx.state.logLinkedAccountTouched = false;
        }
        if (ctx.state.assetsLedgerScope === existing.id) {
          ctx.state.assetsLedgerScope = 'net_worth';
        }
        if (ctx.state.overviewLedgerScope === existing.id) {
          ctx.state.overviewLedgerScope = 'net_worth';
        }
        if (ctx.state.recurringLedgerScope === existing.id) {
          ctx.state.recurringLedgerScope = 'all';
        }
        closeModal();
        showToast(
          res.migratedCount > 0
            ? `已將 ${res.migratedCount} 筆紀錄移回個人主帳本並刪除「${existing.name}」`
            : `已刪除帳本：${existing.name}`,
          'success'
        );
        ctx.scheduleSync();
      } catch (err) {
        showToast(err instanceof Error ? err.message : '刪除失敗', 'error');
      }
    });
    btns.appendChild(delBtn);
  } else {
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'btn btn-outline';
    backBtn.textContent = '返回';
    backBtn.addEventListener('click', () => openLedgerManagerModal(ctx));
    btns.appendChild(backBtn);
  }

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = existing ? '儲存帳本設定' : '建立帳本';
  btns.appendChild(saveBtn);
  form.appendChild(btns);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const budgetEl = document.getElementById('lgBudget') as HTMLInputElement | null;
      const rawBudget = budgetEl ? budgetEl.value.trim() : '';
      const saved = await ctx.engine.saveLedger({
        id: existing?.id,
        name: el<HTMLInputElement>('lgName').value.trim(),
        includeInNetWorth: isDefault ? true : nwCb.checked,
        monthlyDailyBudget: isDefault
          ? null
          : rawBudget !== ''
            ? Number(rawBudget)
            : null,
        note: el<HTMLInputElement>('lgNote').value.trim(),
      });
      if (!existing) {
        ctx.state.activeLedgerId = saved.id;
        localStorage.setItem('finance_active_ledger_id', saved.id);
        ctx.state.logLinkedAccountTouched = false;
      }
      closeModal();
      showToast(existing ? `已更新帳本：${saved.name}` : `已建立並切換至帳本：${saved.name}`, 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存失敗', 'error');
    }
  });

  body.appendChild(form);
}

export function buildLedgerSelectField(
  ctx: UiContext,
  selectId: string,
  selectedLedgerId: string,
  labelText = '所屬帳本'
): HTMLDivElement {
  const ledgers = getActiveLedgers(ctx);
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lbl = document.createElement('label');
  lbl.htmlFor = selectId;
  lbl.textContent = labelText;
  const sel = document.createElement('select');
  sel.id = selectId;
  for (const l of ledgers) {
    const opt = document.createElement('option');
    opt.value = l.id;
    opt.textContent = l.includeInNetWorth ? l.name : `${l.name}（獨立・不計入總資產）`;
    if (l.id === selectedLedgerId) opt.selected = true;
    sel.appendChild(opt);
  }
  wrap.appendChild(lbl);
  wrap.appendChild(sel);
  return wrap;
}
