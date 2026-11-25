import { exportCashFlowCsv } from '../../../shared/csv';
import {
  changeMyPassword,
  clearRememberedAccount,
  fetchAuthStatus,
  getRememberedAccount,
  loginWithPasskey,
  loginWithPassword,
  logoutSession,
  registerPasskey,
  registerWithInvite,
  resetPasswordWithResetCode,
  savePinConfig,
  setupMasterPassword,
  updateMyProfile,
  verifyOfflinePin,
} from '../auth/authClient';
import { triggerOfflineFaceIdUnlock } from '../auth/offlineWebAuthn';
import { openFamilyAdminModal } from './adminUi';
import { openHelpGuideModal } from './helpGuideUi';
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
import { APP_VERSION, BUILD_COMMIT, DB_SCHEMA_VERSION } from '../version';
import type { UiContext } from './state';

let pinInput = '';
let pinVerifySeq = 0;

export type AuthScreenMode = 'setup' | 'login' | 'register' | 'reset';

export interface AuthPrefill {
  username?: string;
  inviteCode?: string;
  resetCode?: string;
  forceSwitchAccount?: boolean;
}

export function isAnyLockEnabled(ctx: UiContext): boolean {
  return Boolean(
    (ctx.state.pinEnabled && ctx.state.pinHash) ||
      (ctx.state.biometricLockEnabled && ctx.state.passkeys.length > 0)
  );
}

export function updateSecurityButtons(ctx: UiContext): void {
  const lockedCapable = isAnyLockEnabled(ctx);
  el('lockNowBtn').style.display = lockedCapable ? 'inline-flex' : 'none';
  el('securityBtn').classList.toggle('active', lockedCapable || ctx.state.idleMinutes > 0);
  el('maskEyeSvg').innerHTML = ctx.state.masked ? EYE_OFF_SVG : EYE_OPEN_SVG;
  el('maskBtn').classList.toggle('active', ctx.state.masked);
}

function clearAuthQueryParams(): void {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('invite') || url.searchParams.has('reset') || url.searchParams.has('user')) {
      url.searchParams.delete('invite');
      url.searchParams.delete('reset');
      url.searchParams.delete('user');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }
  } catch {
    // Ignore history API issues
  }
}

export function openAuthScreen(
  ctx: UiContext,
  mode: AuthScreenMode,
  hintMsg = '',
  onSuccess?: () => void,
  prefill: AuthPrefill = {}
): void {
  const titles: Record<AuthScreenMode, string> = {
    setup: '首次初始化財務管家',
    login: '登入財務管家',
    register: '使用邀請碼註冊帳號',
    reset: '使用重置碼重設密碼',
  };
  const subs: Record<AuthScreenMode, string> = {
    setup: '建立第一位管理員帳號與主密碼（需輸入 SETUP_SECRET）',
    login: '支援 Face ID / Passkey 免帳號一鍵登入，或以主密碼登入',
    register: '每個家庭成員皆有完全獨立的私人帳本，邀請碼註冊後立即失效',
    reset: '輸入管理員提供的一次性重置碼並自行設定新密碼',
  };

  el('authTitle').textContent = titles[mode];
  el('authSub').textContent = hintMsg || subs[mode];
  el('authError').textContent = '';

  const body = el('authBody');
  body.innerHTML = '';

  // Mode switcher for non-setup flows
  if (mode !== 'setup') {
    const seg = document.createElement('div');
    seg.className = 'seg-bar cols-3';
    seg.style.marginBottom = '14px';
    const tabs: Array<{ id: AuthScreenMode; label: string }> = [
      { id: 'login', label: '登入' },
      { id: 'register', label: '邀請碼註冊' },
      { id: 'reset', label: '重設密碼' },
    ];
    for (const t of tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'seg-btn' + (mode === t.id ? ' active' : '');
      btn.textContent = t.label;
      btn.addEventListener('click', () => openAuthScreen(ctx, t.id, '', onSuccess));
      seg.appendChild(btn);
    }
    body.appendChild(seg);
  }

  const finishAuthenticatedUser = async (
    user: { id: string; username: string; displayName: string; role: 'admin' | 'member'; showUtilityTab: boolean } | null,
    toastMsg: string
  ) => {
    clearAuthQueryParams();
    ctx.state.authenticated = true;
    if (user) {
      await ctx.switchAccountDb(user);
    }
    try {
      const status = await fetchAuthStatus();
      if (status.authenticated && status.user) {
        if (!user || status.user.id !== user.id) {
          await ctx.switchAccountDb(status.user);
        }
        ctx.state.currentUser = status.user;
        ctx.state.pinEnabled = Boolean(status.pinEnabled);
        ctx.state.pinSalt = status.pinSalt || null;
        ctx.state.pinHash = status.pinHash || null;
        ctx.state.passkeys = status.passkeys || [];
        ctx.state.passkeyCount = status.passkeyCount || 0;
        await ctx.engine.updateLocalPinCache(ctx.state.pinEnabled, ctx.state.pinSalt, ctx.state.pinHash);
        await ctx.engine.updateLocalBiometricCache(ctx.state.biometricLockEnabled, ctx.state.passkeys);
        ctx.applyUtilityTabVisibility();
        updateSecurityButtons(ctx);
      }
    } catch {
      // Proceed even if status fetch fails
    }
    el('authScreen').classList.remove('open');
    showToast(toastMsg, 'success');
    onSuccess?.();
  };

  if (mode === 'login') {
    const supportsWebAuthn = typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
    const remembered = prefill.forceSwitchAccount ? null : getRememberedAccount();

    if (supportsWebAuthn) {
      const pkBtn = document.createElement('button');
      pkBtn.type = 'button';
      pkBtn.className = 'btn btn-primary btn-block';
      pkBtn.style.marginBottom = '14px';
      pkBtn.textContent = '使用 Face ID / Passkey 一鍵登入';
      pkBtn.addEventListener('click', async () => {
        el('authError').textContent = '';
        setLoading(true);
        try {
          const user = await loginWithPasskey();
          await finishAuthenticatedUser(user, `Passkey 登入成功${user ? `（${user.displayName}）` : ''}`);
        } catch (err) {
          el('authError').textContent = err instanceof Error ? err.message : 'Passkey 登入失敗';
        } finally {
          setLoading(false);
        }
      });
      body.appendChild(pkBtn);
    }

    const form = document.createElement('form');

    if (remembered && !prefill.username) {
      const card = document.createElement('div');
      card.style.cssText =
        'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;border-radius:11px;background:var(--surface-alt);margin-bottom:12px';
      const info = document.createElement('div');
      const label = document.createElement('div');
      label.style.cssText = 'font-size:13px;font-weight:700';
      label.textContent = `以 ${remembered.displayName} 繼續登入`;
      const sub = document.createElement('div');
      sub.className = 'muted';
      sub.style.fontSize = '11px';
      sub.textContent = `帳號：@${remembered.username}（只需輸入主密碼）`;
      info.appendChild(label);
      info.appendChild(sub);

      const switchBtn = document.createElement('button');
      switchBtn.type = 'button';
      switchBtn.className = 'btn btn-outline btn-sm';
      switchBtn.textContent = '切換帳號';
      switchBtn.addEventListener('click', () => {
        clearRememberedAccount();
        openAuthScreen(ctx, 'login', hintMsg, onSuccess, { forceSwitchAccount: true });
      });

      card.appendChild(info);
      card.appendChild(switchBtn);
      form.appendChild(card);

      const hiddenUser = document.createElement('input');
      hiddenUser.type = 'hidden';
      hiddenUser.id = 'authUser';
      hiddenUser.value = remembered.username;
      form.appendChild(hiddenUser);
    } else {
      form.appendChild(
        makeInputField('帳號', 'authUser', 'text', prefill.username || '', '例如 admin 或 mom', true)
      );
    }

    form.appendChild(makeInputField('主密碼', 'authPwd', 'password', '', '輸入主密碼', true));

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = supportsWebAuthn ? 'btn btn-outline btn-block' : 'btn btn-primary btn-block';
    submit.textContent = '以主密碼登入';
    form.appendChild(submit);

    // 若已有本機離線快取資料，允許上次登入者在離線時繼續檢視與記帳
    if (ctx.engine.getMeta().lastSyncedAt && remembered) {
      const offlineBtn = document.createElement('button');
      offlineBtn.type = 'button';
      offlineBtn.className = 'btn btn-outline btn-block';
      offlineBtn.style.marginTop = '8px';
      offlineBtn.textContent = `暫時離線繼續使用（${remembered.displayName}）`;
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
        const username = el<HTMLInputElement>('authUser').value.trim();
        const pwd = el<HTMLInputElement>('authPwd').value;
        const user = await loginWithPassword(pwd, username);
        await finishAuthenticatedUser(user, '驗證成功，正在同步最新帳本...');
      } catch (err) {
        el('authError').textContent = err instanceof Error ? err.message : '驗證失敗';
      } finally {
        setLoading(false);
      }
    });

    body.appendChild(form);
    el('authScreen').classList.add('open');
    return;
  }

  if (mode === 'setup') {
    const form = document.createElement('form');
    form.appendChild(
      makeInputField('初始化密鑰 (SETUP_SECRET)', 'authSecret', 'password', '', 'wrangler secret 設定之密鑰', true)
    );
    form.appendChild(makeInputField('管理員帳號', 'authUser', 'text', 'admin', '例如 admin 或 andy', true));
    form.appendChild(makeInputField('顯示名稱', 'authDisplay', 'text', '管理員', '例如 Andy', false));
    form.appendChild(makeInputField('設定主密碼（至少 8 碼）', 'authPwd', 'password', '', '建議含英數符號', true));

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn btn-primary btn-block';
    submit.textContent = '完成初始化並進入系統';
    form.appendChild(submit);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      el('authError').textContent = '';
      setLoading(true);
      try {
        const sec = el<HTMLInputElement>('authSecret').value;
        const username = el<HTMLInputElement>('authUser').value.trim();
        const displayName = el<HTMLInputElement>('authDisplay').value.trim();
        const pwd = el<HTMLInputElement>('authPwd').value;
        const user = await setupMasterPassword(sec, pwd, username, displayName);
        ctx.state.initialized = true;
        await finishAuthenticatedUser(user, '初始化完成，已自動登入！');
      } catch (err) {
        el('authError').textContent = err instanceof Error ? err.message : '初始化失敗';
      } finally {
        setLoading(false);
      }
    });

    body.appendChild(form);
    el('authScreen').classList.add('open');
    return;
  }

  if (mode === 'register') {
    const form = document.createElement('form');
    form.appendChild(
      makeInputField('一次性邀請碼', 'regInvite', 'text', prefill.inviteCode || '', 'INV-XXXX-XXXX-XXXX', true)
    );
    form.appendChild(makeInputField('自訂登入帳號（英數字）', 'regUser', 'text', '', '例如 mom、david', true));
    form.appendChild(makeInputField('顯示名稱', 'regDisplay', 'text', '', '例如 媽媽（選填）', false));
    form.appendChild(makeInputField('設定主密碼（至少 8 碼）', 'regPwd', 'password', '', '此密碼僅你本人知道', true));
    form.appendChild(makeInputField('確認主密碼', 'regPwd2', 'password', '', '再次輸入主密碼', true));

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn btn-primary btn-block';
    submit.textContent = '完成註冊並建立專屬帳本';
    form.appendChild(submit);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      el('authError').textContent = '';
      const pwd = el<HTMLInputElement>('regPwd').value;
      const pwd2 = el<HTMLInputElement>('regPwd2').value;
      if (pwd !== pwd2) {
        el('authError').textContent = '兩次輸入的密碼不一致。';
        return;
      }
      setLoading(true);
      try {
        const user = await registerWithInvite({
          inviteCode: el<HTMLInputElement>('regInvite').value.trim(),
          username: el<HTMLInputElement>('regUser').value.trim(),
          displayName: el<HTMLInputElement>('regDisplay').value.trim(),
          password: pwd,
        });
        await finishAuthenticatedUser(user, '註冊成功！已建立專屬獨立帳本');
      } catch (err) {
        el('authError').textContent = err instanceof Error ? err.message : '註冊失敗';
      } finally {
        setLoading(false);
      }
    });

    body.appendChild(form);
    el('authScreen').classList.add('open');
    return;
  }

  // mode === 'reset'
  const form = document.createElement('form');
  form.appendChild(makeInputField('帳號', 'rstUser', 'text', prefill.username || '', '輸入你的帳號', true));
  form.appendChild(
    makeInputField('一次性密碼重置碼', 'rstCode', 'text', prefill.resetCode || '', 'RST-XXXX-XXXX-XXXX', true)
  );
  form.appendChild(makeInputField('設定新密碼（至少 8 碼）', 'rstPwd', 'password', '', '僅你本人知道的新密碼', true));
  form.appendChild(makeInputField('確認新密碼', 'rstPwd2', 'password', '', '再次輸入新密碼', true));

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-primary btn-block';
  submit.textContent = '重設密碼';
  form.appendChild(submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    el('authError').textContent = '';
    const pwd = el<HTMLInputElement>('rstPwd').value;
    const pwd2 = el<HTMLInputElement>('rstPwd2').value;
    if (pwd !== pwd2) {
      el('authError').textContent = '兩次輸入的新密碼不一致。';
      return;
    }
    setLoading(true);
    try {
      const username = el<HTMLInputElement>('rstUser').value.trim();
      await resetPasswordWithResetCode({
        username,
        resetCode: el<HTMLInputElement>('rstCode').value.trim(),
        newPassword: pwd,
      });
      clearAuthQueryParams();
      showToast('密碼已重設完成，請以新密碼登入', 'success');
      openAuthScreen(ctx, 'login', '密碼已重設完成，請輸入新密碼登入', onSuccess, { username });
    } catch (err) {
      el('authError').textContent = err instanceof Error ? err.message : '重設密碼失敗';
    } finally {
      setLoading(false);
    }
  });

  body.appendChild(form);
  el('authScreen').classList.add('open');
}

/* ==================== Offline Face ID + PIN Lock Screen ==================== */

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

export function openLockScreen(ctx: UiContext, errMsg = ''): void {
  pinInput = '';
  pinVerifySeq += 1;
  const hasFaceId = ctx.state.passkeys.length > 0;
  const hasPin = Boolean(ctx.state.pinEnabled && ctx.state.pinHash);

  el('pinError').textContent = errMsg;
  el('lockFaceIdBtn').style.display = hasFaceId ? 'inline-flex' : 'none';
  el('pinDots').style.display = hasPin ? 'flex' : 'none';
  el('pinPad').style.display = hasPin ? 'grid' : 'none';
  el('lockUsePasswordBtn').style.display = !hasPin ? 'inline-flex' : 'none';

  el('lockSub').textContent =
    hasFaceId && hasPin
      ? '輸入 4～6 位數 PIN 正確即自動解鎖，或點擊刷 Face ID'
      : hasFaceId
        ? '點擊下方按鈕刷 Face ID 解鎖（支援離線驗證）'
        : '輸入 4～6 位數 PIN 正確即自動解鎖（離線可用）';

  if (hasPin) {
    renderPinDots();
  }
  el('lockScreen').classList.add('open');
}

export function closeLockScreen(ctx: UiContext): void {
  pinInput = '';
  pinVerifySeq += 1;
  ctx.state.lastActivityAt = Date.now();
  el('lockScreen').classList.remove('open');
}

export async function unlockLockScreenWithFaceId(ctx: UiContext): Promise<void> {
  el('pinError').textContent = '';
  const btn = el<HTMLButtonElement>('lockFaceIdBtn');
  btn.disabled = true;
  setLoading(true);

  try {
    let verified = false;
    if (navigator.onLine) {
      try {
        const user = await loginWithPasskey(ctx.state.currentUser?.username);
        ctx.state.authenticated = true;
        if (user && (!ctx.state.currentUser || user.id !== ctx.state.currentUser.id)) {
          await ctx.switchAccountDb(user);
        }
        verified = true;
      } catch (err) {
        if (err instanceof Error && err.name === 'NotAllowedError') {
          throw new Error('已取消 Face ID 驗證');
        }
        verified = await triggerOfflineFaceIdUnlock(ctx.state.passkeys);
      }
    } else {
      verified = await triggerOfflineFaceIdUnlock(ctx.state.passkeys);
    }

    if (verified) {
      closeLockScreen(ctx);
      ctx.scheduleSync();
    } else {
      el('pinError').textContent = 'Face ID 驗證未通過，請重試';
    }
  } catch (err) {
    const msg =
      err instanceof Error && err.name === 'NotAllowedError'
        ? '已取消 Face ID 驗證'
        : err instanceof Error
          ? err.message
          : 'Face ID 驗證失敗';
    el('pinError').textContent = msg;
  } finally {
    btn.disabled = false;
    setLoading(false);
  }
}

export async function triggerPinKey(ctx: UiContext, k: string): Promise<void> {
  el('pinError').textContent = '';
  if (k === 'del') {
    pinVerifySeq += 1;
    pinInput = pinInput.slice(0, -1);
    renderPinDots();
    return;
  }

  if (k === 'ok') {
    if (pinInput.length < 4) {
      el('pinError').textContent = 'PIN 碼至少 4 位數字';
      return;
    }
    const seq = ++pinVerifySeq;
    const candidate = pinInput;
    const ok = await verifyOfflinePin(candidate, ctx.state.pinSalt || '', ctx.state.pinHash || '');
    if (seq !== pinVerifySeq) return;
    if (ok) {
      closeLockScreen(ctx);
      ctx.scheduleSync();
    } else {
      pinInput = '';
      renderPinDots();
      el('pinError').textContent = 'PIN 碼不正確，請重試';
    }
    return;
  }

  if (/^\d$/.test(k) && pinInput.length < 6) {
    pinInput += k;
    renderPinDots();

    // Support seamless auto-unlock for 4-, 5-, and 6-digit PINs without pressing OK
    if (pinInput.length >= 4 && ctx.state.pinSalt && ctx.state.pinHash) {
      const seq = ++pinVerifySeq;
      const candidate = pinInput;
      const ok = await verifyOfflinePin(candidate, ctx.state.pinSalt, ctx.state.pinHash);
      if (ok && el('lockScreen').classList.contains('open') && pinInput.startsWith(candidate)) {
        closeLockScreen(ctx);
        ctx.scheduleSync();
        return;
      }
      // Only auto-clear and show error if user has reached the 6-digit maximum and still no match
      if (!ok && candidate.length === 6 && seq === pinVerifySeq) {
        pinInput = '';
        renderPinDots();
        el('pinError').textContent = 'PIN 碼不正確，請重試';
      }
    }
  }
}

/* ==================== Profile & Password Sub-Modals ==================== */

function openProfileEditModal(ctx: UiContext): void {
  const user = ctx.state.currentUser;
  if (!user) return;
  const body = openModal('編輯帳號與顯示名稱');
  const form = document.createElement('form');
  form.appendChild(makeInputField('登入帳號', 'profUser', 'text', user.username, '英數字帳號', true));
  form.appendChild(makeInputField('顯示名稱', 'profDisplay', 'text', user.displayName, '例如 Andy、媽媽', true));

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-primary btn-block';
  submit.textContent = '儲存個人資料';
  form.appendChild(submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const updated = await updateMyProfile({
        username: el<HTMLInputElement>('profUser').value.trim(),
        displayName: el<HTMLInputElement>('profDisplay').value.trim(),
      });
      ctx.state.currentUser = updated;
      showToast('個人資料已更新', 'success');
      openSecurityModal(ctx);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '更新失敗', 'error');
    } finally {
      setLoading(false);
    }
  });
  body.appendChild(form);
}

function openChangePasswordModal(ctx: UiContext): void {
  const body = openModal('變更主密碼');
  const form = document.createElement('form');
  form.appendChild(makeInputField('目前主密碼', 'chgCurPwd', 'password', '', '輸入目前主密碼', true));
  form.appendChild(makeInputField('新主密碼（至少 8 碼）', 'chgNewPwd', 'password', '', '輸入新密碼', true));
  form.appendChild(makeInputField('確認新主密碼', 'chgNewPwd2', 'password', '', '再次輸入新密碼', true));

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-primary btn-block';
  submit.textContent = '更新主密碼';
  form.appendChild(submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cur = el<HTMLInputElement>('chgCurPwd').value;
    const next = el<HTMLInputElement>('chgNewPwd').value;
    const next2 = el<HTMLInputElement>('chgNewPwd2').value;
    if (next !== next2) return showToast('兩次輸入的新密碼不一致', 'error');
    setLoading(true);
    try {
      await changeMyPassword(cur, next);
      showToast('主密碼已更新（其他裝置已自動登出）', 'success');
      openSecurityModal(ctx);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '變更密碼失敗', 'error');
    } finally {
      setLoading(false);
    }
  });
  body.appendChild(form);
}

/* ==================== Security, Account, Family & Data Migration Modal ==================== */

export function openSecurityModal(ctx: UiContext): void {
  const body = openModal('帳號、顯示與安全設定');
  const user = ctx.state.currentUser;

  const guideBtn = document.createElement('button');
  guideBtn.type = 'button';
  guideBtn.className = 'btn btn-tinted btn-block btn-sm';
  guideBtn.style.marginBottom = '12px';
  guideBtn.textContent = '📖 使用指南與計算口徑說明（離線可查）';
  guideBtn.addEventListener('click', () => openHelpGuideModal());
  body.appendChild(guideBtn);

  // 0. Current Account + Utility Tab Toggle + Admin Family Entry
  if (user) {
    const accCard = document.createElement('div');
    accCard.style.cssText = 'padding:12px 13px;border-radius:12px;background:var(--surface-alt);margin-bottom:14px';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px';
    const titleWrap = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-size:14px;font-weight:700';
    nameEl.textContent = `${user.displayName} (@${user.username})`;
    const subEl = document.createElement('div');
    subEl.className = 'muted';
    subEl.style.fontSize = '11px';
    subEl.textContent = '完全獨立個人帳本 · 雲端與本機資料庫雙重隔離';
    titleWrap.appendChild(nameEl);
    titleWrap.appendChild(subEl);

    const badge = document.createElement('span');
    badge.className = 'badge' + (user.role === 'admin' ? ' green' : '');
    badge.style.marginRight = '0';
    badge.textContent = user.role === 'admin' ? '管理員' : '家庭成員';
    head.appendChild(titleWrap);
    head.appendChild(badge);
    accCard.appendChild(head);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px';
    const profBtn = document.createElement('button');
    profBtn.type = 'button';
    profBtn.className = 'btn btn-outline btn-sm';
    profBtn.textContent = '編輯帳號/名稱';
    profBtn.addEventListener('click', () => openProfileEditModal(ctx));

    const pwdBtn = document.createElement('button');
    pwdBtn.type = 'button';
    pwdBtn.className = 'btn btn-outline btn-sm';
    pwdBtn.textContent = '變更主密碼';
    pwdBtn.addEventListener('click', () => openChangePasswordModal(ctx));

    btnRow.appendChild(profBtn);
    btnRow.appendChild(pwdBtn);

    if (user.role === 'admin') {
      const adminBtn = document.createElement('button');
      adminBtn.type = 'button';
      adminBtn.className = 'btn btn-tinted btn-sm';
      adminBtn.textContent = '👨‍👩‍👧 家庭成員與邀請碼';
      adminBtn.addEventListener('click', () => void openFamilyAdminModal(ctx));
      btnRow.appendChild(adminBtn);
    }
    accCard.appendChild(btnRow);

    // Toggleable 5F/6F Utility Subtab
    const utilRow = document.createElement('div');
    utilRow.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;gap:10px;padding-top:10px;border-top:0.5px solid var(--sep)';
    const utilText = document.createElement('div');
    const utilTitle = document.createElement('div');
    utilTitle.style.cssText = 'font-size:13px;font-weight:600';
    utilTitle.textContent = '顯示「水電分攤」工具分頁';
    const utilSub = document.createElement('div');
    utilSub.className = 'muted';
    utilSub.style.fontSize = '11px';
    utilSub.textContent = '預設僅管理員開啟，可隨時依個人需要切換';
    utilText.appendChild(utilTitle);
    utilText.appendChild(utilSub);

    const sw = document.createElement('label');
    sw.className = 'switch';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = user.showUtilityTab;
    cb.addEventListener('change', async () => {
      try {
        const updated = await updateMyProfile({ showUtilityTab: cb.checked });
        ctx.state.currentUser = updated;
        ctx.applyUtilityTabVisibility();
        showToast(updated.showUtilityTab ? '已顯示水電分攤分頁' : '已隱藏水電分攤分頁', 'success');
      } catch (err) {
        cb.checked = !cb.checked;
        showToast(err instanceof Error ? err.message : '更新失敗', 'error');
      }
    });
    const sl = document.createElement('span');
    sl.className = 'slider';
    sw.appendChild(cb);
    sw.appendChild(sl);
    utilRow.appendChild(utilText);
    utilRow.appendChild(sw);
    accCard.appendChild(utilRow);

    body.appendChild(accCard);
  }

  // 0.5 Display Preference: Positive / Negative Color Scheme (synced per user)
  const schemeCard = document.createElement('div');
  schemeCard.style.cssText = 'padding:12px 13px;border-radius:12px;background:var(--surface-alt);margin-bottom:14px';
  const schemeTitle = document.createElement('div');
  schemeTitle.style.cssText = 'font-size:13px;font-weight:700;margin-bottom:3px';
  schemeTitle.textContent = '正負數配色風格（同步至所有裝置）';
  const schemeSub = document.createElement('div');
  schemeSub.className = 'muted';
  schemeSub.style.cssText = 'font-size:11px;margin-bottom:10px';
  schemeSub.textContent = '依個人習慣切換國際綠紅或台股紅綠；系統提示與刪除警示色不受影響';
  schemeCard.appendChild(schemeTitle);
  schemeCard.appendChild(schemeSub);

  const schemeList = document.createElement('div');
  schemeList.className = 'scheme-options';
  const currentScheme = ctx.state.pnlColorScheme;
  const schemeOptions: Array<{
    id: 'intl' | 'tw' | 'tw_stocks';
    title: string;
    sub: string;
    posCls: 'green' | 'red';
    negCls: 'green' | 'red';
  }> = [
    {
      id: 'intl',
      title: '全站正綠負紅（預設）',
      sub: '國際直覺風格：正值 / 獲利為綠，負值 / 虧損為紅',
      posCls: 'green',
      negCls: 'red',
    },
    {
      id: 'tw',
      title: '全站正紅負綠（台股風格）',
      sub: '台股看盤風格：全站正值 / 獲利為紅，負值 / 虧損為綠',
      posCls: 'red',
      negCls: 'green',
    },
    {
      id: 'tw_stocks',
      title: '僅持股正紅負綠（混合模式）',
      sub: '記帳與總覽維持正綠負紅，持股損益改為台股紅漲綠跌',
      posCls: 'red',
      negCls: 'green',
    },
  ];

  for (const opt of schemeOptions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'scheme-option' + (currentScheme === opt.id ? ' active' : '');

    const left = document.createElement('div');
    const t = document.createElement('div');
    t.className = 'scheme-option-title';
    t.textContent = opt.title;
    const s = document.createElement('div');
    s.className = 'scheme-option-sub';
    s.textContent = opt.sub;
    left.appendChild(t);
    left.appendChild(s);

    const preview = document.createElement('div');
    preview.className = 'scheme-preview tnum';
    const p1 = document.createElement('span');
    p1.className = `scheme-pill ${opt.posCls}`;
    p1.textContent = '+12%';
    const p2 = document.createElement('span');
    p2.className = `scheme-pill ${opt.negCls}`;
    p2.textContent = '-4%';
    preview.appendChild(p1);
    preview.appendChild(p2);

    btn.appendChild(left);
    btn.appendChild(preview);
    btn.addEventListener('click', async () => {
      try {
        await ctx.engine.savePnlColorScheme(opt.id);
        ctx.applyPnlColorScheme(opt.id);
        ctx.scheduleSync();
        showToast(`已切換配色：${opt.title}`, 'success');
        openSecurityModal(ctx);
      } catch (err) {
        showToast(err instanceof Error ? err.message : '儲存配色失敗', 'error');
      }
    });
    schemeList.appendChild(btn);
  }
  schemeCard.appendChild(schemeList);
  body.appendChild(schemeCard);

  // 1. Passkey (Face ID / Touch ID) + 啟動/閒置 Face ID 鎖定開關
  const pkCard = document.createElement('div');
  pkCard.style.cssText = 'padding:12px 13px;border-radius:12px;background:var(--surface-alt);margin-bottom:14px';
  const pkTitle = document.createElement('div');
  pkTitle.style.cssText = 'font-size:13px;font-weight:700;margin-bottom:4px';
  pkTitle.textContent = 'Face ID / Touch ID (Passkey)';
  const pkSub = document.createElement('div');
  pkSub.className = 'muted';
  pkSub.style.marginBottom = '10px';
  pkSub.textContent = `目前已綁定 ${ctx.state.passkeyCount} 組 Passkey（支援免帳號一鍵登入與離線解鎖）。`;
  pkCard.appendChild(pkTitle);
  pkCard.appendChild(pkSub);

  const pkBtn = document.createElement('button');
  pkBtn.type = 'button';
  pkBtn.className = 'btn btn-tinted btn-sm';
  pkBtn.textContent = '+ 綁定此裝置的 Passkey';
  pkBtn.addEventListener('click', async () => {
    setLoading(true);
    try {
      await registerPasskey(navigator.platform || '我的裝置');
      const status = await fetchAuthStatus();
      ctx.state.passkeyCount = status.passkeyCount || 0;
      ctx.state.passkeys = status.passkeys || [];
      ctx.state.biometricLockEnabled = true;
      await ctx.engine.updateLocalBiometricCache(true, ctx.state.passkeys);
      updateSecurityButtons(ctx);
      showToast('Face ID 綁定成功！之後可直接免帳密一鍵登入與解鎖', 'success');
      openSecurityModal(ctx);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Passkey 綁定失敗', 'error');
    } finally {
      setLoading(false);
    }
  });
  pkCard.appendChild(pkBtn);

  if (ctx.state.passkeys.length > 0) {
    const bioRow = document.createElement('div');
    bioRow.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:12px;padding-top:10px;border-top:0.5px solid var(--sep)';
    bioRow.innerHTML = `<div><div style="font-size:13px;font-weight:600">啟動與閒置時用 Face ID 解鎖</div><div class="muted" style="font-size:11px">支援飛航模式離線刷臉解鎖</div></div>`;
    const sw = document.createElement('label');
    sw.className = 'switch';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = ctx.state.biometricLockEnabled;
    cb.addEventListener('change', async () => {
      ctx.state.biometricLockEnabled = cb.checked;
      await ctx.engine.updateLocalBiometricCache(cb.checked);
      updateSecurityButtons(ctx);
      showToast(cb.checked ? '已開啟 Face ID 鎖定保護' : '已關閉 Face ID 鎖定保護', 'success');
    });
    const sl = document.createElement('span');
    sl.className = 'slider';
    sw.appendChild(cb);
    sw.appendChild(sl);
    bioRow.appendChild(sw);
    pkCard.appendChild(bioRow);
  }
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
  dataTitle.textContent = '個人資料備份與原 Google Sheets 遷移';
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
    const suffix = user ? `-${user.username}` : '';
    downloadTextFile(
      `personal-finance-backup${suffix}-${ymd}.json`,
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

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.csv,text/csv';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    if (!files.length) return;
    setLoading(true);
    try {
      const summaries: string[] = [];
      for (const file of files) {
        const csvText = await file.text();
        const res = await fetch('/api/import/csv', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ csvText }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          label?: string;
          importedCount?: number;
          error?: string;
        };
        if (!res.ok) throw new Error(`${file.name}：${json.error || 'CSV 匯入失敗'}`);
        summaries.push(`${json.label || file.name} ${json.importedCount || 0} 筆`);
      }
      await ctx.engine.syncNow(true);
      closeModal();
      showToast(`匯入完成：${summaries.join('、')}`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '匯入失敗', 'error');
    } finally {
      fileInput.value = '';
      setLoading(false);
    }
  });
  const impCsvBtn = document.createElement('button');
  impCsvBtn.type = 'button';
  impCsvBtn.className = 'btn btn-tinted btn-sm';
  impCsvBtn.textContent = '匯入原 Google Sheets CSV（可多選 5 分頁）';
  impCsvBtn.addEventListener('click', () => fileInput.click());

  const csvHint = document.createElement('div');
  csvHint.className = 'muted';
  csvHint.style.fontSize = '11px';
  csvHint.textContent =
    '自動辨識：CashFlow_Log、Recurring_Config（固定/訂閱）、Annual_Sinking_Fund（攤提）、Assets_Liabilities（資產負債）、NetWorth_History';

  const jsonInput = document.createElement('input');
  jsonInput.type = 'file';
  jsonInput.accept = '.json,application/json';
  jsonInput.style.display = 'none';
  jsonInput.addEventListener('change', async () => {
    const file = jsonInput.files?.[0];
    if (!file) return;
    setLoading(true);
    try {
      const parsed = JSON.parse(await file.text());
      const res = await fetch('/api/import/json', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'merge', data: parsed.data || parsed }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error || 'JSON 還原失敗');
      await ctx.engine.syncNow(true);
      closeModal();
      showToast('完整 JSON 備份還原完成！', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'JSON 還原失敗', 'error');
    } finally {
      jsonInput.value = '';
      setLoading(false);
    }
  });
  const impJsonBtn = document.createElement('button');
  impJsonBtn.type = 'button';
  impJsonBtn.className = 'btn btn-outline btn-sm';
  impJsonBtn.textContent = '從 JSON 備份檔還原';
  impJsonBtn.addEventListener('click', () => jsonInput.click());

  dataBox.appendChild(fileInput);
  dataBox.appendChild(impCsvBtn);
  dataBox.appendChild(csvHint);
  dataBox.appendChild(jsonInput);
  dataBox.appendChild(impJsonBtn);

  // Logout
  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button';
  logoutBtn.className = 'btn btn-danger btn-sm';
  logoutBtn.style.marginTop = '6px';
  logoutBtn.textContent = '登出此裝置';
  logoutBtn.addEventListener('click', async () => {
    await logoutSession(false);
    ctx.state.authenticated = false;
    ctx.state.currentUser = null;
    closeModal();
    openAuthScreen(ctx, 'login', '已登出，請重新登入以同步雲端資料', () => {
      void ctx.engine.syncNow(true);
    });
  });
  dataBox.appendChild(logoutBtn);

  body.appendChild(dataBox);

  const verFooter = document.createElement('div');
  verFooter.className = 'settings-version-footer tnum';
  verFooter.textContent = `財務管家 v${APP_VERSION} (${BUILD_COMMIT}) · Schema v${DB_SCHEMA_VERSION}`;
  body.appendChild(verFooter);
}
