import {
  DEFAULT_LEDGER_ID,
  MAX_JOINED_SHARED_LEDGERS,
  MAX_MEMBERS_PER_SHARED_LEDGER,
} from '../shared/constants';
import type {
  SharedLedgerInviteDto,
  SharedLedgerMemberDto,
  SharedLedgerRole,
  SharedLedgerSummaryDto,
} from '../shared/types';
import { sha256Hex } from './auth';

export const SHARED_LEDGER_MIGRATION_ERROR =
  '伺服器資料庫尚未完成升級（缺少共同帳本資料表），請先執行 0025 資料庫遷移後再重試。';

export function isMissingSharedLedgerTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table:\s*(ledger_members|ledger_invites)\b/i.test(msg);
}

function generateSharedLedgerInviteCode(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let chars = '';
  for (let i = 0; i < buf.length; i++) {
    chars += alphabet[buf[i] % alphabet.length];
  }
  return `SHL-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

function normalizeInviteCode(raw: string): string {
  return String(raw || '').trim().toUpperCase();
}

function computeInviteStatus(
  row: { used_at: string | null; revoked_at: string | null; expires_at: string },
  nowIso: string
): SharedLedgerInviteDto['status'] {
  if (row.used_at) return 'used';
  if (row.revoked_at) return 'revoked';
  if (row.expires_at <= nowIso) return 'expired';
  return 'active';
}

export async function listSharedLedgersForUser(
  db: D1Database,
  userId: string
): Promise<SharedLedgerSummaryDto[]> {
  const nowIso = new Date().toISOString();
  let myMemberships: Array<{
    ledger_id: string;
    owner_user_id: string;
    role: SharedLedgerRole;
    include_in_net_worth: number;
  }>;
  try {
    const res = await db
      .prepare(
        `SELECT ledger_id, owner_user_id, role, include_in_net_worth
         FROM ledger_members
         WHERE member_user_id = ? AND revoked_at IS NULL
         ORDER BY joined_at ASC`
      )
      .bind(userId)
      .all<{
        ledger_id: string;
        owner_user_id: string;
        role: SharedLedgerRole;
        include_in_net_worth: number;
      }>();
    myMemberships = res.results || [];
  } catch (err) {
    if (isMissingSharedLedgerTableError(err)) return [];
    throw err;
  }

  if (myMemberships.length === 0) return [];

  const summaries: SharedLedgerSummaryDto[] = [];
  for (const m of myMemberships) {
    const isOwner = m.role === 'owner' && m.owner_user_id === userId;
    const stmts: D1PreparedStatement[] = [
      db
        .prepare('SELECT id, name, deleted_at FROM ledgers WHERE user_id = ? AND id = ?')
        .bind(m.owner_user_id, m.ledger_id),
      db
        .prepare(
          `SELECT lm.member_user_id, lm.role, lm.include_in_net_worth, lm.joined_at, u.username, u.display_name
           FROM ledger_members lm
           JOIN users u ON u.id = lm.member_user_id
           WHERE lm.ledger_id = ? AND lm.owner_user_id = ? AND lm.revoked_at IS NULL
           ORDER BY CASE lm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, lm.joined_at ASC`
        )
        .bind(m.ledger_id, m.owner_user_id),
    ];
    if (isOwner) {
      stmts.push(
        db
          .prepare(
            `SELECT li.id, li.ledger_id, li.role, li.note, li.expires_at, li.used_by, li.used_at, li.revoked_at, li.created_at,
                    u.display_name AS used_by_display_name, u.username AS used_by_username
             FROM ledger_invites li
             LEFT JOIN users u ON u.id = li.used_by
             WHERE li.owner_user_id = ? AND li.ledger_id = ?
             ORDER BY li.created_at DESC
             LIMIT 30`
          )
          .bind(m.owner_user_id, m.ledger_id)
      );
    }

    const batchRes = await db.batch(stmts);
    const ledgerRow = (batchRes[0]?.results?.[0] ?? null) as
      | { id: string; name: string; deleted_at: string | null }
      | null;
    if (!ledgerRow || ledgerRow.deleted_at) continue;

    const memberRows = (batchRes[1]?.results || []) as Array<{
      member_user_id: string;
      role: SharedLedgerRole;
      include_in_net_worth: number;
      joined_at: string;
      username: string;
      display_name: string;
    }>;

    const members: SharedLedgerMemberDto[] = memberRows.map((r) => ({
      userId: r.member_user_id,
      ...(isOwner ? { username: r.username } : {}),
      displayName: r.display_name || '共同帳本成員',
      role: r.role,
      includeInNetWorth: Number(r.include_in_net_worth ?? 0) === 1,
      joinedAt: r.joined_at,
    }));

    const ownerMember = members.find((x) => x.userId === m.owner_user_id);
    const summary: SharedLedgerSummaryDto = {
      ledgerId: m.ledger_id,
      ledgerName: ledgerRow.name,
      ownerUserId: m.owner_user_id,
      ownerDisplayName: ownerMember?.displayName || '擁有者',
      myRole: m.role,
      includeInNetWorth: Number(m.include_in_net_worth ?? 0) === 1,
      members,
    };

    if (isOwner) {
      const inviteRows = (batchRes[2]?.results || []) as Array<{
        id: string;
        ledger_id: string;
        role: 'editor' | 'viewer';
        note: string;
        expires_at: string;
        used_by: string | null;
        used_at: string | null;
        revoked_at: string | null;
        created_at: string;
        used_by_display_name: string | null;
        used_by_username: string | null;
      }>;
      summary.invites = inviteRows.map((r) => ({
        id: r.id,
        ledgerId: r.ledger_id,
        role: r.role,
        note: r.note || '',
        expiresAt: r.expires_at,
        usedBy: r.used_by,
        usedByName: r.used_by_display_name || r.used_by_username || null,
        usedAt: r.used_at,
        revokedAt: r.revoked_at,
        createdAt: r.created_at,
        status: computeInviteStatus(r, nowIso),
      }));
    }

    summaries.push(summary);
  }

  return summaries;
}

export async function createSharedLedgerInvite(
  db: D1Database,
  ownerUserId: string,
  ledgerId: string,
  opts: { role?: unknown; note?: unknown; expiresInDays?: unknown } = {}
): Promise<{ invite: SharedLedgerInviteDto; code: string }> {
  const lid = String(ledgerId || '').trim();
  if (!lid) {
    throw new Error('請指定要共用的帳本。');
  }
  if (lid === DEFAULT_LEDGER_ID) {
    throw new Error('預設個人主帳本不可開啟共用，請先建立獨立帳本再分享。');
  }

  const role = opts.role === 'viewer' ? 'viewer' : opts.role === undefined || opts.role === 'editor' ? 'editor' : null;
  if (!role) {
    throw new Error('不支援的共同帳本成員角色（僅限 editor 或 viewer）。');
  }

  const rawDays = Number(opts.expiresInDays ?? 7);
  const expiresInDays = Number.isFinite(rawDays) ? Math.min(30, Math.max(1, Math.round(rawDays))) : 7;
  const note = String(opts.note ?? '').trim().slice(0, 80);

  const ledgerRow = await db
    .prepare('SELECT id, name, include_in_net_worth, deleted_at FROM ledgers WHERE user_id = ? AND id = ?')
    .bind(ownerUserId, lid)
    .first<{ id: string; name: string; include_in_net_worth: number; deleted_at: string | null }>();
  if (!ledgerRow || ledgerRow.deleted_at) {
    throw new Error('找不到此帳本，或您不是此帳本的擁有者。');
  }

  try {
    const existingMembers = await db
      .prepare('SELECT owner_user_id, member_user_id, revoked_at FROM ledger_members WHERE ledger_id = ?')
      .bind(lid)
      .all<{ owner_user_id: string; member_user_id: string; revoked_at: string | null }>();
    const rows = existingMembers.results || [];
    if (rows.some((r) => r.owner_user_id !== ownerUserId)) {
      throw new Error('無法分享此帳本，請重新建立帳本後再試。');
    }
    const activeCount = rows.filter((r) => !r.revoked_at).length;
    if (activeCount >= MAX_MEMBERS_PER_SHARED_LEDGER) {
      throw new Error(`單一共同帳本最多僅支援 ${MAX_MEMBERS_PER_SHARED_LEDGER} 位活躍成員。`);
    }
  } catch (err) {
    if (isMissingSharedLedgerTableError(err)) {
      throw new Error(SHARED_LEDGER_MIGRATION_ERROR);
    }
    throw err;
  }

  const code = generateSharedLedgerInviteCode();
  const codeHash = await sha256Hex(normalizeInviteCode(code));
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const inviteId = `shli_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO ledger_members (ledger_id, owner_user_id, member_user_id, role, include_in_net_worth, joined_at, updated_at, revoked_at)
           VALUES (?, ?, ?, 'owner', ?, ?, ?, NULL)
           ON CONFLICT(ledger_id, member_user_id) DO UPDATE SET
             role = 'owner',
             updated_at = excluded.updated_at,
             revoked_at = NULL
           WHERE ledger_members.owner_user_id = excluded.owner_user_id`
        )
        .bind(lid, ownerUserId, ownerUserId, Number(ledgerRow.include_in_net_worth ?? 0) === 1 ? 1 : 0, nowIso, nowIso),
      db
        .prepare(
          `INSERT INTO ledger_invites (id, ledger_id, owner_user_id, code_hash, role, note, created_by, expires_at, used_by, used_at, revoked_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`
        )
        .bind(inviteId, lid, ownerUserId, codeHash, role, note, ownerUserId, expiresAt, nowIso),
    ]);
  } catch (err) {
    if (isMissingSharedLedgerTableError(err)) {
      throw new Error(SHARED_LEDGER_MIGRATION_ERROR);
    }
    throw err;
  }

  return {
    code,
    invite: {
      id: inviteId,
      ledgerId: lid,
      role,
      note,
      expiresAt,
      usedBy: null,
      usedByName: null,
      usedAt: null,
      revokedAt: null,
      createdAt: nowIso,
      status: 'active',
    },
  };
}

export async function revokeSharedLedgerInvite(
  db: D1Database,
  ownerUserId: string,
  ledgerId: string,
  inviteId: string
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  try {
    const res = await db
      .prepare(
        `UPDATE ledger_invites
         SET revoked_at = ?
         WHERE id = ? AND ledger_id = ? AND owner_user_id = ? AND used_at IS NULL AND revoked_at IS NULL`
      )
      .bind(nowIso, inviteId, ledgerId, ownerUserId)
      .run();
    return Number(res.meta?.changes ?? 0) === 1;
  } catch (err) {
    if (isMissingSharedLedgerTableError(err)) {
      throw new Error(SHARED_LEDGER_MIGRATION_ERROR);
    }
    throw err;
  }
}

export async function joinSharedLedgerByCode(
  db: D1Database,
  userId: string,
  rawCode: string
): Promise<{
  ledgerId: string;
  ledgerName: string;
  ownerUserId: string;
  ownerDisplayName: string;
  role: 'editor' | 'viewer';
}> {
  const normalized = normalizeInviteCode(rawCode);
  if (!normalized || normalized.length < 8) {
    throw new Error('請輸入有效的共同帳本邀請碼。');
  }
  const codeHash = await sha256Hex(normalized);
  const nowIso = new Date().toISOString();

  let invite: {
    id: string;
    ledger_id: string;
    owner_user_id: string;
    role: 'editor' | 'viewer';
    expires_at: string;
    used_at: string | null;
    revoked_at: string | null;
  } | null = null;
  try {
    invite = await db
      .prepare(
        `SELECT id, ledger_id, owner_user_id, role, expires_at, used_at, revoked_at
         FROM ledger_invites
         WHERE code_hash = ?`
      )
      .bind(codeHash)
      .first();
  } catch (err) {
    if (isMissingSharedLedgerTableError(err)) {
      throw new Error(SHARED_LEDGER_MIGRATION_ERROR);
    }
    throw err;
  }

  if (!invite || invite.used_at || invite.revoked_at || invite.expires_at <= nowIso) {
    throw new Error('邀請碼無效、已被使用或已過期。');
  }
  if (invite.ledger_id === DEFAULT_LEDGER_ID) {
    throw new Error('無法加入預設個人主帳本。');
  }
  if (invite.owner_user_id === userId) {
    throw new Error('您已是此共同帳本的擁有者，無須使用邀請碼加入。');
  }

  const checks = await db.batch([
    db
      .prepare('SELECT id, name, deleted_at FROM ledgers WHERE user_id = ? AND id = ?')
      .bind(invite.owner_user_id, invite.ledger_id),
    db
      .prepare('SELECT username, display_name FROM users WHERE id = ?')
      .bind(invite.owner_user_id),
    db
      .prepare(
        'SELECT COUNT(*) AS cnt FROM ledger_members WHERE member_user_id = ? AND owner_user_id != ? AND revoked_at IS NULL'
      )
      .bind(userId, userId),
    db
      .prepare(
        'SELECT COUNT(*) AS cnt FROM ledger_members WHERE ledger_id = ? AND owner_user_id = ? AND revoked_at IS NULL'
      )
      .bind(invite.ledger_id, invite.owner_user_id),
    db
      .prepare('SELECT id FROM ledgers WHERE user_id = ? AND id = ? AND deleted_at IS NULL')
      .bind(userId, invite.ledger_id),
    db
      .prepare(
        'SELECT role FROM ledger_members WHERE ledger_id = ? AND member_user_id = ? AND revoked_at IS NULL'
      )
      .bind(invite.ledger_id, userId),
  ]);

  const ownerLedger = (checks[0]?.results?.[0] ?? null) as
    | { id: string; name: string; deleted_at: string | null }
    | null;
  if (!ownerLedger || ownerLedger.deleted_at) {
    throw new Error('此共同帳本已被擁有者刪除，無法加入。');
  }
  const ownerUser = (checks[1]?.results?.[0] ?? null) as
    | { username: string; display_name: string }
    | null;
  const joinedCount = Number(((checks[2]?.results?.[0] ?? {}) as { cnt?: number }).cnt ?? 0);
  if (joinedCount >= MAX_JOINED_SHARED_LEDGERS) {
    throw new Error(`每位使用者最多可加入 ${MAX_JOINED_SHARED_LEDGERS} 個共同帳本，請先退出不再使用的帳本。`);
  }
  const activeMembersCount = Number(((checks[3]?.results?.[0] ?? {}) as { cnt?: number }).cnt ?? 0);
  if (activeMembersCount >= MAX_MEMBERS_PER_SHARED_LEDGER) {
    throw new Error(`此共同帳本已達 ${MAX_MEMBERS_PER_SHARED_LEDGER} 位成員上限。`);
  }
  if (checks[4]?.results?.[0]) {
    throw new Error('您的個人帳本中已有相同識別碼的帳本，無法加入此共同帳本。');
  }
  if (checks[5]?.results?.[0]) {
    throw new Error('您已經是此共同帳本的成員。');
  }

  // Atomic redemption: only inserts/reactivates membership if the invite was genuinely claimed by this statement
  const redeemRes = await db.batch([
    db
      .prepare(
        `UPDATE ledger_invites
         SET used_by = ?, used_at = ?
         WHERE id = ? AND code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
           AND EXISTS (
             SELECT 1 FROM ledgers WHERE user_id = ledger_invites.owner_user_id
               AND id = ledger_invites.ledger_id AND deleted_at IS NULL
           )
           AND (SELECT COUNT(*) FROM ledger_members WHERE member_user_id = ?
                AND owner_user_id != ? AND revoked_at IS NULL) < ?
           AND (SELECT COUNT(*) FROM ledger_members WHERE ledger_id = ledger_invites.ledger_id
                AND owner_user_id = ledger_invites.owner_user_id AND revoked_at IS NULL) < ?
           AND NOT EXISTS (
             SELECT 1 FROM ledger_members WHERE ledger_id = ledger_invites.ledger_id
               AND member_user_id = ? AND (revoked_at IS NULL OR owner_user_id != ledger_invites.owner_user_id)
           )`
      )
      .bind(
        userId, nowIso, invite.id, codeHash, nowIso,
        userId, userId, MAX_JOINED_SHARED_LEDGERS, MAX_MEMBERS_PER_SHARED_LEDGER, userId
      ),
    db
      .prepare(
        `INSERT INTO ledger_members
          (ledger_id, owner_user_id, member_user_id, role, include_in_net_worth, joined_at, updated_at, revoked_at)
         SELECT ?, ?, ?, ?, 0, ?, ?, NULL
         WHERE changes() > 0
         ON CONFLICT(ledger_id, member_user_id) DO UPDATE SET
           role = excluded.role,
           include_in_net_worth = 0,
           joined_at = excluded.joined_at,
           updated_at = excluded.updated_at,
           revoked_at = NULL
         WHERE ledger_members.owner_user_id = excluded.owner_user_id`
      )
      .bind(invite.ledger_id, invite.owner_user_id, userId, invite.role, nowIso, nowIso),
  ]);

  if (Number(redeemRes[0]?.meta?.changes ?? 0) !== 1) {
    // aa75631 review (finding 9): the atomic UPDATE also fails when a limit is reached — the code is then NOT used
    // up, so do not tell the user it is (one extra query on this failure path only).
    const stillUsable = await db
      .prepare('SELECT 1 AS ok FROM ledger_invites WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
      .bind(invite.id, nowIso)
      .first();
    if (stillUsable) {
      throw new Error(
        `無法加入：此共同帳本可能已達 ${MAX_MEMBERS_PER_SHARED_LEDGER} 位成員上限、您已加入 ${MAX_JOINED_SHARED_LEDGERS} 個共同帳本，或帳本狀態剛有變更。此邀請碼尚未被使用，仍可再試。`
      );
    }
    throw new Error('此邀請碼剛已被使用或失效，請向帳本擁有者索取新邀請碼。');
  }

  return {
    ledgerId: invite.ledger_id,
    ledgerName: ownerLedger.name,
    ownerUserId: invite.owner_user_id,
    ownerDisplayName: ownerUser?.display_name || '擁有者',
    role: invite.role,
  };
}

export async function updateSharedLedgerMemberRole(
  db: D1Database,
  ownerUserId: string,
  ledgerId: string,
  targetMemberId: string,
  nextRole: unknown
): Promise<void> {
  if (nextRole !== 'editor' && nextRole !== 'viewer') {
    throw new Error('成員角色僅支援 editor（可編輯）或 viewer（僅檢視）。');
  }
  if (targetMemberId === ownerUserId) {
    throw new Error('無法變更帳本擁有者自己的角色。');
  }
  const nowIso = new Date().toISOString();
  try {
    const res = await db
      .prepare(
        `UPDATE ledger_members
         SET role = ?, updated_at = ?
         WHERE ledger_id = ? AND owner_user_id = ? AND member_user_id = ? AND role != 'owner' AND revoked_at IS NULL`
      )
      .bind(nextRole, nowIso, ledgerId, ownerUserId, targetMemberId)
      .run();
    if (Number(res.meta?.changes ?? 0) !== 1) {
      throw new Error('找不到該共同帳本成員，或您無權限變更角色。');
    }
  } catch (err) {
    if (isMissingSharedLedgerTableError(err)) {
      throw new Error(SHARED_LEDGER_MIGRATION_ERROR);
    }
    throw err;
  }
}

export async function removeOrLeaveSharedLedger(
  db: D1Database,
  actorUserId: string,
  ledgerId: string,
  targetMemberId: string
): Promise<{ removedSelf: boolean }> {
  let row: {
    owner_user_id: string;
    member_user_id: string;
    role: SharedLedgerRole;
  } | null = null;
  try {
    row = await db
      .prepare(
        `SELECT owner_user_id, member_user_id, role
         FROM ledger_members
         WHERE ledger_id = ? AND member_user_id = ? AND revoked_at IS NULL`
      )
      .bind(ledgerId, targetMemberId)
      .first();
  } catch (err) {
    if (isMissingSharedLedgerTableError(err)) {
      throw new Error(SHARED_LEDGER_MIGRATION_ERROR);
    }
    throw err;
  }

  if (!row) {
    throw new Error('找不到可移除的共同帳本成員。');
  }
  if (actorUserId !== row.owner_user_id && actorUserId !== row.member_user_id) {
    throw new Error('找不到可移除的共同帳本成員。');
  }

  if (row.role === 'owner') {
    throw new Error('帳本擁有者不可直接退出，請先移除其他成員後再刪除帳本。');
  }
  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `UPDATE ledger_members
       SET revoked_at = ?, updated_at = ?
       WHERE ledger_id = ? AND member_user_id = ? AND revoked_at IS NULL`
    )
    .bind(nowIso, nowIso, ledgerId, targetMemberId)
    .run();

  return { removedSelf: actorUserId === targetMemberId };
}

export async function updateSharedLedgerPreference(
  db: D1Database,
  memberUserId: string,
  ledgerId: string,
  includeInNetWorth: boolean
): Promise<void> {
  let row: { owner_user_id: string; role: SharedLedgerRole } | null = null;
  try {
    row = await db
      .prepare(
        `SELECT owner_user_id, role
         FROM ledger_members
         WHERE ledger_id = ? AND member_user_id = ? AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM ledgers WHERE user_id = ledger_members.owner_user_id
               AND id = ledger_members.ledger_id AND deleted_at IS NULL
           )`
      )
      .bind(ledgerId, memberUserId)
      .first();
  } catch (err) {
    if (isMissingSharedLedgerTableError(err)) {
      throw new Error(SHARED_LEDGER_MIGRATION_ERROR);
    }
    throw err;
  }

  if (!row) {
    throw new Error('您不是此共同帳本的活躍成員。');
  }
  const nowIso = new Date().toISOString();
  const flag = includeInNetWorth ? 1 : 0;

  if (row.role === 'owner' && row.owner_user_id === memberUserId) {
    await db.batch([
      db
        .prepare(
          `UPDATE ledger_members SET include_in_net_worth = ?, updated_at = ?
           WHERE ledger_id = ? AND member_user_id = ? AND revoked_at IS NULL`
        )
        .bind(flag, nowIso, ledgerId, memberUserId),
      db
        .prepare(
          `UPDATE ledgers
           SET include_in_net_worth = ?, updated_at = ?, version = version + 1,
               change_seq = COALESCE((SELECT change_seq FROM user_sync_state WHERE user_id = ?), 0) + 1
           WHERE user_id = ? AND id = ? AND deleted_at IS NULL`
        )
        .bind(flag, nowIso, memberUserId, memberUserId, ledgerId),
      db
        .prepare(
          'UPDATE user_sync_state SET change_seq = change_seq + 1, updated_at = ? WHERE user_id = ? AND changes() > 0'
        )
        .bind(nowIso, memberUserId),
    ]);
    return;
  }

  await db
    .prepare(
      `UPDATE ledger_members
       SET include_in_net_worth = ?, updated_at = ?
       WHERE ledger_id = ? AND member_user_id = ? AND revoked_at IS NULL`
    )
    .bind(flag, nowIso, ledgerId, memberUserId)
    .run();
}
