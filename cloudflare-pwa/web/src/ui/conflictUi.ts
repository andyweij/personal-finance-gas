import type { SyncConflict, SyncEntity } from '../../../shared/types';
import { closeModal, openModal, showToast } from './helpers';
import type { UiContext } from './state';

const ENTITY_LABELS: Record<SyncEntity, string> = {
  cashflow: '流水帳',
  recurring: '固定收支',
  sinking: '不定期攤提',
  asset: '資產 / 負債 / 活存',
  savings_adjustment: '活存存轉紀錄',
  stock_tx: '持股交易 / 配息',
  settings: '預算參數設定',
  utility_record: '水電分攤紀錄',
  utility_rents: '固定房租設定',
  ledger: '多帳本設定',
  financial_goal: '財務目標',
};

const FIELD_LABELS: Record<string, string> = {
  name: '名稱',
  itemName: '項目名稱',
  date: '日期',
  type: '類型',
  category: '分類',
  amount: '金額',
  twdAmount: '台幣金額',
  currency: '幣別',
  note: '備註',
  status: '狀態',
  cycle: '週期',
  billingSpec: '生效月份',
  postDay: '入帳日',
  totalAmount: '預估總額',
  months: '分攤月數',
  dueNote: '預計繳款月',
  majorType: '大類',
  subCategory: '細分類別',
  liquidity: '流動性',
  updateMode: '更新方式',
  quantityOrAmount: '餘額 / 股數',
  unitPrice: '單價',
  previousClose: '昨收價',
  costBasis: '原始總成本',
  ticker: '股票代碼',
  isWatchlist: '觀察清單',
  isLinkedSavings: '活存連動',
  balanceAnchorDate: '基準生效日',
  isDefaultSavings: '預設連動活存',
  ledgerId: '所屬帳本',
  includeInNetWorth: '計入個人總資產',
  excludeFromNetWorth: '單獨不計入總資產',
  isAmortizingLoan: '自動還本推算',
  loanAnnualRate: '年利率 (%)',
  loanMonthlyPayment: '每月月付金',
  loanBillingDay: '每月扣款日',
  monthlyDailyBudget: '每月消費預算',
  emergencyTargetMonths: '預備金目標(月)',
  usdTwdRate: 'USD/TWD 匯率',
  enabledCurrencies: '啟用幣別清單',
  fxRates: '多幣別匯率表',
  autoFxEnabled: '自動更新美元匯率',
  pnlColorScheme: '正負配色風格',
  customStockCategories: '自訂持股分類',
  rebalanceTargets: '再平衡目標比例',
  customCategories: '自訂記帳分類',
  quickTemplates: '常用記帳範本',
  stockCategory: '持股分類',
  sortOrder: '排序順序',
  shares: '股數',
  txType: '交易類型',
  fee: '手續費',
  period: '期別',
  curTotal: '本期總度數',
  cur6F: '6F 度數',
  totalElec: '總電費',
  totalWater: '總水費',
  rent6F: '6F 房租',
  rentA: '5A 房租',
  rentB: '5B 房租',
  rentC: '5C 房租',
  goalType: '目標類型',
  targetAmount: '目標金額',
  linkedLedgerId: '綁定帳本',
  linkedAssetIds: '綁定資產',
  currentManualAmount: '目前手動累積金額',
  expectedAnnualReturnPct: '預期年化報酬率 (%)',
  monthlyContributionOverride: '自訂每月投入',
  fireSwrPct: 'FIRE 提領率 (%)',
  targetDate: '期望達成日',
};

const IGNORED_DIFF_KEYS = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'version',
  'priceUpdatedAt',
  'fxUpdatedAt',
  'balanceAnchorAt',
  'recurringDedupKey',
  'yearMonth',
  'fxRate',
]);

function formatDiffVal(val: unknown): string {
  if (val === undefined || val === null || val === '') return '（空）';
  if (typeof val === 'boolean') return val ? '是' : '否';
  if (typeof val === 'number') return val.toLocaleString('zh-TW', { maximumFractionDigits: 4 });
  return String(val);
}

function getConflictTitle(conflict: SyncConflict): string {
  const src = conflict.clientPayload || conflict.serverRecord || {};
  const label = ENTITY_LABELS[conflict.entity] || conflict.entity;
  const name = src.itemName || src.name || src.period || src.date || (conflict.entity === 'settings' ? '全站預算參數' : conflict.recordId.slice(0, 8));
  return `${label}：${String(name)}`;
}

function computeChangedFields(conflict: SyncConflict): Array<{ label: string; localVal: string; serverVal: string }> {
  const client = conflict.clientPayload || {};
  const server = conflict.serverRecord || {};
  const keys = new Set<string>([...Object.keys(client), ...Object.keys(server)]);
  const diffs: Array<{ label: string; localVal: string; serverVal: string }> = [];

  for (const key of keys) {
    if (IGNORED_DIFF_KEYS.has(key)) continue;
    const lv = client[key];
    const sv = server[key];
    if (JSON.stringify(lv ?? null) === JSON.stringify(sv ?? null)) continue;
    diffs.push({
      label: FIELD_LABELS[key] || key,
      localVal: formatDiffVal(lv),
      serverVal: formatDiffVal(sv),
    });
  }
  return diffs;
}

export function openConflictsModal(ctx: UiContext): void {
  const conflicts = ctx.engine.getConflicts();
  const rejections = ctx.engine.getRejections();
  const frozenOutbox = ctx.engine.getFrozenOutbox();
  const totalIssues = conflicts.length + rejections.length + frozenOutbox.length;
  const body = openModal(
    frozenOutbox.length > 0
      ? `帳本已從備份還原（待處理變更 ${frozenOutbox.length}）`
      : conflicts.length > 0 && rejections.length > 0
        ? `同步異常處理（衝突 ${conflicts.length} · 失敗 ${rejections.length}）`
        : rejections.length > 0
          ? `同步失敗紀錄 (${rejections.length})`
          : `同步衝突處理 (${conflicts.length})`
  );

  if (totalIssues === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = '目前沒有任何同步衝突或失敗紀錄，所有裝置資料一致。';
    body.appendChild(empty);
    return;
  }

  if (frozenOutbox.length > 0) {
    const frozenCard = document.createElement('div');
    frozenCard.className = 'conflict-card';
    frozenCard.style.marginBottom = '14px';

    const head = document.createElement('div');
    head.className = 'conflict-head';
    const title = document.createElement('div');
    title.className = 'conflict-title';
    title.textContent = `雲端已透過「覆蓋還原」重設帳本，已暫停上傳本機 ${frozenOutbox.length} 筆離線異動`;
    const badge = document.createElement('span');
    badge.className = 'badge warn';
    badge.style.marginRight = '0';
    badge.textContent = `已凍結 ${frozenOutbox.length} 筆`;
    head.appendChild(title);
    head.appendChild(badge);
    frozenCard.appendChild(head);

    const desc = document.createElement('div');
    desc.className = 'conflict-del-note';
    desc.textContent =
      '目前畫面已載入雲端最新還原的帳本。請決定要捨棄這批還原前的本機待送變更，或將它們重新套用至目前還原後的帳本：';
    frozenCard.appendChild(desc);

    const actions = document.createElement('div');
    actions.className = 'conflict-actions';

    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'btn btn-outline btn-sm';
    discardBtn.textContent = '全部捨棄（保留還原資料）';
    discardBtn.addEventListener('click', async () => {
      discardBtn.disabled = true;
      await ctx.engine.discardFrozenOutbox();
      showToast('已捨棄還原前的待送變更，保留雲端還原資料', 'success');
      if (ctx.engine.getConflicts().length > 0 || ctx.engine.getRejections().length > 0) {
        openConflictsModal(ctx);
      } else {
        closeModal();
      }
    });

    const reapplyBtn = document.createElement('button');
    reapplyBtn.type = 'button';
    reapplyBtn.className = 'btn btn-primary btn-sm';
    reapplyBtn.textContent = `重新套用這 ${frozenOutbox.length} 筆變更`;
    reapplyBtn.addEventListener('click', async () => {
      reapplyBtn.disabled = true;
      const res = await ctx.engine.reapplyFrozenOutbox();
      if (res.ok) {
        if (res.skippedCount && res.skippedCount > 0) {
          showToast(
            `已重新套用 ${res.appliedCount ?? 0} 筆變更；${res.skippedCount} 筆因雲端已有較新版本未套用，已列入清單供檢視`,
            'success'
          );
        } else if ((res.appliedCount ?? 0) > 0) {
          showToast(`已將 ${res.appliedCount} 筆待送變更重新套用至目前帳本`, 'success');
        } else {
          // R-7: another tab already handled the frozen changes
          showToast('沒有需要重新套用的變更（可能已在其他分頁處理）', 'success');
        }
      } else if (!res.authRequired) {
        showToast(res.error || '重新套用同步未完全完成，稍後將自動重試', 'error');
      }
      if (
        ctx.engine.getConflicts().length > 0 ||
        ctx.engine.getRejections().length > 0 ||
        ctx.engine.getFrozenOutbox().length > 0
      ) {
        openConflictsModal(ctx);
      } else {
        closeModal();
      }
    });

    actions.appendChild(discardBtn);
    actions.appendChild(reapplyBtn);
    frozenCard.appendChild(actions);
    body.appendChild(frozenCard);
  }

  if (conflicts.length > 0) {
    const intro = document.createElement('div');
    intro.style.cssText =
      'padding:10px 12px;border-radius:11px;background:var(--surface-alt);margin-bottom:12px;font-size:12.5px;line-height:1.55;color:var(--text-secondary)';
    intro.textContent =
      '偵測到同一筆資料在你離線期間，另一台裝置也修改了雲端版本。為避免靜默覆蓋，請逐筆確認要保留哪一版：';
    body.appendChild(intro);

    const list = document.createElement('div');
    list.className = 'conflict-list';

    for (const c of conflicts) {
      const card = document.createElement('div');
      card.className = 'conflict-card';

      const head = document.createElement('div');
      head.className = 'conflict-head';
      const title = document.createElement('div');
      title.className = 'conflict-title';
      title.textContent = getConflictTitle(c);
      const ver = document.createElement('span');
      ver.className = 'badge warn';
      ver.style.marginRight = '0';
      ver.textContent = `本機基於 v${c.baseVersion} vs 雲端 v${c.serverVersion}`;
      head.appendChild(title);
      head.appendChild(ver);
      card.appendChild(head);

      if (c.op === 'delete') {
        const msg = document.createElement('div');
        msg.className = 'conflict-del-note';
        msg.textContent = '本機在離線時「刪除」了此筆紀錄，但雲端期間已被更新。';
        card.appendChild(msg);
      } else if (!c.serverRecord || c.serverRecord.deletedAt) {
        const msg = document.createElement('div');
        msg.className = 'conflict-del-note';
        msg.textContent = '雲端已將此筆紀錄刪除，但本機離線時有修改內容。';
        card.appendChild(msg);
      } else {
        const diffs = computeChangedFields(c);
        if (diffs.length) {
          const table = document.createElement('table');
          table.className = 'conflict-diff-table tnum';
          table.innerHTML = '<thead><tr><th>欄位</th><th>本機離線版</th><th>雲端最新版</th></tr></thead>';
          const tbody = document.createElement('tbody');
          for (const d of diffs) {
            const tr = document.createElement('tr');
            const td1 = document.createElement('td');
            td1.textContent = d.label;
            const td2 = document.createElement('td');
            td2.className = 'conflict-local-val';
            td2.textContent = d.localVal;
            const td3 = document.createElement('td');
            td3.className = 'conflict-server-val';
            td3.textContent = d.serverVal;
            tr.appendChild(td1);
            tr.appendChild(td2);
            tr.appendChild(td3);
            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
          card.appendChild(table);
        } else {
          const same = document.createElement('div');
          same.className = 'muted';
          same.style.fontSize = '12px';
          same.textContent = '兩邊內容幾乎相同（僅版號不同），建議直接採用雲端最新版。';
          card.appendChild(same);
        }
      }

      const actions = document.createElement('div');
      actions.className = 'conflict-actions';

      const keepServerBtn = document.createElement('button');
      keepServerBtn.type = 'button';
      keepServerBtn.className = 'btn btn-outline btn-sm';
      keepServerBtn.textContent = '採用雲端最新版';
      keepServerBtn.addEventListener('click', async () => {
        await ctx.engine.resolveConflictKeepServer(c.mutationId);
        showToast('已採用雲端最新版', 'success');
        if (ctx.engine.getConflicts().length > 0 || ctx.engine.getRejections().length > 0) {
          openConflictsModal(ctx);
        } else {
          closeModal();
        }
      });

      const keepLocalBtn = document.createElement('button');
      keepLocalBtn.type = 'button';
      keepLocalBtn.className = 'btn btn-primary btn-sm';
      keepLocalBtn.textContent = '保留本機離線版';
      keepLocalBtn.addEventListener('click', async () => {
        keepLocalBtn.disabled = true;
        const res = await ctx.engine.resolveConflictKeepLocal(c.mutationId);
        if (res.ok) {
          showToast('已以本機離線版升版並同步至雲端', 'success');
        } else if (!res.authRequired) {
          showToast(res.error || '已排入同步佇列，連網後自動上傳');
        }
        if (ctx.engine.getConflicts().length > 0 || ctx.engine.getRejections().length > 0) {
          openConflictsModal(ctx);
        } else {
          closeModal();
        }
      });

      actions.appendChild(keepServerBtn);
      actions.appendChild(keepLocalBtn);
      card.appendChild(actions);
      list.appendChild(card);
    }

    body.appendChild(list);
  }

  if (rejections.length > 0) {
    const rejIntro = document.createElement('div');
    rejIntro.style.cssText =
      'padding:10px 12px;border-radius:11px;background:var(--surface-alt);margin-bottom:12px;font-size:12.5px;line-height:1.55;color:var(--text-secondary)';
    if (conflicts.length > 0) rejIntro.style.marginTop = '14px';
    rejIntro.textContent =
      '以下本機異動被伺服器拒絕並已移出待同步佇列：新建紀錄已自動回滾；編輯或刪除遭拒時系統會自動從雲端還原最新狀態。您也可複製原輸入內容或手動重整雲端帳本：';
    body.appendChild(rejIntro);

    const rejList = document.createElement('div');
    rejList.className = 'conflict-list';

    for (const r of rejections) {
      const card = document.createElement('div');
      card.className = 'conflict-card';

      const head = document.createElement('div');
      head.className = 'conflict-head';
      const title = document.createElement('div');
      title.className = 'conflict-title';
      const entityLabel = ENTITY_LABELS[r.entity as SyncEntity] || r.entity;
      const itemTitle = String(
        r.clientPayload?.itemName || r.clientPayload?.name || r.clientPayload?.period || ''
      ).trim();
      title.textContent = itemTitle ? `${entityLabel} · ${itemTitle}` : `${entityLabel} (${r.recordId})`;
      const badge = document.createElement('span');
      badge.className =
        r.resolutionStatus === 'pending_resync' ||
        r.resolutionStatus === 'quarantined' ||
        r.resolutionStatus === 'skipped_newer' ||
        r.resolutionStatus === 'held_after_reject'
          ? 'badge warn'
          : 'badge red';
      badge.style.marginRight = '0';
      const statusLabel =
        r.resolutionStatus === 'rolled_back'
          ? '新建遭拒（已回滾）'
          : r.resolutionStatus === 'restored'
            ? '異動遭拒（已還原）'
            : r.resolutionStatus === 'pending_resync'
              ? '異動遭拒（待重整雲端）'
              : r.resolutionStatus === 'quarantined'
                ? '反覆失敗（已移出佇列）'
                : r.resolutionStatus === 'skipped_newer'
                  ? '還原前的編輯（已有較新版本，未套用）'
                  : r.resolutionStatus === 'held_after_reject'
                    ? '後續編輯（因前一筆遭拒已暫停）'
                    : r.isNewRecord
                  ? '新建遭拒（已回滾）'
                  : '異動遭拒（待重整雲端）';
      badge.textContent = statusLabel;
      head.appendChild(title);
      head.appendChild(badge);
      card.appendChild(head);

      const reason = document.createElement('div');
      reason.className = 'conflict-del-note';
      reason.textContent = `拒絕原因：${r.reason}`;
      card.appendChild(reason);

      const actions = document.createElement('div');
      actions.className = 'conflict-actions';

      if (r.clientPayload) {
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn btn-outline btn-sm';
        copyBtn.textContent = '複製內容';
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(JSON.stringify(r.clientPayload, null, 2));
            showToast('已複製該筆異動內容', 'success');
          } catch {
            showToast('瀏覽器不支援剪貼簿複製', 'error');
          }
        });
        actions.appendChild(copyBtn);
      }

      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'btn btn-outline btn-sm';
      dismissBtn.textContent = '清除此通知';
      dismissBtn.addEventListener('click', async () => {
        await ctx.engine.dismissRejection(r.mutationId);
        if (
          ctx.engine.getConflicts().length > 0 ||
          ctx.engine.getRejections().length > 0 ||
          ctx.engine.getFrozenOutbox().length > 0
        ) {
          openConflictsModal(ctx);
        } else {
          closeModal();
        }
      });

      const resyncBtn = document.createElement('button');
      resyncBtn.type = 'button';
      resyncBtn.className = 'btn btn-primary btn-sm';
      resyncBtn.textContent = '從雲端重整並清除';
      resyncBtn.addEventListener('click', async () => {
        resyncBtn.disabled = true;
        const res = await ctx.engine.syncNow(true);
        if (!res.ok) {
          resyncBtn.disabled = false;
          if (!res.authRequired) {
            showToast(res.error || '從雲端重整失敗，請確認網路後重試', 'error');
          }
          return;
        }
        await ctx.engine.dismissRejection(r.mutationId);
        showToast('已從雲端重整最新帳本', 'success');
        if (
          ctx.engine.getConflicts().length > 0 ||
          ctx.engine.getRejections().length > 0 ||
          ctx.engine.getFrozenOutbox().length > 0
        ) {
          openConflictsModal(ctx);
        } else {
          closeModal();
        }
      });

      actions.appendChild(dismissBtn);
      actions.appendChild(resyncBtn);
      card.appendChild(actions);
      rejList.appendChild(card);
    }

    body.appendChild(rejList);
  }

  // C7: Always provide a manual sync trigger even when pendingCount === 0 (e.g. while conflict/rejection cards are open)
  const pendingCount = ctx.engine.getStatus().pendingCount;
  const syncPendingBtn = document.createElement('button');
  syncPendingBtn.type = 'button';
  syncPendingBtn.className = 'btn btn-outline btn-sm';
  syncPendingBtn.style.cssText = 'width:100%;margin-top:12px;';
  syncPendingBtn.textContent =
    pendingCount > 0 ? `立即同步其餘 ${pendingCount} 筆待上傳異動` : '立即從雲端同步最新資料';
  syncPendingBtn.addEventListener('click', async () => {
    syncPendingBtn.disabled = true;
    const res = await ctx.engine.syncNow();
    if (res.ok) {
      showToast(pendingCount > 0 ? '待上傳異動已同步完成' : '已從雲端同步最新資料', 'success');
    } else if (!res.authRequired) {
      showToast(res.error || '同步失敗', 'error');
    }
    if (
      ctx.engine.getConflicts().length > 0 ||
      ctx.engine.getRejections().length > 0 ||
      ctx.engine.getFrozenOutbox().length > 0
    ) {
      openConflictsModal(ctx);
    } else {
      closeModal();
    }
  });
  body.appendChild(syncPendingBtn);
}
