import { buildAutocompleteSuggestions, resolveQuickTemplateForEntry } from '../../../shared/autocomplete';
import { getEffectiveLedgerId } from '../../../shared/calculations';
import { QUICK_ENTRY_TYPES, WEBAPP_CATEGORY_MAP } from '../../../shared/constants';
import { formatCurrencyRaw, isSupportedCurrency } from '../../../shared/currency';
import type { QuickEntryTemplate } from '../../../shared/types';
import {
  getEffectiveCategoriesForType,
  normalizeEnabledCurrencies,
  validateQuickTemplateInput,
} from '../../../shared/validation';
import { bindSubmit, closeModal, el, fmtMoney, fmtNum, openModal, showToast } from './helpers';
import { getActiveLedgers, resolveActiveLedger } from './ledgerUi';
import {
  getTodayYmd,
  renderLogCategories,
  renderLogCurrencyButtons,
  renderLogTab,
  updateFxPreview,
  updateSavingsPreview,
} from './logTab';
import type { UiContext } from './state';

const RECURRING_ELIGIBLE_LOG = ['其他收入', '投資流出', '固定支出'];

export function closeAutocompleteDropdown(): void {
  const dropdown = document.getElementById('itemNameSuggestions');
  if (!dropdown) return;
  dropdown.style.display = 'none';
  dropdown.innerHTML = '';
}

function syncLogFormTypeAndCurrencyDom(ctx: UiContext): void {
  document.querySelectorAll<HTMLButtonElement>('#logTypeChips .chip-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === ctx.state.logType);
  });
  document.querySelectorAll<HTMLButtonElement>('.curr-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.curr === ctx.state.logCurrency);
  });
  const showRec = RECURRING_ELIGIBLE_LOG.includes(ctx.state.logType);
  el('recurringToggleBox').style.display = showRec ? 'flex' : 'none';
  if (!showRec) el<HTMLInputElement>('makeRecurringCheckbox').checked = false;
}

export function openCustomCategoriesModal(ctx: UiContext, logType: string): void {
  const body = openModal(`自訂「${logType}」分類`);

  const hint = document.createElement('div');
  hint.className = 'muted';
  hint.style.cssText = 'font-size:12.5px;margin-bottom:12px';
  hint.textContent = '內建分類固定保留；刪除自訂分類不會影響已記帳的歷史紀錄。';
  body.appendChild(hint);

  const renderContent = () => {
    body.innerHTML = '';
    body.appendChild(hint);

    const snap = ctx.engine.getSnapshot();
    const defaults = WEBAPP_CATEGORY_MAP[logType] || ['其他'];
    const customMap = { ...(snap.settings.customCategories || {}) };
    const customList = [...(customMap[logType] || [])];

    const defHeading = document.createElement('div');
    defHeading.className = 'section-label';
    defHeading.textContent = '內建分類';
    body.appendChild(defHeading);

    const defChips = document.createElement('div');
    defChips.className = 'chip-group';
    for (const d of defaults) {
      const chip = document.createElement('span');
      chip.className = 'chip-btn sm cat-default-pill';
      chip.textContent = d;
      defChips.appendChild(chip);
    }
    body.appendChild(defChips);

    const cusHeading = document.createElement('div');
    cusHeading.className = 'section-label';
    cusHeading.textContent = `我的自訂分類 (${customList.length}/30)`;
    body.appendChild(cusHeading);

    if (!customList.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.style.cssText = 'font-size:12.5px;margin-bottom:12px';
      empty.textContent = '尚未新增自訂分類';
      body.appendChild(empty);
    } else {
      const cusChips = document.createElement('div');
      cusChips.className = 'chip-group';
      for (const name of customList) {
        const pill = document.createElement('span');
        pill.className = 'cat-custom-pill';
        const txt = document.createElement('span');
        txt.textContent = name;
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'cat-custom-del';
        del.setAttribute('aria-label', `刪除分類 ${name}`);
        del.textContent = '✕';
        let deleting = false;
        del.addEventListener('click', async () => {
          if (deleting) return;
          deleting = true;
          del.disabled = true;
          try {
            const latestMap = { ...(ctx.engine.getSnapshot().settings.customCategories || {}) };
            const latestList = [...(latestMap[logType] || [])];
            const nextList = latestList.filter((c) => c !== name);
            if (nextList.length) latestMap[logType] = nextList;
            else delete latestMap[logType];
            await ctx.engine.saveCustomCategories(latestMap);
            showToast(`已移除分類「${name}」`, 'success');
            ctx.scheduleSync();
            renderContent();
          } catch (err) {
            showToast(err instanceof Error ? err.message : '移除分類失敗', 'error');
            deleting = false;
            del.disabled = false;
          }
        });
        pill.appendChild(txt);
        pill.appendChild(del);
        cusChips.appendChild(pill);
      }
      body.appendChild(cusChips);
    }

    const form = document.createElement('form');
    form.className = 'cat-add-row';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = 20;
    inp.placeholder = '輸入新分類名稱（如：寵物、健身、育兒）';
    inp.required = true;
    const addBtn = document.createElement('button');
    addBtn.type = 'submit';
    addBtn.className = 'btn btn-primary btn-sm';
    addBtn.textContent = '+ 新增';
    form.appendChild(inp);
    form.appendChild(addBtn);

    bindSubmit(form, async (e) => {
      e.preventDefault();
      const name = inp.value.trim().slice(0, 20);
      if (!name) return;
      const latestMap = { ...(ctx.engine.getSnapshot().settings.customCategories || {}) };
      const latestList = [...(latestMap[logType] || [])];
      if (defaults.includes(name) || latestList.includes(name)) {
        showToast(`分類「${name}」已經存在`, 'error');
        return;
      }
      if (latestList.length >= 30) {
        showToast('每種交易類型最多可新增 30 個自訂分類', 'error');
        return;
      }
      try {
        const nextMap = { ...latestMap, [logType]: [...latestList, name] };
        if (ctx.state.logType === logType) {
          ctx.state.logCategory = name;
        }
        await ctx.engine.saveCustomCategories(nextMap);
        if (ctx.state.logType === logType) {
          renderLogCategories(ctx);
        }
        showToast(`已新增分類「${name}」`, 'success');
        ctx.scheduleSync();
        renderContent();
      } catch (err) {
        showToast(err instanceof Error ? err.message : '新增分類失敗', 'error');
      }
    });
    body.appendChild(form);
  };

  renderContent();
}

export function openQuickTemplateModal(
  ctx: UiContext,
  options?: { editTemplate?: QuickEntryTemplate; prefill?: Partial<QuickEntryTemplate> }
): void {
  const isSingleEdit = Boolean(options?.editTemplate || options?.prefill);
  const body = openModal(
    options?.editTemplate
      ? '編輯常用範本'
      : options?.prefill
        ? '儲存為常用記帳範本'
        : '常用記帳範本管理'
  );

  const renderManager = () => {
    body.innerHTML = '';
    const snap = ctx.engine.getSnapshot();
    const templates = snap.settings.quickTemplates || [];

    const topBar = document.createElement('div');
    topBar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px';
    const cnt = document.createElement('span');
    cnt.className = 'muted tnum';
    cnt.textContent = `已建立 ${templates.length} / 30 筆範本`;
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'btn btn-primary btn-sm';
    newBtn.textContent = '+ 新增範本';
    newBtn.addEventListener('click', () => renderEditor(null, undefined));
    topBar.appendChild(cnt);
    topBar.appendChild(newBtn);
    body.appendChild(topBar);

    if (!templates.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = '尚無常用範本，可在快速記帳頁填寫後點「存為範本」或點上方新增。';
      body.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'list-group';
    for (const tpl of templates) {
      const row = document.createElement('div');
      row.className = 'list-row';
      const main = document.createElement('div');
      main.className = 'item-main';
      const t = document.createElement('div');
      t.className = 'item-title';
      t.textContent = `${tpl.oneClick ? '⚡ ' : ''}${tpl.label}`;
      const sub = document.createElement('div');
      sub.className = 'item-sub tnum';
      const amtStr = tpl.amount ? formatCurrencyRaw(tpl.amount, tpl.currency, false) : '記帳時輸入金額';
      sub.textContent = `${tpl.type} · ${tpl.category} · ${tpl.itemName} · ${amtStr}`;
      main.appendChild(t);
      main.appendChild(sub);

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;flex-shrink:0';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-outline btn-sm';
      editBtn.textContent = '編輯';
      editBtn.addEventListener('click', () => renderEditor(tpl, undefined));
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-outline btn-sm';
      delBtn.style.color = 'var(--danger)';
      delBtn.textContent = '刪除';
      let deletingTpl = false;
      delBtn.addEventListener('click', async () => {
        if (deletingTpl) return;
        deletingTpl = true;
        delBtn.disabled = true;
        try {
          const latestTemplates = ctx.engine.getSnapshot().settings.quickTemplates || [];
          const next = latestTemplates.filter((x) => x.id !== tpl.id);
          await ctx.engine.saveQuickTemplates(next);
          showToast(`已刪除範本「${tpl.label}」`, 'success');
          ctx.scheduleSync();
          renderManager();
        } catch (err) {
          showToast(err instanceof Error ? err.message : '刪除範本失敗', 'error');
          deletingTpl = false;
          delBtn.disabled = false;
        }
      });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      row.appendChild(main);
      row.appendChild(actions);
      list.appendChild(row);
    }
    body.appendChild(list);
  };

  const renderEditor = (
    editing: QuickEntryTemplate | null,
    prefill?: Partial<QuickEntryTemplate>
  ) => {
    body.innerHTML = '';
    const snap = ctx.engine.getSnapshot();
    const activeLedger = resolveActiveLedger(ctx);
    const base: Partial<QuickEntryTemplate> = editing || prefill || {
      type: '日常花費',
      category: '餐飲',
      currency: 'TWD',
      ledgerId: activeLedger.id,
      linkedAccountId: ctx.state.logLinkedAccountId,
      oneClick: false,
    };

    const form = document.createElement('form');
    form.className = 'reb-modal-form';

    const makeField = (labelText: string, inputEl: Node) => {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      wrap.style.marginBottom = '0';
      const lbl = document.createElement('label');
      lbl.className = 'section-label';
      lbl.textContent = labelText;
      wrap.appendChild(lbl);
      wrap.appendChild(inputEl);
      return wrap;
    };

    const labelInp = document.createElement('input');
    labelInp.type = 'text';
    labelInp.maxLength = 24;
    labelInp.required = true;
    labelInp.placeholder = '例如：早安咖啡、中油加油';
    labelInp.value = base.label || base.itemName || '';
    form.appendChild(makeField('範本按鈕名稱', labelInp));

    const typeSel = document.createElement('select');
    const selectedType =
      base.type && QUICK_ENTRY_TYPES.includes(base.type) ? base.type : '日常花費';
    for (const t of QUICK_ENTRY_TYPES) {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t;
      if (t === selectedType) o.selected = true;
      typeSel.appendChild(o);
    }

    const catSel = document.createElement('select');
    const populateCats = (typeVal: string, selectedCat?: string) => {
      catSel.innerHTML = '';
      const cats = getEffectiveCategoriesForType(typeVal, snap.settings.customCategories);
      if (selectedCat && !cats.includes(selectedCat)) cats.unshift(selectedCat);
      for (const c of cats) {
        const o = document.createElement('option');
        o.value = c;
        o.textContent = c;
        if (c === selectedCat) o.selected = true;
        catSel.appendChild(o);
      }
    };
    populateCats(typeSel.value, base.category);
    typeSel.addEventListener('change', () => populateCats(typeSel.value));

    const rowTypeCat = document.createElement('div');
    rowTypeCat.className = 'row-2';
    rowTypeCat.appendChild(makeField('交易類型', typeSel));
    rowTypeCat.appendChild(makeField('分類', catSel));
    form.appendChild(rowTypeCat);

    const itemInp = document.createElement('input');
    itemInp.type = 'text';
    itemInp.maxLength = 80;
    itemInp.placeholder = '留空則同分類';
    itemInp.value = base.itemName || '';

    const amtInp = document.createElement('input');
    amtInp.type = 'number';
    amtInp.inputMode = 'decimal';
    amtInp.step = 'any';
    amtInp.min = '0.01';
    amtInp.className = 'tnum';
    amtInp.placeholder = '留空＝記帳時輸入';
    amtInp.value = base.amount !== null && base.amount !== undefined ? String(base.amount) : '';

    const currSel = document.createElement('select');
    const enabledCurrs = normalizeEnabledCurrencies(snap.settings.enabledCurrencies);
    const currOptions = base.currency && !enabledCurrs.includes(base.currency)
      ? [...enabledCurrs, base.currency]
      : enabledCurrs;
    for (const c of currOptions) {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      if (c === (base.currency || 'TWD')) o.selected = true;
      currSel.appendChild(o);
    }

    const rowAmt = document.createElement('div');
    rowAmt.className = 'row-2';
    rowAmt.appendChild(makeField('金額（選填）', amtInp));
    rowAmt.appendChild(makeField('幣別', currSel));
    form.appendChild(rowAmt);
    form.appendChild(makeField('項目名稱', itemInp));

    const accSel = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '不連動活存';
    accSel.appendChild(noneOpt);
    const targetLedgerId = base.ledgerId || activeLedger.id;
    // v1.15.0 review finding 5: a template can also charge a credit card (saved from a card entry)
    const savingsAccs = snap.assetItems.filter(
      (a) => !a.deletedAt && (a.isLinkedSavings || a.isCreditCard) && getEffectiveLedgerId(a) === targetLedgerId
    );
    for (const a of savingsAccs) {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.isCreditCard ? `💳 ${a.itemName}` : a.itemName;
      if (a.id === base.linkedAccountId) o.selected = true;
      accSel.appendChild(o);
    }
    form.appendChild(makeField('預設連動活存／信用卡', accSel));

    const noteInp = document.createElement('input');
    noteInp.type = 'text';
    noteInp.maxLength = 120;
    noteInp.placeholder = '備註（選填）';
    noteInp.value = base.note || '';
    form.appendChild(makeField('備註', noteInp));

    const oneClickLabel = document.createElement('label');
    oneClickLabel.className = 'tpl-oneclick-box';
    const oneClickCb = document.createElement('input');
    oneClickCb.type = 'checkbox';
    oneClickCb.checked = Boolean(base.oneClick);
    const oneClickText = document.createElement('span');
    oneClickText.textContent = '⚡ 啟用一鍵直記（點範本按鈕立刻以今天日期入帳，不需再按送出）';
    oneClickLabel.appendChild(oneClickCb);
    oneClickLabel.appendChild(oneClickText);
    form.appendChild(oneClickLabel);

    const footer = document.createElement('div');
    footer.className = 'reb-modal-footer';
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'btn btn-outline btn-sm';
    backBtn.textContent = isSingleEdit ? '取消' : '返回清單';
    backBtn.addEventListener('click', () => (isSingleEdit ? closeModal() : renderManager()));
    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'btn btn-primary btn-sm';
    saveBtn.textContent = editing ? '更新範本' : '儲存範本';
    footer.appendChild(backBtn);
    footer.appendChild(saveBtn);
    form.appendChild(footer);

    bindSubmit(form, async (e) => {
      e.preventDefault();
      try {
        const validated = validateQuickTemplateInput({
          id: editing?.id || crypto.randomUUID(),
          label: labelInp.value,
          type: typeSel.value,
          category: catSel.value,
          itemName: itemInp.value,
          amount: amtInp.value.trim() ? Number(amtInp.value) : null,
          currency: currSel.value,
          linkedAccountId: accSel.value || null,
          ledgerId: base.ledgerId || activeLedger.id,
          note: noteInp.value,
          oneClick: oneClickCb.checked,
        });
        const existingList = ctx.engine.getSnapshot().settings.quickTemplates || [];
        const nextList = editing
          ? existingList.map((x) => (x.id === editing.id ? validated : x))
          : [...existingList, validated];
        if (nextList.length > 30) {
          showToast('最多可建立 30 筆常用範本', 'error');
          return;
        }
        await ctx.engine.saveQuickTemplates(nextList);
        showToast(editing ? `已更新範本「${validated.label}」` : `已儲存範本「${validated.label}」`, 'success');
        ctx.scheduleSync();
        if (isSingleEdit) closeModal();
        else renderManager();
      } catch (err) {
        showToast(err instanceof Error ? err.message : '範本格式不正確', 'error');
      }
    });

    body.appendChild(form);
  };

  if (options?.editTemplate) {
    renderEditor(options.editTemplate);
  } else if (options?.prefill) {
    renderEditor(null, options.prefill);
  } else {
    renderManager();
  }
}

let oneClickBusy = false;

export function renderQuickTemplatesStrip(ctx: UiContext): void {
  const bar = document.getElementById('quickTemplatesBar');
  if (!bar) return;
  bar.innerHTML = '';

  const snap = ctx.engine.getSnapshot();
  const templates = snap.settings.quickTemplates || [];
  const ledgers = getActiveLedgers(ctx);

  for (const tpl of templates) {
    const target = resolveQuickTemplateForEntry(tpl, ctx.state.activeLedgerId, ledgers, snap.assetItems);
    if (ctx.engine.isLedgerReadOnly(target.ledgerId)) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tpl-pill tnum' + (tpl.oneClick ? ' one-click' : '');
    const amtHint =
      tpl.amount !== null && !ctx.state.masked
        ? ` ${tpl.currency === 'TWD' ? fmtNum(tpl.amount) : formatCurrencyRaw(tpl.amount, tpl.currency, false)}`
        : '';
    btn.textContent = `${tpl.oneClick ? '⚡ ' : ''}${tpl.label}${amtHint}`;
    btn.title = tpl.oneClick ? `一鍵直記：${tpl.itemName}` : `套用範本：${tpl.itemName}`;
    btn.addEventListener('click', async () => {
      if (!QUICK_ENTRY_TYPES.includes(tpl.type)) {
        showToast(`範本「${tpl.label}」的類型「${tpl.type}」不支援快速記帳，請先編輯範本調整類型。`, 'error');
        return;
      }

      const resolved = resolveQuickTemplateForEntry(tpl, ctx.state.activeLedgerId, ledgers, snap.assetItems);

      if (tpl.oneClick && tpl.amount !== null && tpl.amount > 0) {
        if (resolved.fallbackLedger || resolved.fallbackAccount) {
          const targetLabel = resolved.fallbackLedger ? '帳本' : '連動活存帳戶';
          showToast(
            `範本「${tpl.label}」綁定的${targetLabel}已異動或刪除，為避免記錯帳戶已中止一鍵直記，請先編輯範本重新指定。`,
            'error'
          );
          return;
        }
        if (oneClickBusy) return;
        oneClickBusy = true;
        try {
          const created = await ctx.engine.addCashFlow({
            date: getTodayYmd(),
            type: tpl.type,
            category: tpl.category,
            itemName: tpl.itemName || tpl.category,
            amount: tpl.amount,
            currency: tpl.currency,
            note: tpl.note,
            linkedAccountId: resolved.linkedAccountId,
            ledgerId: resolved.ledgerId,
          });
          showToast(
            `⚡ 已一鍵記帳：${created.itemName} (${fmtMoney(created.twdAmount, ctx.state.masked)})`,
            'success'
          );
          ctx.scheduleSync();
        } catch (err) {
          showToast(err instanceof Error ? err.message : '一鍵記帳失敗', 'error');
        } finally {
          oneClickBusy = false;
        }
        return;
      }

      // Fill form mode
      if (resolved.ledgerId !== ctx.state.activeLedgerId) {
        ctx.state.activeLedgerId = resolved.ledgerId;
        ctx.state.ledgerPage = 1;
        localStorage.setItem('finance_active_ledger_id', resolved.ledgerId);
      }
      ctx.state.logType = tpl.type;
      ctx.state.logCategory = tpl.category;
      ctx.state.logCurrency = tpl.currency || 'TWD';
      ctx.state.logLinkedAccountId = resolved.linkedAccountId;
      ctx.state.logLinkedAccountTouched = true;

      if (tpl.amount !== null) {
        el<HTMLInputElement>('amountInput').value = String(tpl.amount);
      }
      el<HTMLInputElement>('itemNameInput').value = tpl.itemName || '';
      el<HTMLInputElement>('noteInput').value = tpl.note || '';
      closeAutocompleteDropdown();
      renderLogCurrencyButtons(ctx);
      syncLogFormTypeAndCurrencyDom(ctx);
      renderLogCategories(ctx);
      renderLogTab(ctx);
      updateFxPreview(ctx);
      updateSavingsPreview(ctx);

      const fb = resolved.fallbackAccount || resolved.fallbackLedger ? '（已自動改用目前預設活存）' : '';
      showToast(`已套用範本「${tpl.label}」${fb}`);
      if (tpl.amount === null) {
        el<HTMLInputElement>('amountInput').focus();
      }
    });
    bar.appendChild(btn);
  }

  const manageBtn = document.createElement('button');
  manageBtn.type = 'button';
  manageBtn.className = 'tpl-pill manage';
  manageBtn.textContent = templates.length ? '⚙ 範本' : '+ 常用範本';
  manageBtn.addEventListener('click', () => openQuickTemplateModal(ctx));
  bar.appendChild(manageBtn);
}

export function bindQuickTemplatesAndAutocompleteEvents(ctx: UiContext): void {
  // Save current form as template button
  const saveTplBtn = document.getElementById('saveAsTemplateBtn');
  saveTplBtn?.addEventListener('click', () => {
    const rawAmt = parseFloat(el<HTMLInputElement>('amountInput').value);
    const itemVal = el<HTMLInputElement>('itemNameInput').value.trim();
    const noteVal = el<HTMLInputElement>('noteInput').value.trim();
    openQuickTemplateModal(ctx, {
      prefill: {
        label: (itemVal || ctx.state.logCategory).slice(0, 24),
        type: ctx.state.logType,
        category: ctx.state.logCategory,
        itemName: itemVal || ctx.state.logCategory,
        amount: !Number.isNaN(rawAmt) && rawAmt > 0 ? rawAmt : null,
        currency: ctx.state.logCurrency,
        linkedAccountId: ctx.state.logLinkedAccountId,
        ledgerId: ctx.state.activeLedgerId,
        note: noteVal,
        oneClick: false,
      },
    });
  });

  // Autocomplete on itemNameInput
  const input = document.getElementById('itemNameInput') as HTMLInputElement | null;
  const dropdown = document.getElementById('itemNameSuggestions');
  if (!input || !dropdown) return;

  let hideTimer: number | undefined;
  let activeIdx = -1;
  let isComposing = false;
  let currentButtons: HTMLButtonElement[] = [];

  const hide = () => {
    activeIdx = -1;
    currentButtons = [];
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
  };

  const syncActiveHighlight = () => {
    currentButtons.forEach((b, i) => {
      b.classList.toggle('active', i === activeIdx);
    });
  };

  const renderSuggestions = () => {
    if (isComposing) return;
    const snap = ctx.engine.getSnapshot();
    const suggestions = buildAutocompleteSuggestions(snap.cashflowLogs, {
      query: input.value,
      type: ctx.state.logType,
      activeLedgerId: ctx.state.activeLedgerId,
      todayYmd: getTodayYmd(),
      limit: 5,
    });
    if (!suggestions.length) {
      hide();
      return;
    }
    dropdown.innerHTML = '';
    activeIdx = -1;
    currentButtons = [];
    for (const s of suggestions) {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'ac-item';
      const left = document.createElement('span');
      left.className = 'ac-name';
      left.textContent = s.itemName;
      const right = document.createElement('span');
      right.className = 'ac-meta tnum';
      const amtTxt = formatCurrencyRaw(s.suggestedAmount, s.currency, ctx.state.masked);
      right.textContent = `${s.category} · ${amtTxt}`;
      opt.appendChild(left);
      opt.appendChild(right);
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault(); // prevent blur before click fires
      });
      opt.addEventListener('click', () => {
        input.value = s.itemName;
        const latestSnap = ctx.engine.getSnapshot();
        const effectiveCats = getEffectiveCategoriesForType(
          ctx.state.logType,
          latestSnap.settings.customCategories
        );
        if (s.type === ctx.state.logType && effectiveCats.includes(s.category)) {
          ctx.state.logCategory = s.category;
          renderLogCategories(ctx);
          const amtInput = el<HTMLInputElement>('amountInput');
          // Never overwrite an amount the user already typed
          if (!amtInput.value.trim() && s.suggestedAmount > 0 && isSupportedCurrency(s.currency)) {
            amtInput.value = String(s.suggestedAmount);
            ctx.state.logCurrency = s.currency;
            renderLogCurrencyButtons(ctx);
            syncLogFormTypeAndCurrencyDom(ctx);
            updateFxPreview(ctx);
          }
        }
        hide();
      });
      dropdown.appendChild(opt);
      currentButtons.push(opt);
    }
    dropdown.style.display = 'flex';
  };

  input.addEventListener('compositionstart', () => {
    isComposing = true;
  });
  input.addEventListener('compositionend', () => {
    isComposing = false;
    renderSuggestions();
  });
  input.addEventListener('input', renderSuggestions);
  input.addEventListener('focus', () => {
    window.clearTimeout(hideTimer);
    renderSuggestions();
  });
  input.addEventListener('blur', () => {
    hideTimer = window.setTimeout(hide, 160);
  });
  input.addEventListener('keydown', (e) => {
    if (isComposing) return;
    if (e.key === 'Escape') {
      hide();
      return;
    }
    if (!currentButtons.length || dropdown.style.display === 'none') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % currentButtons.length;
      syncActiveHighlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = activeIdx <= 0 ? currentButtons.length - 1 : activeIdx - 1;
      syncActiveHighlight();
    } else if (e.key === 'Enter' && activeIdx >= 0 && currentButtons[activeIdx]) {
      e.preventDefault();
      currentButtons[activeIdx].click();
    } else if (e.key === 'Enter') {
      hide();
    }
  });
}
