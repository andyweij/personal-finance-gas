import {
  UTILITY_MAIN_METER_MOD,
  UTILITY_SUB_METER_MOD,
  buildUtilityCsv,
  buildUtilityLineMessages,
  chainUtilityRecords,
  computeUtilityBill,
  didMeterRollover,
  nextUtilityPeriodCode,
  type ChainedUtilityRecord,
} from '../../../shared/rentUtility';
import { downloadTextFile, el, escapeHtml, showToast } from './helpers';
import { getTodayYmd } from './logTab';
import type { UiContext } from './state';

let formInitialized = false;
let lastBillTotal = 0;
let lastTenantTotal = 0;
let rentsSyncedToInputs = '';

function utNum(id: string): number {
  const v = el<HTMLInputElement>(id).value;
  if (v === '' || v === null || v === undefined) return Number.NaN;
  return Number(v);
}

function utFmt(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function utDollar(n: number, masked: boolean, digits = 0): string {
  if (masked) return '$••••';
  return '$' + utFmt(n, digits);
}

function getInputRents(): { rent6F: number; rentA: number; rentB: number; rentC: number } {
  return {
    rent6F: utNum('utRent6F') || 0,
    rentA: utNum('utRentA') || 0,
    rentB: utNum('utRentB') || 0,
    rentC: utNum('utRentC') || 0,
  };
}

function updatePrevHints(): void {
  const pairs: Array<[string, string, string]> = [
    ['utPrevTotal', 'utHintPrevTotal', '上期：'],
    ['utPrev6F', 'utHintPrev6F', '上期：'],
    ['utPrevA', 'utHintPrevA', ''],
    ['utPrevB', 'utHintPrevB', ''],
    ['utPrevC', 'utHintPrevC', ''],
  ];
  for (const [inId, hintId, prefix] of pairs) {
    const v = el<HTMLInputElement>(inId).value;
    el(hintId).textContent = prefix + (v !== '' ? Number(v).toLocaleString('zh-TW') : '-');
  }
}

export function fillNextUtilityFromLatest(ctx: UiContext): void {
  const chained = chainUtilityRecords(ctx.engine.getSnapshot().rentUtilityRecords || []);
  if (!chained.length) return;
  const latest = chained[chained.length - 1];
  el<HTMLInputElement>('utPeriod').value = nextUtilityPeriodCode(latest.period);
  el<HTMLInputElement>('utPrevTotal').value = String(latest.curTotal ?? '');
  el<HTMLInputElement>('utPrev6F').value = String(latest.cur6F ?? '');
  el<HTMLInputElement>('utPrevA').value = String(latest.curA ?? '');
  el<HTMLInputElement>('utPrevB').value = String(latest.curB ?? '');
  el<HTMLInputElement>('utPrevC').value = String(latest.curC ?? '');

  ['utCurTotal', 'utCur6F', 'utTotalElec', 'utTotalWater', 'utCurA', 'utCurB', 'utCurC'].forEach((id) => {
    el<HTMLInputElement>(id).value = '';
  });
  el<HTMLInputElement>('utF6People').value = String(latest.f6People ?? 2);
  el<HTMLInputElement>('utF5People').value = String(latest.f5People ?? 3);
  el('utModeBadge').textContent = `新增下一期（帶入 ${latest.period}）`;
  formInitialized = true;
  updatePrevHints();
  recalculateUtility(ctx);
}

function loadRecordToForm(ctx: UiContext, rec: ChainedUtilityRecord): void {
  if (rec.isBaseline) return;
  el<HTMLInputElement>('utPeriod').value = rec.period;
  el<HTMLInputElement>('utPrevTotal').value = String(rec.prevTotal);
  el<HTMLInputElement>('utCurTotal').value = String(rec.curTotal);
  el<HTMLInputElement>('utPrev6F').value = String(rec.prev6F);
  el<HTMLInputElement>('utCur6F').value = String(rec.cur6F);
  el<HTMLInputElement>('utTotalElec').value = String(rec.totalElec);
  el<HTMLInputElement>('utTotalWater').value = String(rec.totalWater);
  el<HTMLInputElement>('utF6People').value = String(rec.f6People);
  el<HTMLInputElement>('utF5People').value = String(rec.f5People);
  el<HTMLInputElement>('utPrevA').value = String(rec.prevA);
  el<HTMLInputElement>('utCurA').value = String(rec.curA);
  el<HTMLInputElement>('utPrevB').value = String(rec.prevB);
  el<HTMLInputElement>('utCurB').value = String(rec.curB);
  el<HTMLInputElement>('utPrevC').value = String(rec.prevC);
  el<HTMLInputElement>('utCurC').value = String(rec.curC);
  el('utModeBadge').textContent = `編輯 ${rec.period} 期`;
  formInitialized = true;
  updatePrevHints();
  recalculateUtility(ctx);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function recalculateUtility(ctx: UiContext): void {
  updatePrevHints();
  const masked = ctx.state.masked;
  const period = el<HTMLInputElement>('utPeriod').value.trim() || '本期';
  const d = {
    prevTotal: utNum('utPrevTotal'),
    curTotal: utNum('utCurTotal'),
    prev6F: utNum('utPrev6F'),
    cur6F: utNum('utCur6F'),
    totalElec: utNum('utTotalElec'),
    totalWater: utNum('utTotalWater'),
    f6People: utNum('utF6People'),
    f5People: utNum('utF5People'),
    prevA: utNum('utPrevA'),
    curA: utNum('utCurA'),
    prevB: utNum('utPrevB'),
    curB: utNum('utCurB'),
    prevC: utNum('utPrevC'),
    curC: utNum('utCurC'),
  };
  const rents = getInputRents();

  const infoBox = el('utInfoBox');
  const warnBox = el('utWarnBox');
  const checkStatus = el('utCheckStatus');
  const summaryStrip = el('utSummaryStrip');
  const resultCards = el('utResultCards');
  const lineSection = el('utLineSection');

  const requiredFilled = [
    d.prevTotal, d.curTotal, d.prev6F, d.cur6F,
    d.totalElec, d.totalWater, d.f6People, d.f5People,
  ].every((v) => Number.isFinite(v));
  const f5Filled = [d.prevA, d.curA, d.prevB, d.curB, d.prevC, d.curC].every((v) =>
    Number.isFinite(v)
  );

  if (!requiredFilled) {
    infoBox.classList.remove('show');
    warnBox.classList.remove('show');
    checkStatus.textContent = '等待輸入...';
    summaryStrip.textContent =
      '請在上方填入總表度數、6F 度數、總電費、總水費與 5F A/B/C 度數，分攤結果將即時計算（離線亦可操作）。';
    resultCards.innerHTML = '';
    lineSection.style.display = 'none';
    return;
  }

  const r = computeUtilityBill(d);
  const infos: string[] = [];
  const warnings: string[] = [];

  if (didMeterRollover(d.curTotal, d.prevTotal, UTILITY_MAIN_METER_MOD)) {
    infos.push(`🔄 總表滿 100,000 度歸零（${d.prevTotal} → ${d.curTotal}），自動換算為 ${utFmt(r.totalKwh)} 度。`);
  }
  if (didMeterRollover(d.cur6F, d.prev6F, UTILITY_SUB_METER_MOD)) {
    infos.push(`🔄 6F 分表滿 10,000 度歸零（${d.prev6F} → ${d.cur6F}），自動換算為 ${utFmt(r.f6Kwh)} 度。`);
  }
  if (f5Filled) {
    if (didMeterRollover(d.curA, d.prevA, UTILITY_SUB_METER_MOD)) {
      infos.push(`🔄 5F-A 房滿 10,000 度歸零（${d.prevA} → ${d.curA}），自動換算為 ${utFmt(r.aKwh)} 度。`);
    }
    if (didMeterRollover(d.curB, d.prevB, UTILITY_SUB_METER_MOD)) {
      infos.push(`🔄 5F-B 房滿 10,000 度歸零（${d.prevB} → ${d.curB}），自動換算為 ${utFmt(r.bKwh)} 度。`);
    }
    if (didMeterRollover(d.curC, d.prevC, UTILITY_SUB_METER_MOD)) {
      infos.push(`🔄 5F-C 房滿 10,000 度歸零（${d.prevC} → ${d.curC}），自動換算為 ${utFmt(r.cKwh)} 度。`);
    }
  }

  if (d.curTotal < 0 || d.cur6F < 0 || (f5Filled && (d.curA < 0 || d.curB < 0 || d.curC < 0))) {
    warnings.push('⚠️ 電表度數不能為負數，請檢查輸入！');
  }
  if (r.totalKwh <= 0) warnings.push('⚠️ 總表本期用量為 0，請確認總表度數！');
  if (r.f5Kwh <= 0) warnings.push('⚠️ 計算出的 5F 用量 ≤ 0，請確認 6F 或總表度數！');
  if (f5Filled && r.pubKwh < 0) {
    warnings.push('⚠️ 5F 三房加總超過 5F 總用電（公用度數為負），請檢查是否少打位數！');
  }

  infoBox.textContent = infos.join('\n');
  infoBox.style.whiteSpace = 'pre-line';
  infoBox.classList.toggle('show', infos.length > 0);
  warnBox.textContent = warnings.join('\n');
  warnBox.style.whiteSpace = 'pre-line';
  warnBox.classList.toggle('show', warnings.length > 0);

  const totalBill = d.totalElec + d.totalWater;
  lastBillTotal = totalBill;

  summaryStrip.innerHTML = '';
  const stripItems = [
    `總用電：${utFmt(r.totalKwh)} 度（6F ${utFmt(r.f6Kwh)} / 5F ${utFmt(r.f5Kwh)}）`,
    `平均電價：${utFmt(r.avgRate, 2)} 元/度`,
    `整棟總計：${utDollar(totalBill, masked)}`,
  ];
  if (f5Filled) {
    stripItems.push(`5F 公用電：${utFmt(r.pubKwh)} 度（每房 ${utDollar(r.pubEachElec, masked, 1)}）`);
  }
  for (const txt of stripItems) {
    const sp = document.createElement('span');
    sp.textContent = txt;
    summaryStrip.appendChild(sp);
  }

  resultCards.innerHTML = '';

  const f6Card = document.createElement('div');
  f6Card.className = 'ut-res-card f6';
  f6Card.innerHTML = `
    <div class="ut-res-who"><span>🏢 6F 應繳水電</span><span class="badge green">${d.f6People} 人</span></div>
    <div class="ut-res-amt">${utDollar(r.f6Total, masked)}</div>
    <div class="ut-res-exact">整數收費，無小數差額</div>
    <ul class="ut-res-ul">
      <li><span>用電度數</span><strong>${utFmt(r.f6Kwh)} 度</strong></li>
      <li><span>6F 電費</span><strong>${utDollar(r.f6Elec, masked)}</strong></li>
      <li><span>6F 水費</span><strong>${utDollar(r.f6Water, masked)}</strong></li>
    </ul>
    ${rents.rent6F > 0 ? `<div class="ut-rent-total"><span>含房租 (${utDollar(rents.rent6F, masked)})</span><span>${utDollar(r.f6Total + rents.rent6F, masked)}</span></div>` : ''}
  `;
  resultCards.appendChild(f6Card);

  if (f5Filled) {
    const rooms = [
      { name: '5F - A 房', kwh: r.aKwh, priv: r.aPriv, total: r.aTotal, rent: rents.rentA },
      { name: '5F - B 房', kwh: r.bKwh, priv: r.bPriv, total: r.bTotal, rent: rents.rentB },
      { name: '5F - C 房', kwh: r.cKwh, priv: r.cPriv, total: r.cTotal, rent: rents.rentC },
    ];
    for (const rm of rooms) {
      const rounded = Math.round(rm.total);
      const card = document.createElement('div');
      card.className = 'ut-res-card f5';
      card.innerHTML = `
        <div class="ut-res-who"><span>🚪 ${escapeHtml(rm.name)}</span><span class="badge">${utFmt(rm.kwh)} 度</span></div>
        <div class="ut-res-amt">${utDollar(rounded, masked)}</div>
        <div class="ut-res-exact">精確：${utDollar(rm.total, masked, 2)}（四捨五入）</div>
        <ul class="ut-res-ul">
          <li><span>私人電費</span><strong>${utDollar(rm.priv, masked, 1)}</strong></li>
          <li><span>公用電費</span><strong>${utDollar(r.pubEachElec, masked, 1)}</strong></li>
          <li><span>分攤水費</span><strong>${utDollar(r.waterEach, masked, 0)}</strong></li>
        </ul>
        ${rm.rent > 0 ? `<div class="ut-rent-total"><span>含房租 (${utDollar(rm.rent, masked)})</span><span>${utDollar(rounded + rm.rent, masked)}</span></div>` : ''}
      `;
      resultCards.appendChild(card);
    }

    const sumRounded = r.f6Total + Math.round(r.aTotal) + Math.round(r.bTotal) + Math.round(r.cTotal);
    lastTenantTotal = sumRounded;
    const roundDiff = sumRounded - totalBill;
    checkStatus.textContent =
      Math.abs(r.checkDiff) < 0.05
        ? `✅ 驗算無誤（差額 ${roundDiff >= 0 ? '+' : ''}${roundDiff} 元）`
        : `⚠️ 驗算差額 $${r.checkDiff}`;

    const { line6F, line5F } = buildUtilityLineMessages(period, d, r, rents);
    el('utLine6F').textContent = line6F;
    el('utLine5F').textContent = line5F;
    lineSection.style.display = 'block';
  } else {
    const f5Card = document.createElement('div');
    f5Card.className = 'ut-res-card';
    f5Card.style.display = 'flex';
    f5Card.style.alignItems = 'center';
    f5Card.style.fontSize = '12.5px';
    f5Card.style.color = 'var(--text-muted)';
    f5Card.textContent = `5F 整層合計 ${utDollar(r.f5Total, masked)}（電 ${utDollar(r.f5Elec, masked)} ＋ 水 ${utDollar(r.f5Water, masked)}）— 繼續填 A/B/C 度數即算各房分攤`;
    resultCards.appendChild(f5Card);
    checkStatus.textContent = '待填 5F 各房度數';
    lineSection.style.display = 'none';
  }
}

export function renderUtilityTab(ctx: UiContext): void {
  const snap = ctx.engine.getSnapshot();
  const chained = chainUtilityRecords(snap.rentUtilityRecords || []);
  const rents = snap.rentUtilityRents;
  const masked = ctx.state.masked;

  // 若雲端租金版本更新，同步至輸入欄（避免蓋掉使用者輸入中內容）
  const rentStamp = `${rents.updatedAt}|${rents.rent6F}|${rents.rentA}|${rents.rentB}|${rents.rentC}`;
  if (rents && rentStamp !== rentsSyncedToInputs) {
    el<HTMLInputElement>('utRent6F').value = String(rents.rent6F || 0);
    el<HTMLInputElement>('utRentA').value = String(rents.rentA || 0);
    el<HTMLInputElement>('utRentB').value = String(rents.rentB || 0);
    el<HTMLInputElement>('utRentC').value = String(rents.rentC || 0);
    rentsSyncedToInputs = rentStamp;
  }

  const nonBase = chained.filter((x) => !x.isBaseline);
  el('utSyncStatus').textContent =
    chained.length > 0
      ? `已載入本機快取（共 ${nonBase.length} 期，支援 0ms 離線計算與自動同步）`
      : '尚無水電紀錄，連線同步後將自動載入歷史抄表';

  if (!formInitialized && chained.length > 0) {
    fillNextUtilityFromLatest(ctx);
  } else {
    recalculateUtility(ctx);
  }

  const tbody = el('utHistoryBody');
  tbody.innerHTML = '';
  const reversed = nonBase.slice().reverse();
  if (!reversed.length) {
    tbody.innerHTML =
      '<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:16px">尚無抄表紀錄</td></tr>';
    return;
  }

  for (const rec of reversed) {
    const r = computeUtilityBill(rec);
    const tr = document.createElement('tr');
    const cells = [
      rec.period,
      `${utFmt(rec.curTotal)} (+${utFmt(r.totalKwh)})`,
      `${utFmt(rec.cur6F)} (+${utFmt(r.f6Kwh)})`,
      utDollar(rec.totalElec, masked),
      utDollar(rec.totalWater, masked),
      utDollar(r.f6Total, masked),
      utDollar(Math.round(r.aTotal), masked),
      utDollar(Math.round(r.bTotal), masked),
      utDollar(Math.round(r.cTotal), masked),
    ];
    cells.forEach((val, ci) => {
      const td = document.createElement('td');
      td.textContent = val;
      if (ci === 0) td.style.fontWeight = '700';
      if (ci === 5) {
        td.style.color = 'var(--success)';
        td.style.fontWeight = '700';
      }
      if (ci >= 6 && ci <= 8) {
        td.style.color = 'var(--primary)';
        td.style.fontWeight = '700';
      }
      tr.appendChild(td);
    });

    const opTd = document.createElement('td');
    opTd.style.display = 'flex';
    opTd.style.gap = '4px';
    opTd.style.justifyContent = 'flex-end';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-outline btn-sm';
    editBtn.textContent = '編';
    editBtn.addEventListener('click', () => loadRecordToForm(ctx, rec));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.textContent = '刪';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`確定刪除 ${rec.period} 期的抄表紀錄？（刪除後將自動重接下期上期度數）`)) return;
      try {
        await ctx.engine.deleteUtilityRecord(rec.period);
        fillNextUtilityFromLatest(ctx);
        showToast(`已刪除 ${rec.period} 期並自動重接下期`, 'success');
        ctx.scheduleSync();
      } catch (err) {
        showToast(err instanceof Error ? err.message : '刪除失敗', 'error');
      }
    });

    opTd.appendChild(editBtn);
    opTd.appendChild(delBtn);
    tr.appendChild(opTd);
    tbody.appendChild(tr);
  }
}

function copyLineBox(elId: string): void {
  const txt = el(elId).textContent || '';
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast('已複製，可直接貼到 LINE！', 'success');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(txt)
      .then(() => showToast('已複製，可直接貼到 LINE！', 'success'))
      .catch(fallback);
  } else {
    fallback();
  }
}

export function bindUtilityTabEvents(ctx: UiContext): void {
  const inputIds = [
    'utPeriod', 'utTotalElec', 'utTotalWater', 'utF6People', 'utF5People',
    'utCurTotal', 'utCur6F', 'utPrevTotal', 'utPrev6F',
    'utCurA', 'utCurB', 'utCurC', 'utPrevA', 'utPrevB', 'utPrevC',
    'utRent6F', 'utRentA', 'utRentB', 'utRentC',
  ];
  for (const id of inputIds) {
    el(id).addEventListener('input', () => recalculateUtility(ctx));
  }

  el('utNewPeriodBtn').addEventListener('click', () => fillNextUtilityFromLatest(ctx));

  el('utExportCsvBtn').addEventListener('click', () => {
    const chained = chainUtilityRecords(ctx.engine.getSnapshot().rentUtilityRecords || []);
    downloadTextFile('5F6F水電費分攤紀錄.csv', buildUtilityCsv(chained), 'text/csv;charset=utf-8;');
    showToast('已匯出 5F6F水電費分攤紀錄.csv', 'success');
  });

  el('utClearBtn').addEventListener('click', () => {
    ['utCurTotal', 'utCur6F', 'utTotalElec', 'utTotalWater', 'utCurA', 'utCurB', 'utCurC'].forEach((id) => {
      el<HTMLInputElement>(id).value = '';
    });
    recalculateUtility(ctx);
  });

  el('utSaveRentsBtn').addEventListener('click', async () => {
    try {
      await ctx.engine.saveUtilityRents(getInputRents());
      showToast('固定月租金已儲存（自動同步至 D1）', 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存月租金失敗', 'error');
    }
  });

  el('utSaveBtn').addEventListener('click', async () => {
    const period = el<HTMLInputElement>('utPeriod').value.trim();
    if (!period) {
      showToast('請先填寫期別（例如 11511）', 'error');
      return;
    }
    const payload = {
      period,
      prevTotal: utNum('utPrevTotal'),
      curTotal: utNum('utCurTotal'),
      prev6F: utNum('utPrev6F'),
      cur6F: utNum('utCur6F'),
      totalElec: utNum('utTotalElec'),
      totalWater: utNum('utTotalWater'),
      f6People: utNum('utF6People'),
      f5People: utNum('utF5People'),
      prevA: utNum('utPrevA'),
      curA: utNum('utCurA'),
      prevB: utNum('utPrevB'),
      curB: utNum('utCurB'),
      prevC: utNum('utPrevC'),
      curC: utNum('utCurC'),
    };
    if (
      Object.entries(payload).some(([k, v]) => k !== 'period' && !Number.isFinite(Number(v)))
    ) {
      showToast('請先把本期所有度數與帳單金額填完整再儲存', 'error');
      return;
    }
    try {
      await ctx.engine.saveUtilityRecord(payload);
      await ctx.engine.saveUtilityRents(getInputRents());
      showToast(`${period} 期已儲存並加入雲端同步佇列！`, 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存失敗', 'error');
    }
  });

  el('utCopy6FBtn').addEventListener('click', () => copyLineBox('utLine6F'));
  el('utCopy5FBtn').addEventListener('click', () => copyLineBox('utLine5F'));

  el('utPostExpenseBtn').addEventListener('click', async () => {
    const period = el<HTMLInputElement>('utPeriod').value.trim() || '本期';
    const amount = Math.round(lastBillTotal);
    if (amount <= 0) {
      showToast('請先算出本期水電帳單總額', 'error');
      return;
    }
    if (!confirm(`要將「${period}期 5F&6F 台電與水費帳單」NT$ ${utFmt(amount)} 寫入個人現金流支出嗎？`)) return;
    try {
      await ctx.engine.addCashFlow({
        date: getTodayYmd(),
        type: '固定支出',
        category: '水電瓦斯/管理費',
        itemName: `${period}期 5F&6F 台電與水費帳單`,
        amount,
        currency: 'TWD',
        note: `由 5F&6F 水電計算機匯入 (${period}期)`,
      });
      showToast(`已寫入流水帳：水電帳單支出 NT$ ${utFmt(amount)}`, 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '寫入失敗', 'error');
    }
  });

  el('utPostIncomeBtn').addEventListener('click', async () => {
    const period = el<HTMLInputElement>('utPeriod').value.trim() || '本期';
    const amount = Math.round(lastTenantTotal);
    if (amount <= 0) {
      showToast('請先算出本期各房應繳總額', 'error');
      return;
    }
    if (!confirm(`要將「${period}期 房客代收水電費」NT$ ${utFmt(amount)} 寫入個人現金流其他收入嗎？`)) return;
    try {
      await ctx.engine.addCashFlow({
        date: getTodayYmd(),
        type: '其他收入',
        category: '房租收入',
        itemName: `${period}期 房客代收水電費`,
        amount,
        currency: 'TWD',
        note: `由 5F&6F 水電計算機匯入 (${period}期)`,
      });
      showToast(`已寫入流水帳：代收水電收入 NT$ ${utFmt(amount)}`, 'success');
      ctx.scheduleSync();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '寫入失敗', 'error');
    }
  });
}
