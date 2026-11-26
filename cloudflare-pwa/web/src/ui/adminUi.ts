import { ymdInTimeZone } from '../../../shared/dates';
import {
  adminCreateInvite,
  adminCreateResetCode,
  adminRevokeInvite,
  adminUpdateMember,
  fetchAdminDashboard, setAuthExpectedUser
} from '../auth/authClient';
import { openModal, setLoading, showToast, bindSubmit } from './helpers';
import type { UiContext } from './state';

async function copyToClipboard(text: string, successMsg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMsg, 'success');
  } catch {
    showToast('無法自動複製，請手動選取文字複製', 'error');
  }
}

function buildAppLink(params: Record<string, string>): string {
  const url = new URL(window.location.origin + window.location.pathname);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

export async function openFamilyAdminModal(
  ctx: UiContext,
  flashBanner?: { title: string; code: string; link: string; note: string }
): Promise<void> {
  const body = openModal('家庭成員與邀請碼管理');
  const loadingMsg = document.createElement('div');
  loadingMsg.className = 'list-empty';
  loadingMsg.textContent = '載入成員清單中...';
  body.appendChild(loadingMsg);

  let users: Awaited<ReturnType<typeof fetchAdminDashboard>>['users'] = [];
  let invites: Awaited<ReturnType<typeof fetchAdminDashboard>>['invites'] = [];
  try {
    const res = await fetchAdminDashboard();
    users = res.users;
    invites = res.invites;
  } catch (err) {
    loadingMsg.textContent = err instanceof Error ? err.message : '無法載入管理員資料';
    return;
  }

  body.innerHTML = '';

  // Privacy guarantee banner
  const privacyNote = document.createElement('div');
  privacyNote.style.cssText =
    'padding:10px 12px;border-radius:11px;background:var(--surface-alt);margin-bottom:12px;font-size:12px;line-height:1.55;color:var(--text-secondary)';
  privacyNote.textContent =
    '隱私隔離保證：每位成員擁有完全獨立的帳本。管理員僅能管理帳號狀態、發放一次性邀請碼與密碼重置碼，無法檢視任何人的帳目或密碼。';
  body.appendChild(privacyNote);

  // Flash one-time generated code banner
  if (flashBanner) {
    const box = document.createElement('div');
    box.style.cssText =
      'padding:12px 13px;border-radius:12px;background:var(--primary-soft);border:1px solid var(--primary);margin-bottom:14px';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:13px;font-weight:700;color:var(--primary);margin-bottom:6px';
    title.textContent = flashBanner.title;
    box.appendChild(title);

    const codeEl = document.createElement('div');
    codeEl.className = 'tnum';
    codeEl.style.cssText =
      'font-size:16px;font-weight:700;letter-spacing:0.6px;padding:8px 10px;border-radius:8px;background:var(--surface);margin-bottom:8px;word-break:break-all;user-select:all';
    codeEl.textContent = flashBanner.code;
    box.appendChild(codeEl);

    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.style.cssText = 'font-size:11.5px;margin-bottom:8px';
    hint.textContent = flashBanner.note;
    box.appendChild(hint);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px';
    const copyLinkBtn = document.createElement('button');
    copyLinkBtn.type = 'button';
    copyLinkBtn.className = 'btn btn-primary btn-sm';
    copyLinkBtn.textContent = '複製專用連結';
    copyLinkBtn.addEventListener('click', () => void copyToClipboard(flashBanner.link, '已複製專用連結，可直接傳給家人'));

    const copyCodeBtn = document.createElement('button');
    copyCodeBtn.type = 'button';
    copyCodeBtn.className = 'btn btn-outline btn-sm';
    copyCodeBtn.textContent = '僅複製代碼';
    copyCodeBtn.addEventListener('click', () => void copyToClipboard(flashBanner.code, '已複製一次性代碼'));

    btnRow.appendChild(copyLinkBtn);
    btnRow.appendChild(copyCodeBtn);
    box.appendChild(btnRow);
    body.appendChild(box);
  }

  // 1. Create Invite Code Card
  const invCard = document.createElement('div');
  invCard.style.cssText = 'padding:12px 13px;border-radius:12px;background:var(--surface-alt);margin-bottom:14px';
  const invTitle = document.createElement('div');
  invTitle.style.cssText = 'font-size:13px;font-weight:700;margin-bottom:8px';
  invTitle.textContent = '產生一次性家庭邀請碼';
  invCard.appendChild(invTitle);

  const invForm = document.createElement('form');
  invForm.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center';

  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.placeholder = '備註（如：給媽媽、給太太）';
  noteInput.maxLength = 40;
  noteInput.style.cssText = 'flex:1;min-width:140px';

  const daysSelect = document.createElement('select');
  daysSelect.style.cssText = 'width:86px';
  for (const [val, label] of [
    ['1', '1 天'],
    ['7', '7 天'],
    ['30', '30 天'],
  ]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (val === '7') opt.selected = true;
    daysSelect.appendChild(opt);
  }

  const genBtn = document.createElement('button');
  genBtn.type = 'submit';
  genBtn.className = 'btn btn-primary btn-sm';
  genBtn.textContent = '+ 產生';

  invForm.appendChild(noteInput);
  invForm.appendChild(daysSelect);
  invForm.appendChild(genBtn);
  bindSubmit(invForm, async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const created = await adminCreateInvite(noteInput.value.trim(), Number(daysSelect.value) || 7);
      const link = buildAppLink({ invite: created.inviteCode });
      await openFamilyAdminModal(ctx, {
        title: `一次性邀請碼已產生${created.note ? `（${created.note}）` : ''}`,
        code: created.inviteCode,
        link,
        note: `僅顯示這一次，註冊完成即永久失效（有效至 ${ymdInTimeZone(created.expiresAt)}）。`,
      });
    } catch (err) {
      showToast(err instanceof Error ? err.message : '產生邀請碼失敗', 'error');
    } finally {
      setLoading(false);
    }
  });
  invCard.appendChild(invForm);
  body.appendChild(invCard);

  // 2. Members List
  const memHeading = document.createElement('div');
  memHeading.className = 'section-label';
  memHeading.textContent = `已註冊成員 (${users.length})`;
  body.appendChild(memHeading);

  const memList = document.createElement('div');
  memList.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:16px';

  for (const u of users) {
    const row = document.createElement('div');
    row.style.cssText =
      'padding:10px 12px;border-radius:11px;border:0.5px solid var(--sep);background:var(--surface);display:flex;flex-direction:column;gap:8px';

    const top = document.createElement('div');
    top.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px';

    const left = document.createElement('div');
    const nameLine = document.createElement('div');
    nameLine.style.cssText = 'font-size:13.5px;font-weight:700';
    nameLine.textContent = `${u.displayName} (@${u.username})`;

    const metaLine = document.createElement('div');
    metaLine.className = 'muted tnum';
    metaLine.style.fontSize = '11px';
    metaLine.textContent = `建立：${ymdInTimeZone(u.createdAt)} · 最近登入：${u.lastLoginAt ? ymdInTimeZone(u.lastLoginAt) : '尚未'}`;
    left.appendChild(nameLine);
    left.appendChild(metaLine);

    const badges = document.createElement('div');
    badges.style.cssText = 'display:flex;gap:4px;align-items:center';
    const roleBadge = document.createElement('span');
    roleBadge.className = 'badge' + (u.role === 'admin' ? ' green' : '');
    roleBadge.style.marginRight = '0';
    roleBadge.textContent = u.role === 'admin' ? '管理員' : '成員';
    badges.appendChild(roleBadge);
    if (!u.isActive) {
      const disBadge = document.createElement('span');
      disBadge.className = 'badge warn';
      disBadge.style.marginRight = '0';
      disBadge.textContent = '已停用';
      badges.appendChild(disBadge);
    }

    top.appendChild(left);
    top.appendChild(badges);
    row.appendChild(top);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center';

    const isSelf = ctx.state.currentUser?.id === u.id;

    // Reset password code button (zero-knowledge)
    if (!isSelf) {
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'btn btn-tinted btn-sm';
      resetBtn.textContent = '協助重設密碼（重置碼）';
      resetBtn.addEventListener('click', async () => {
        setLoading(true);
        try {
          const res = await adminCreateResetCode(u.id, 30);
          const link = buildAppLink({ reset: res.resetCode, user: res.username });
          await openFamilyAdminModal(ctx, {
            title: `已為 ${u.displayName} (@${res.username}) 產生一次性密碼重置碼`,
            code: res.resetCode,
            link,
            note: '30 分鐘內有效且用完即失效。對方自行設定新密碼後舊裝置會自動登出，管理員無法得知其密碼。',
          });
        } catch (err) {
          showToast(err instanceof Error ? err.message : '產生重置碼失敗', 'error');
        } finally {
          setLoading(false);
        }
      });
      actions.appendChild(resetBtn);
    }

    // Utility tab visibility toggle for this user
    const utilBtn = document.createElement('button');
    utilBtn.type = 'button';
    utilBtn.className = 'btn btn-outline btn-sm';
    utilBtn.textContent = u.showUtilityTab ? '水電頁：開' : '水電頁：關';
    utilBtn.addEventListener('click', async () => {
      setLoading(true);
      try {
        const updated = await adminUpdateMember(u.id, { showUtilityTab: !u.showUtilityTab });
        if (isSelf && ctx.state.currentUser) {
          ctx.state.currentUser = { ...ctx.state.currentUser, showUtilityTab: updated.showUtilityTab };
          setAuthExpectedUser(ctx.state.currentUser?.id ?? null);
          ctx.applyUtilityTabVisibility();
        }
        showToast(`${u.displayName} 水電分頁已設為${updated.showUtilityTab ? '顯示' : '隱藏'}`, 'success');
        await openFamilyAdminModal(ctx);
      } catch (err) {
        showToast(err instanceof Error ? err.message : '更新失敗', 'error');
      } finally {
        setLoading(false);
      }
    });
    actions.appendChild(utilBtn);

    if (!isSelf) {
      const toggleActiveBtn = document.createElement('button');
      toggleActiveBtn.type = 'button';
      toggleActiveBtn.className = u.isActive ? 'btn btn-danger btn-sm' : 'btn btn-outline btn-sm';
      toggleActiveBtn.textContent = u.isActive ? '停用帳號' : '重新啟用';
      toggleActiveBtn.addEventListener('click', async () => {
        setLoading(true);
        try {
          await adminUpdateMember(u.id, { isActive: !u.isActive });
          showToast(u.isActive ? `已停用 ${u.displayName} 並強制登出` : `已重新啟用 ${u.displayName}`, 'success');
          await openFamilyAdminModal(ctx);
        } catch (err) {
          showToast(err instanceof Error ? err.message : '更新失敗', 'error');
        } finally {
          setLoading(false);
        }
      });
      actions.appendChild(toggleActiveBtn);
    }

    row.appendChild(actions);
    memList.appendChild(row);
  }
  body.appendChild(memList);

  // 3. Invite History
  const invHeading = document.createElement('div');
  invHeading.className = 'section-label';
  invHeading.textContent = `邀請碼紀錄 (${invites.length})`;
  body.appendChild(invHeading);

  if (!invites.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.fontSize = '12px';
    empty.textContent = '尚無邀請碼紀錄。';
    body.appendChild(empty);
  } else {
    const invList = document.createElement('div');
    invList.style.cssText = 'display:flex;flex-direction:column;gap:6px';
    for (const inv of invites) {
      const r = document.createElement('div');
      r.style.cssText =
        'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:var(--surface-alt);font-size:12px';

      const info = document.createElement('div');
      const statusMap: Record<typeof inv.status, string> = {
        active: '有效中',
        used: `已使用${inv.usedByUsername ? ` (@${inv.usedByUsername})` : ''}`,
        revoked: '已作廢',
        expired: '已過期',
      };
      const label = document.createElement('div');
      label.style.fontWeight = '600';
      label.textContent = `${inv.note || '家庭邀請碼'} · ${statusMap[inv.status]}`;
      const sub = document.createElement('div');
      sub.className = 'muted tnum';
      sub.style.fontSize = '11px';
      sub.textContent = `建立 ${ymdInTimeZone(inv.createdAt)} · 到期 ${ymdInTimeZone(inv.expiresAt)}`;
      info.appendChild(label);
      info.appendChild(sub);
      r.appendChild(info);

      if (inv.status === 'active') {
        const revBtn = document.createElement('button');
        revBtn.type = 'button';
        revBtn.className = 'btn btn-danger btn-sm';
        revBtn.textContent = '作廢';
        revBtn.addEventListener('click', async () => {
          setLoading(true);
          try {
            await adminRevokeInvite(inv.id);
            showToast('已作廢此邀請碼', 'success');
            await openFamilyAdminModal(ctx);
          } catch (err) {
            showToast(err instanceof Error ? err.message : '作廢失敗', 'error');
          } finally {
            setLoading(false);
          }
        });
        r.appendChild(revBtn);
      }
      invList.appendChild(r);
    }
    body.appendChild(invList);
  }
}
