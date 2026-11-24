import { exportCashFlowCsv } from '../../../shared/csv';
import {
  loginWithPasskey,
  loginWithPassword,
  logoutSession,
  registerPasskey,
  savePinConfig,
  setupMasterPassword,
  verifyOfflinePin,
} from '../auth/authClient';
import {
  closeModal,
  downloadTextFile,
  el,
  EYE_OFF_SVG,
  EYE_OPEN_SVG,
  makeInputField,
  openModal,
  setLoading,
  showToast,
} from './helpers';
import type { UiContext } from './state';

let pinInput = '';

export function updateSecurityButtons(ctx: UiContext): void {
  el('lockNowBtn').style.display = ctx.state.pinEnabled ? 'inline-flex' : 'none';
  el('securityBtn').classList.toggle('active', ctx.state.pinEnabled || ctx.state.idleMinutes > 0);
  el('maskEyeSvg').innerHTML = ctx.state.masked ? EYE_OFF_SVG : EYE_OPEN_SVG;
  el('maskBtn').classList.toggle('active', ctx.state.masked);
}

export function openAuthScreen(
  ctx: UiContext,
  mode: 'setup' | 'login',
  hintMsg = '',
  onSuccess?: () => void
): void {
  el('authTitle').textContent = mode === 'setup' ? '首次初始化財務管家' : '登入財務管家';
  el('authSub').textContent =
    hintMsg ||
    (mode === 'setup'
      ? '請輸入部署時設定的 SETUP_SECRET 並建立個人主密碼'
      : '支援 Face ID / Touch ID Passkey 或主密碼登入');
  el('authError').textContent = '';

  const body = el('authBody');
  body.innerHTML = '';

  if (mode === 'login' && ctx.state.passkeyCount > 0) {
    const pkBtn = document.createElement('button');
    pkBtn.type = 'button';
    pkBtn.className = 'btn btn-primary btn-block';
    pkBtn.style.marginBottom = '14px';
    pkBtn.textContent = '使用 Face ID / Passkey 登入';
    pkBtn.addEventListener('click', async () => {
      el('authError').textContent = '';
      setLoading(true);
      try {
        await loginWithPasskey();
        ctx.state.authenticated = true;
        el('authScreen').classList.remove('open');
        showToast('Passkey 登入成功', 'success');
        onSuccess?.();
      } catch (err) {
        el('authError').textContent = err instanceof Error ? err.message : 'Passkey 登入失敗';
      } finally {
        setLoading(false);
      }
    });
    body.appendChild(pkBtn);
  }

  const form = document.createElement('form');
  if (mode === 'setup') {
    form.appendChild(makeInputField('初始化密鑰 (SETUP_SECRET)', 'authSecret', 'password', '', 'wrangler secret 設定之密鑰', true));
    form.appendChild(makeInputField('設定主密碼（至少 8 碼）', 'authPwd', 'password', '', '建議含英數符號', true));
  } else {
    form.appendChild(makeInputField('主密碼', 'authPwd', 'password', '', '輸入主密碼', true));
  }

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = mode === 'login' && ctx.state.passkeyCount > 0 ? 'btn btn-outline btn-block' : 'btn btn-primary btn-block';
  submit.textContent = mode === 'setup' ? '完成初始化並進入系統' : '以主密碼登入';
  form.appendChild(submit);

  // 若已有本機離線快取資料，允許使用者先離線檢視與記帳
  if (mode === 'login' && ctx.engine.getMeta().lastSyncedAt) {
    const offlineBtn = document.createElement('button');
    offlineBtn.type = 'button';
    offlineBtn.className = 'btn btn-outline btn-block';
    offlineBtn.style.marginTop = '8px';
    offlineBtn.textContent = '暫時離線繼續使用（待連線後同步）';
    offlineBtn.addEventListener('click', () => {
      el('authScreen').classList.remove('open');
    });
    form.appendChild(offlineBtn);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    el('authError').textContent = '';
    setLoading(true);
    try {
      const pwd = el<HTMLInputElement>('authPwd').value;
      if (mode === 'setup') {
        const sec = el<HTMLInputElement>('authSecret').value;
        await setupMasterPassword(sec, pwd);
        ctx.state.initialized = true;
      } else {
        await loginWithPassword(pwd);
      }
      ctx.state.authenticated = true;
      el('authScreen').classList.remove('open');
      showToast('驗證成功，正在同步最新帳本...', 'success');
      onSuccess?.();
    } catch (err) {
      el('authError').textContent = err instanceof Error ? err.message : '驗證失敗';
    } finally {
      setLoading(false);
    }
  });

  body.appendChild(form);
  el('authScreen').classList.add('open');
}

/* ==================== Offline PIN Lock Screen ==================== */

function renderPinDots(): void {
  const box = el('pinDots');
  box.innerHTML = '';
  const count = Math.max(4, pinInput.length);
  for (let i = 0; i < count; i++) {
    const d = document.createElement('span');
    d.className = 'pin-dot' + (i < pinInput.length ? ' filled' : '');
    box.appendChild(d);
  }
}

export function openLockScreen(errMsg = ''): void {
  pinInput = '';
  el('pinError').textContent = errMsg;
  renderPinDots();
  el('lockScreen').classList.add('open');
}

export function closeLockScreen(ctx: UiContext): void {
  pinInput = '';
  ctx.state.lastActivityAt = Date.now();
  el('lockScreen').classList.remove('open');
}

export async function triggerPinKey(ctx: UiContext, k: string): Promise<void> {
  el('pinError').textContent = '';
  const keyEl = document.querySelector<HTMLElement>(`#pinPad [data-k="${k}"]`);
  if (keyEl) {
    keyEl.classList.add('pressed');
    window.setTimeout(() => keyEl.classList.remove('pressed'), 120);
  }

  if (k === 'del') {
    pinInput = pinInput.slice(0, -1);
    renderPinDots();
  } else if (k === 'go') {
    if (pinInput.length < 4) {
      el('pinError').textContent = '請輸入至少 4 位數 PIN 碼';
      return;
    }
    const ok = await verifyOfflinePin(pinInput, ctx.state.pinSalt || '', ctx.state.pinHash || '');
    if (ok) {
      closeLockScreen(ctx);
      ctx.scheduleSync();
    } else {
      pinInput = '';
      renderPinDots();
      el('pinError').textContent = 'PIN 碼不正確，請重試';
    }
  } else if (/^\d$/.test(k) && pinInput.length < 6) {
    pinInput += k;
    renderPinDots();
  }
}

/* ==================== Security, Passkey & Data Migration Modal ==================== */

export function openSecurityModal(ctx: UiContext): void {
  const body = openModal('安全、Passkey 與資料備份');

  // 1. Passkey (Face ID / Touch ID)
  const pkCard = document.createElement('div');
  pkCard.style.cssText = 'padding:12px 13px;border-radius:12px;background:var(--surface-alt);margin-bottom:14px';
  pkCard.innerHTML = `<div style="font-size:13px;font-weight:700;margin-bottom:4px">Face ID / Touch ID (Passkey)</div>
    <div class="muted" style="margin-bottom:10px">目前已綁定 ${ctx.state.passkeyCount} 組 Passkey。綁定後在 iPhone / Mac 登入免輸入主密碼。</div>`;
  const pkBtn = document.createElement('button');
  pkBtn.type = 'button';
  pkBtn.className = 'btn btn-tinted btn-sm';
  pkBtn.textContent = '+ 綁定此裝置的 Passkey';
  pkBtn.addEventListener('click', async () => {
    setLoading(true);
    try {
      await registerPasskey(navigator.platform || '我的裝置');
      ctx.state.passkeyCount += 1;
      showToast('Passkey 綁定成功！下次可直接刷 Face ID / Touch ID 登入', 'success');
      openSecurityModal(ctx);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Passkey 綁定失敗', 'error');
    } finally {
      setLoading(false);
    }
  });
  pkCard.appendChild(pkBtn);
  body.appendChild(pkCard);

  // 2. Idle Auto-Lock
  const idleLabel = document.createElement('label');
  idleLabel.className = 'section-label';
  idleLabel.textContent = '閒置自動鎖定 / 遮罩時間';
  body.appendChild(idleLabel);

  const idleGrid = document.createElement('div');
  idleGrid.style.cssText = 'display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:14px';
  for (const mins of [5, 15, 30, 60, 0]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-btn sm tnum' + (ctx.state.idleMinutes === mins ? ' active' : '');
    b.style.padding = '7px 2px';
    b.textContent = mins === 0 ? '關閉' : `${mins} 分`;
    b.addEventListener('click', () => {
      ctx.state.idleMinutes = mins;
      localStorage.setItem('finance_idle_minutes', String(mins));
      ctx.state.lastActivityAt = Date.now();
      updateSecurityButtons(ctx);
      openSecurityModal(ctx);
      showToast(mins === 0 ? '已關閉閒置保護' : `閒置保護設為 ${mins} 分鐘`, 'success');
    });
    idleGrid.appendChild(b);
  }
  body.appendChild(idleGrid);

  // 3. Offline App PIN
  const pinForm = document.createElement('form');
  pinForm.style.marginBottom = '16px';
  if (ctx.state.pinEnabled) {
    pinForm.appendChild(makeInputField('目前 4～6 位 PIN 碼', 'secCurPin', 'password', '', '輸入目前 PIN', true));
  }
  pinForm.appendChild(
    makeInputField(
      ctx.state.pinEnabled ? '新 PIN 碼（要變更才填）' : '啟用離線 4～6 位數 PIN 鎖',
      'secNewPin',
      'password',
      '',
      '例如 2580',
      !ctx.state.pinEnabled
    )
  );
  const pinBtns = document.createElement('div');
  pinBtns.style.cssText = `display:grid;grid-template-columns:${ctx.state.pinEnabled ? '1fr 1fr' : '1fr'};gap:8px`;
  const savePinBtn = document.createElement('button');
  savePinBtn.type = 'submit';
  savePinBtn.className = 'btn btn-primary btn-sm';
  savePinBtn.textContent = ctx.state.pinEnabled ? '更新 PIN 碼' : '啟用離線 PIN 鎖';
  pinBtns.appendChild(savePinBtn);

  if (ctx.state.pinEnabled) {
    const offBtn = document.createElement('button');
    offBtn.type = 'button';
    offBtn.className = 'btn btn-danger btn-sm';
    offBtn.textContent = '關閉 PIN 鎖';
    offBtn.addEventListener('click', async () => {
      const cur = el<HTMLInputElement>('secCurPin').value.trim();
      if (!cur) return showToast('請先輸入目前 PIN 碼', 'error');
      setLoading(true);
      try {
        const res = await savePinConfig({ enable: false, currentPin: cur });
        ctx.state.pinEnabled = res.pinEnabled;
        ctx.state.pinSalt = res.pinSalt;
        ctx.state.pinHash = res.pinHash;
        await ctx.engine.updateLocalPinCache(false, null, null);
        updateSecurityButtons(ctx);
        closeModal();
        showToast('已關閉 PIN 鎖', 'success');
      } catch (err) {
        showToast(err instanceof Error ? err.message : '關閉失敗', 'error');
      } finally {
        setLoading(false);
      }
    });
    pinBtns.appendChild(offBtn);
  }
  pinForm.appendChild(pinBtns);
  pinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cur = ctx.state.pinEnabled ? el<HTMLInputElement>('secCurPin').value.trim() : '';
    const nextPin = el<HTMLInputElement>('secNewPin').value.trim();
    if (!/^\d{4,6}$/.test(nextPin)) return showToast('PIN 碼需為 4～6 位純數字', 'error');
    setLoading(true);
    try {
      const res = await savePinConfig({ enable: true, currentPin: cur, newPin: nextPin });
      ctx.state.pinEnabled = res.pinEnabled;
      ctx.state.pinSalt = res.pinSalt;
      ctx.state.pinHash = res.pinHash;
      await ctx.engine.updateLocalPinCache(res.pinEnabled, res.pinSalt, res.pinHash);
      updateSecurityButtons(ctx);
      closeModal();
      showToast('已更新離線 PIN 鎖', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '更新 PIN 失敗', 'error');
    } finally {
      setLoading(false);
    }
  });
  body.appendChild(pinForm);

  // 4. Backup & GAS CSV Migration
  const dataBox = document.createElement('div');
  dataBox.style.cssText = 'border-top:0.5px solid var(--sep);padding-top:14px;display:flex;flex-direction:column;gap:8px';
  const dataTitle = document.createElement('div');
  dataTitle.className = 'section-label';
  dataTitle.textContent = '資料備份與原 Google Sheets 遷移';
  dataBox.appendChild(dataTitle);

  const exportRow = document.createElement('div');
  exportRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px';
  const expJsonBtn = document.createElement('button');
  expJsonBtn.type = 'button';
  expJsonBtn.className = 'btn btn-outline btn-sm';
  expJsonBtn.textContent = '匯出完整 JSON';
  expJsonBtn.addEventListener('click', () => {
    const data = ctx.engine.getSnapshot();
    const ymd = new Date().toISOString().slice(0, 10);
    downloadTextFile(
      `personal-finance-backup-${ymd}.json`,
      JSON.stringify({ exportedAt: new Date().toISOString(), version: 1, data }, null, 2),
      'application/json'
    );
    showToast('已下載完整 JSON 備份', 'success');
  });

  const expCsvBtn = document.createElement('button');
  expCsvBtn.type = 'button';
  expCsvBtn.className = 'btn btn-outline btn-sm';
  expCsvBtn.textContent = '匯出流水帳 CSV';
  expCsvBtn.addEventListener('click', () => {
    const csv = exportCashFlowCsv(ctx.engine.getSnapshot().cashflowLogs);
    const ymd = new Date().toISOString().slice(0, 10);
    downloadTextFile(`CashFlow_Log-${ymd}.csv`, csv, 'text/csv;charset=utf-8');
    showToast('已匯出 UTF-8 BOM CSV', 'success');
  });
  exportRow.appendChild(expJsonBtn);
  exportRow.appendChild(expCsvBtn);
  dataBox.appendChild(exportRow);

  // CSV Import (GAS CashFlow_Log)
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.csv,text/csv';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    setLoading(true);
    try {
      const csvText = await file.text();
      const res = await fetch('/api/import/csv', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csvText }),
      });
      const json = (await res.json()) as { ok?: boolean; importedCount?: number; error?: string };
      if (!res.ok) throw new Error(json.error || 'CSV 匯入失敗');
      await ctx.engine.syncNow(true);
      closeModal();
      showToast(`已成功匯入 ${json.importedCount || 0} 筆流水帳！`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '匯入失敗', 'error');
    } finally {
      setLoading(false);
    }
  });
  const impCsvBtn = document.createElement('button');
  impCsvBtn.type = 'button';
  impCsvBtn.className = 'btn btn-tinted btn-sm';
  impCsvBtn.textContent = '匯入原 Google Sheets (CashFlow_Log CSV)';
  impCsvBtn.addEventListener('click', () => fileInput.click());
  dataBox.appendChild(fileInput);
  dataBox.appendChild(impCsvBtn);

  // Logout
  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button';
  logoutBtn.className = 'btn btn-danger btn-sm';
  logoutBtn.style.marginTop = '6px';
  logoutBtn.textContent = '登出此裝置';
  logoutBtn.addEventListener('click', async () => {
    await logoutSession(false);
    ctx.state.authenticated = false;
    closeModal();
    openAuthScreen(ctx, 'login', '已登出，請重新登入以同步雲端資料', () => {
      void ctx.engine.syncNow(true);
    });
  });
  dataBox.appendChild(logoutBtn);

  body.appendChild(dataBox);
}
