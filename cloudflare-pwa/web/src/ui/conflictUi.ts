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
};

const FIELD_LABELS: Record<string, string> = {
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
  totalAmount: '預估總額',
  months: '分攤月數',
  dueNote: '預計繳款月',
  majorType: '大類',
  subCategory: '細分類別',
  liquidity: '流動性',
  updateMode: '更新方式',
  quantityOrAmount: '餘額 / 股數',
  unitPrice: '單價',
  costBasis: '原始總成本',
  ticker: '股票代碼',
  isLinkedSavings: '活存連動',
  balanceAnchorDate: '基準生效日',
  isDefaultSavings: '預設連動活存',
  isAmortizingLoan: '自動還本推算',
  loanAnnualRate: '年利率 (%)',
  loanMonthlyPayment: '每月月付金',
  loanBillingDay: '每月扣款日',
  monthlyDailyBudget: '每月消費預算',
  emergencyTargetMonths: '預備金目標(月)',
  usdTwdRate: 'USD/TWD 匯率',
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
  const name = src.itemName || src.period || src.date || (conflict.entity === 'settings' ? '全站預算參數' : conflict.recordId.slice(0, 8));
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
  const body = openModal(`同步衝突處理 (${conflicts.length})`);

  if (!conflicts.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = '目前沒有任何同步衝突，所有裝置資料一致。';
    body.appendChild(empty);
    return;
  }

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
      if (ctx.engine.getConflicts().length > 0) {
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
      if (ctx.engine.getConflicts().length > 0) {
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
