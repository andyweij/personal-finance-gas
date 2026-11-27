import { getEffectiveLedgerId } from '../../../shared/calculations';
import { DEFAULT_LEDGER_ID } from '../../../shared/constants';
import type { Ledger, SharedLedgerRole, SharedLedgerSummaryDto } from '../../../shared/types';
import { bindSubmit, closeModal, el, makeInputField, openModal, showToast } from './helpers';
import { openLedgerManagerModal } from './ledgerUi';
import type { UiContext } from './state';

function roleLabel(role: SharedLedgerRole): string {
  if (role === 'owner') return '擁有者';
  if (role === 'editor') return '可編輯';
  return '僅檢視';
}

function buildJoinLink(code: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('joinLedger', code);
  return url.toString();
}

async function copyText(text: string, successMsg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMsg, 'success');
  } catch {
    window.prompt('請手動複製以下內容：', text);
  }
}

export function openJoinSharedLedgerModal(ctx: UiContext, prefillCode = ''): void {
  const body = openModal('🤝 加入共同帳本');
  const intro = document.createElement('div');
  intro.className = 'stock-live-preview';
  intro.textContent =
    '輸入帳本擁有者提供的一次性共同帳本邀請碼（SHL-XXXX-XXXX-XXXX）。加入後預設不計入您的個人總資產與淨值，您可隨時於「多帳本管理」調整或退出。';
  body.appendChild(intro);

  const form = document.createElement('form');
  form.appendChild(
    makeInputField(
      '共同帳本邀請碼',
      'joinSharedCodeInput',
      'text',
      prefillCode,
      'SHL-XXXX-XXXX-XXXX',
      true
    )
  );

  const btns = document.createElement('div');
  btns.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:8px;margin-top:14px';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-outline';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeModal);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = '加入共同帳本';

  btns.appendChild(cancelBtn);
  btns.appendChild(submitBtn);
  form.appendChild(btns);

  bindSubmit(form, async (e) => {
    e.preventDefault();
    const code = el<HTMLInputElement>('joinSharedCodeInput').value.trim();
    if (!code) {
      showToast('請輸入共同帳本邀請碼', 'error');
      return;
    }
    submitBtn.disabled = true;
    try {
      const joined = await ctx.engine.joinSharedLedger(code);
      ctx.state.activeLedgerId = joined.ledgerId;
      localStorage.setItem('finance_active_ledger_id', joined.ledgerId);
      ctx.state.logLinkedAccountTouched = false;
      closeModal();
      ctx.renderAll();
      showToast(
        `已加入共同帳本「${joined.ledgerName}」（${roleLabel(joined.role)}，擁有者：${joined.ownerDisplayName}）`,
        'success'
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加入共同帳本失敗', 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  body.appendChild(form);
}

export function openSharedLedgerManageModal(ctx: UiContext, ledger: Ledger): void {
  if (ledger.id === DEFAULT_LEDGER_ID) {
    showToast('預設個人主帳本不可開啟共用，請先建立獨立帳本', 'error');
    return;
  }

  const body = openModal(`🤝 共同帳本 · ${ledger.name}`);
  const container = document.createElement('div');
  body.appendChild(container);

  let createdCodeBanner: { code: string; link: string } | null = null;

  const renderContent = async () => {
    container.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'list-empty';
    loading.textContent = '讀取共同帳本成員資料中…';
    container.appendChild(loading);

    let summary: SharedLedgerSummaryDto | null = null;
    try {
      const all = await ctx.engine.fetchSharedLedgers();
      summary = all.find((x) => x.ledgerId === ledger.id) || null;
    } catch (err) {
      container.innerHTML = '';
      const errBox = document.createElement('div');
      errBox.className = 'list-empty';
      errBox.textContent = err instanceof Error ? err.message : '無法連線伺服器讀取成員資料';
      container.appendChild(errBox);
      return;
    }

    container.innerHTML = '';
    const isOwner = !summary ? !ledger.myRole || ledger.myRole === 'owner' : summary.myRole === 'owner';
    const currentUserId = ctx.state.currentUser?.id || '';

    const info = document.createElement('div');
    info.className = 'stock-live-preview';
    info.textContent = isOwner
      ? '您是此帳本的擁有者。產生一次性邀請碼並分享給已註冊的家庭成員，即可共同記帳（他人永遠看不到您的個人主帳本或其他獨立帳本）。'
      : `此共同帳本由「${summary?.ownerDisplayName || ledger.ownerDisplayName || '擁有者'}」擁有，您目前的權限為「${roleLabel(summary?.myRole || ledger.myRole || 'viewer')}」。`;
    container.appendChild(info);

    // 1. Per-member Net Worth Preference Toggle (when actively shared)
    if (summary) {
      const prefLabel = document.createElement('label');
      prefLabel.style.cssText =
        'display:flex;align-items:center;gap:10px;padding:11px 13px;margin-bottom:14px;border-radius:12px;background:var(--surface-alt);border:0.5px solid var(--sep);font-size:13px;cursor:pointer;';
      const prefCb = document.createElement('input');
      prefCb.type = 'checkbox';
      prefCb.checked = summary.includeInNetWorth;
      prefCb.style.cssText = 'width:18px;height:18px;accent-color:var(--primary)';
      const prefTxtWrap = document.createElement('span');
      const prefStrong = document.createElement('strong');
      prefStrong.textContent = '計入我的個人總資產與淨值統計';
      const prefSmall = document.createElement('small');
      prefSmall.style.cssText = 'display:block;color:var(--text-secondary);font-size:11px';
      prefSmall.textContent = '此設定僅影響您自己的總覽與資產統計，不會影響其他成員。';
      prefTxtWrap.appendChild(prefStrong);
      prefTxtWrap.appendChild(prefSmall);
      prefLabel.appendChild(prefCb);
      prefLabel.appendChild(prefTxtWrap);

      prefCb.addEventListener('change', async () => {
        prefCb.disabled = true;
        try {
          await ctx.engine.updateSharedLedgerPreference(ledger.id, prefCb.checked);
          ctx.renderAll();
          showToast(prefCb.checked ? '已將此共同帳本納入您的個人總資產' : '已將此共同帳本設為獨立不計入個人總資產', 'success');
        } catch (err) {
          prefCb.checked = !prefCb.checked;
          showToast(err instanceof Error ? err.message : '更新設定失敗', 'error');
        } finally {
          prefCb.disabled = false;
        }
      });
      container.appendChild(prefLabel);
    }

    // 2. Members List
    const membersTitle = document.createElement('div');
    membersTitle.style.cssText = 'font-weight:700;font-size:13px;margin:10px 0 6px';
    membersTitle.textContent = `成員清單（${summary ? summary.members.length : 1} 人）`;
    container.appendChild(membersTitle);

    const membersWrap = document.createElement('div');
    membersWrap.className = 'list-group';
    membersWrap.style.marginBottom = '14px';

    if (!summary || summary.members.length === 0) {
      const emptyM = document.createElement('div');
      emptyM.className = 'list-empty';
      emptyM.textContent = '目前尚未開啟共用，產生第一個邀請碼即可開始協作。';
      membersWrap.appendChild(emptyM);
    } else {
      for (const m of summary.members) {
        const row = document.createElement('div');
        row.className = 'list-row';
        const main = document.createElement('div');
        main.className = 'item-main';
        const t = document.createElement('div');
        t.className = 'item-title';
        t.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';
        t.appendChild(document.createTextNode(m.displayName));
        const rBadge = document.createElement('span');
        rBadge.className = 'badge ' + (m.role === 'owner' ? 'green' : m.role === 'editor' ? '' : 'warn');
        rBadge.style.marginRight = '0';
        rBadge.textContent = roleLabel(m.role);
        t.appendChild(rBadge);
        main.appendChild(t);
        if (m.username) {
          const sub = document.createElement('div');
          sub.className = 'item-sub';
          sub.textContent = `@${m.username}`;
          main.appendChild(sub);
        }

        const right = document.createElement('div');
        right.className = 'item-right';
        right.style.cssText = 'display:flex;gap:6px;align-items:center';

        if (isOwner && m.role !== 'owner') {
          const toggleBtn = document.createElement('button');
          toggleBtn.type = 'button';
          toggleBtn.className = 'btn btn-outline btn-sm';
          const nextRole = m.role === 'editor' ? 'viewer' : 'editor';
          toggleBtn.textContent = nextRole === 'viewer' ? '改僅檢視' : '改可編輯';
          toggleBtn.addEventListener('click', async () => {
            toggleBtn.disabled = true;
            try {
              await ctx.engine.updateSharedLedgerMemberRole(ledger.id, m.userId, nextRole);
              showToast(`已將「${m.displayName}」調整為${roleLabel(nextRole)}`, 'success');
              await renderContent();
            } catch (err) {
              showToast(err instanceof Error ? err.message : '變更權限失敗', 'error');
              toggleBtn.disabled = false;
            }
          });
          right.appendChild(toggleBtn);

          const rmBtn = document.createElement('button');
          rmBtn.type = 'button';
          rmBtn.className = 'btn btn-danger btn-sm';
          rmBtn.textContent = '移除';
          rmBtn.addEventListener('click', async () => {
            if (!confirm(`確定要移除「${m.displayName}」的共同帳本存取權嗎？對方下次同步將自動清除本機快取。`)) return;
            rmBtn.disabled = true;
            try {
              await ctx.engine.removeOrLeaveSharedLedger(ledger.id, m.userId);
              showToast(`已移除成員：${m.displayName}`, 'success');
              await renderContent();
            } catch (err) {
              showToast(err instanceof Error ? err.message : '移除失敗', 'error');
              rmBtn.disabled = false;
            }
          });
          right.appendChild(rmBtn);
        } else if (!isOwner && m.userId === currentUserId) {
          const leaveBtn = document.createElement('button');
          leaveBtn.type = 'button';
          leaveBtn.className = 'btn btn-danger btn-sm';
          leaveBtn.textContent = '退出帳本';
          leaveBtn.addEventListener('click', async () => {
            if (!confirm(`確定要退出共同帳本「${ledger.name}」嗎？退出後本機將清除此帳本的快取資料。`)) return;
            leaveBtn.disabled = true;
            try {
              await ctx.engine.removeOrLeaveSharedLedger(ledger.id, currentUserId);
              if (ctx.state.activeLedgerId === ledger.id) {
                ctx.state.activeLedgerId = DEFAULT_LEDGER_ID;
                localStorage.setItem('finance_active_ledger_id', DEFAULT_LEDGER_ID);
              }
              closeModal();
              ctx.renderAll();
              showToast(`已退出共同帳本：${ledger.name}`, 'success');
            } catch (err) {
              showToast(err instanceof Error ? err.message : '退出失敗', 'error');
              leaveBtn.disabled = false;
            }
          });
          right.appendChild(leaveBtn);
        }

        row.appendChild(main);
        row.appendChild(right);
        membersWrap.appendChild(row);
      }
    }
    container.appendChild(membersWrap);

    // 3. Owner Invite Generator & Active Invites
    if (isOwner) {
      if (createdCodeBanner) {
        const banner = document.createElement('div');
        banner.style.cssText =
          'padding:12px;border-radius:12px;background:var(--surface-alt);border:1px solid var(--primary);margin-bottom:14px';
        const bTitle = document.createElement('div');
        bTitle.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:6px';
        bTitle.textContent = '已產生一次性共同帳本邀請碼（僅顯示這一次）';
        const bCode = document.createElement('div');
        bCode.className = 'tnum';
        bCode.style.cssText = 'font-size:16px;font-weight:700;letter-spacing:0.5px;margin-bottom:8px';
        bCode.textContent = createdCodeBanner.code;
        const bActions = document.createElement('div');
        bActions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
        const cpCodeBtn = document.createElement('button');
        cpCodeBtn.type = 'button';
        cpCodeBtn.className = 'btn btn-outline btn-sm';
        cpCodeBtn.textContent = '複製邀請碼';
        cpCodeBtn.addEventListener('click', () => void copyText(createdCodeBanner!.code, '已複製邀請碼'));
        const cpLinkBtn = document.createElement('button');
        cpLinkBtn.type = 'button';
        cpLinkBtn.className = 'btn btn-primary btn-sm';
        cpLinkBtn.textContent = '複製加入連結';
        cpLinkBtn.addEventListener('click', () => void copyText(createdCodeBanner!.link, '已複製加入連結'));
        bActions.appendChild(cpCodeBtn);
        bActions.appendChild(cpLinkBtn);
        banner.appendChild(bTitle);
        banner.appendChild(bCode);
        banner.appendChild(bActions);
        container.appendChild(banner);
      }

      const invHeader = document.createElement('div');
      invHeader.style.cssText = 'font-weight:700;font-size:13px;margin:10px 0 6px';
      invHeader.textContent = '產生一次性邀請碼';
      container.appendChild(invHeader);

      const invForm = document.createElement('form');
      invForm.style.cssText = 'display:grid;gap:8px;margin-bottom:14px';
      if (!summary) {
        const snapshot = ctx.engine.getSnapshot();
        // aa75631 review R1: only a link to a LIVE account of another ledger restricts members (deleted accounts don't)
        const outsideAccountIds = new Set(snapshot.assetItems
          .filter((account) => !account.deletedAt && getEffectiveLedgerId(account) !== ledger.id)
          .map((account) => account.id));
        const isCrossLedger = (row: { deletedAt?: string | null; ledgerId?: string }, accountId?: string | null) =>
          !row.deletedAt && getEffectiveLedgerId(row) === ledger.id && Boolean(accountId && outsideAccountIds.has(accountId));
        if (
          snapshot.cashflowLogs.some((row) => isCrossLedger(row, row.linkedAccountId)) ||
          snapshot.recurringItems.some((row) => isCrossLedger(row, row.linkedAccountId)) ||
          snapshot.splitReceivables?.some((row) => isCrossLedger(row, row.sourceAccountId)) ||
          snapshot.installmentPlans?.some((row) => isCrossLedger(row, row.cardAccountId))
        ) {
          const warning = document.createElement('p');
          warning.className = 'muted';
          warning.textContent = '部分紀錄連動至此帳本以外的帳戶。分享後成員無法修改或刪除這些紀錄（以免動到該帳戶餘額）；如需讓成員編輯，請先解除連動或改為連動此帳本內的帳戶。';
          invForm.appendChild(warning);
        }
      }

      const rowInputs = document.createElement('div');
      rowInputs.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px';

      const roleWrap = document.createElement('div');
      roleWrap.className = 'field';
      roleWrap.style.marginBottom = '0';
      const rLbl = document.createElement('label');
      rLbl.textContent = '成員權限';
      const rSel = document.createElement('select');
      const optEd = document.createElement('option');
      optEd.value = 'editor';
      optEd.textContent = '可編輯（共同記帳）';
      const optVw = document.createElement('option');
      optVw.value = 'viewer';
      optVw.textContent = '僅檢視（唯讀）';
      rSel.appendChild(optEd);
      rSel.appendChild(optVw);
      roleWrap.appendChild(rLbl);
      roleWrap.appendChild(rSel);

      const expWrap = document.createElement('div');
      expWrap.className = 'field';
      expWrap.style.marginBottom = '0';
      const eLbl = document.createElement('label');
      eLbl.textContent = '有效天數';
      const eSel = document.createElement('select');
      for (const d of [1, 7, 14, 30]) {
        const opt = document.createElement('option');
        opt.value = String(d);
        opt.textContent = `${d} 天`;
        if (d === 7) opt.selected = true;
        eSel.appendChild(opt);
      }
      expWrap.appendChild(eLbl);
      expWrap.appendChild(eSel);
      rowInputs.appendChild(roleWrap);
      rowInputs.appendChild(expWrap);
      invForm.appendChild(rowInputs);

      const noteInput = document.createElement('input');
      noteInput.type = 'text';
      noteInput.placeholder = '邀請對象備註（選填，例如：給另一半）';
      noteInput.maxLength = 80;
      invForm.appendChild(noteInput);

      const genBtn = document.createElement('button');
      genBtn.type = 'submit';
      genBtn.className = 'btn btn-primary btn-sm';
      genBtn.textContent = '+ 產生一次性共用邀請碼';
      invForm.appendChild(genBtn);

      bindSubmit(invForm, async (e) => {
        e.preventDefault();
        genBtn.disabled = true;
        try {
          const created = await ctx.engine.createSharedLedgerInvite(ledger.id, {
            role: rSel.value === 'viewer' ? 'viewer' : 'editor',
            note: noteInput.value.trim(),
            expiresInDays: Number(eSel.value) || 7,
          });
          createdCodeBanner = { code: created.code, link: buildJoinLink(created.code) };
          await ctx.engine.syncNow();
          showToast('已產生共同帳本邀請碼', 'success');
          await renderContent();
        } catch (err) {
          showToast(err instanceof Error ? err.message : '產生邀請碼失敗', 'error');
        } finally {
          genBtn.disabled = false;
        }
      });
      container.appendChild(invForm);

      if (summary?.invites && summary.invites.length > 0) {
        const histTitle = document.createElement('div');
        histTitle.style.cssText = 'font-weight:700;font-size:13px;margin:10px 0 6px';
        histTitle.textContent = `邀請碼紀錄（${summary.invites.length}）`;
        container.appendChild(histTitle);

        const histWrap = document.createElement('div');
        histWrap.className = 'list-group';
        histWrap.style.marginBottom = '14px';
        const statusMap: Record<string, string> = {
          active: '有效',
          used: '已使用',
          revoked: '已作廢',
          expired: '已過期',
        };
        for (const inv of summary.invites) {
          const r = document.createElement('div');
          r.className = 'list-row';
          const main = document.createElement('div');
          main.className = 'item-main';
          const t = document.createElement('div');
          t.className = 'item-title';
          t.textContent = `${roleLabel(inv.role)} · ${statusMap[inv.status] || inv.status}${inv.note ? ' · ' + inv.note : ''}`;
          const s = document.createElement('div');
          s.className = 'item-sub';
          s.textContent = inv.usedAt
            ? `已由 ${inv.usedByName || '成員'} 使用（${inv.usedAt.slice(0, 10)}）`
            : `有效至 ${inv.expiresAt.slice(0, 10)}`;
          main.appendChild(t);
          main.appendChild(s);
          r.appendChild(main);

          if (inv.status === 'active') {
            const right = document.createElement('div');
            right.className = 'item-right';
            const revBtn = document.createElement('button');
            revBtn.type = 'button';
            revBtn.className = 'btn btn-outline btn-sm';
            revBtn.textContent = '作廢';
            revBtn.addEventListener('click', async () => {
              revBtn.disabled = true;
              try {
                await ctx.engine.revokeSharedLedgerInvite(ledger.id, inv.id);
                showToast('已作廢邀請碼', 'success');
                await renderContent();
              } catch (err) {
                showToast(err instanceof Error ? err.message : '作廢失敗', 'error');
                revBtn.disabled = false;
              }
            });
            right.appendChild(revBtn);
            r.appendChild(right);
          }
          histWrap.appendChild(r);
        }
        container.appendChild(histWrap);
      }
    }

    const footer = document.createElement('div');
    footer.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px';
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'btn btn-outline';
    backBtn.textContent = '返回帳本管理';
    backBtn.addEventListener('click', () => openLedgerManagerModal(ctx));
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-primary';
    closeBtn.textContent = '完成';
    closeBtn.addEventListener('click', closeModal);
    footer.appendChild(backBtn);
    footer.appendChild(closeBtn);
    container.appendChild(footer);
  };

  void renderContent();
}
