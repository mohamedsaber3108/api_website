import { and, desc, eq, gt, inArray, lte, or } from 'drizzle-orm';
import { getDb } from '../../db';
import { accounts, adminRequests, sessions } from '../../db/schema';
import { audit, auditDenied } from './audit';
import { effectiveRole, isAdminRole, type Principal } from './auth';
import { adminEmails } from './config';
import { HttpError } from './http';
import { addLedgerEntry } from './ledger';
import { assertRecentMfa } from './mfa';
import { isFlagKey, setFlag } from './flags';

/**
 * Second-approver workflow (SEC-2). A credit adjustment, or a promotion to admin or super_admin, is stored as a
 * pending request. A different person approves it; the change is applied once, by the approver's call.
 * Rules are enforced here, on the server. The screen only mirrors them.
 */

export const REQUEST_TTL_MS = 24 * 3600 * 1000;
export type RequestKind = 'credit_adjustment' | 'role_change' | 'flag_change';
export type RequestRow = typeof adminRequests.$inferSelect;
type Actor = Pick<Principal, 'userId' | 'role' | 'mfaVerifiedAt'>;

/** Pending requests past their expiry become `expired` and get one audit row each. Safe to call often. */
export async function expireStale(now = Date.now()): Promise<void> {
  const rows = await getDb()
    .update(adminRequests)
    .set({ status: 'expired', decidedAt: now })
    .where(and(eq(adminRequests.status, 'pending'), lte(adminRequests.expiresAt, now)))
    .returning({ id: adminRequests.id, kind: adminRequests.kind, targetUserId: adminRequests.targetUserId });
  for (const r of rows) await audit(null, null, 'admin.request_expired', { type: 'account', id: r.targetUserId }, { requestId: r.id, kind: r.kind });
}

/** Active admin-level people other than the requester and the target who could approve this kind of request. */
async function countApprovers(kind: RequestKind, requesterId: string, targetId: string): Promise<number> {
  const emails = [...adminEmails()];
  const rows = await getDb()
    .select({ userId: accounts.userId, email: accounts.email, role: accounts.role, verified: accounts.emailVerifiedAt })
    .from(accounts)
    .where(and(eq(accounts.status, 'active'), or(inArray(accounts.role, ['admin', 'super_admin']), emails.length ? inArray(accounts.email, emails) : undefined)));
  let n = 0;
  for (const r of rows) {
    if (r.userId === requesterId || r.userId === targetId) continue;
    const eff = await effectiveRole(r.role, r.email, !!r.verified);
    if (kind === 'role_change' ? eff.role === 'super_admin' : isAdminRole(eff.role)) n++;
  }
  return n;
}

/** With no second approver every adjustment is blocked, and the caller is told so (English and Arabic). */
function noApprover(kind: RequestKind): HttpError {
  const role = kind === 'role_change';
  const en = role
    ? 'No second super admin is available, so this role change cannot be approved. Add another super admin first.'
    : 'No second admin is available, so this credit adjustment cannot be approved. Add another admin first.';
  const ar = role
    ? 'لا يوجد مدير أعلى ثانٍ للموافقة، لذلك لا يمكن اعتماد تغيير الدور. أضف مديرًا أعلى آخر أولًا.'
    : 'لا يوجد مدير ثانٍ للموافقة، لذلك لا يمكن اعتماد تعديل الرصيد. أضف مديرًا آخر أولًا.';
  return new HttpError(409, en, 'no_second_approver', { message_en: en, message_ar: ar });
}

export async function createRequest(
  request: Request,
  requester: Actor & { userId: string },
  input: { kind: RequestKind; targetUserId: string; payload: Record<string, unknown>; reason: string; requestKey?: string },
): Promise<{ id: string; expiresAt: number; duplicate: boolean }> {
  const db = getDb();
  await expireStale();
  const key = input.requestKey ?? null;
  if (key) {
    const [dup] = await db.select().from(adminRequests).where(and(eq(adminRequests.requestedBy, requester.userId), eq(adminRequests.requestKey, key))).limit(1);
    if (dup) return { id: dup.id, expiresAt: dup.expiresAt, duplicate: true };
  }
  if ((await countApprovers(input.kind, requester.userId, input.targetUserId)) === 0) throw noApprover(input.kind);
  const now = Date.now();
  const row = { id: crypto.randomUUID(), kind: input.kind, targetUserId: input.targetUserId, payload: JSON.stringify(input.payload), reason: input.reason, requestedBy: requester.userId, requestKey: key, status: 'pending', createdAt: now, expiresAt: now + REQUEST_TTL_MS };
  const inserted = await db.insert(adminRequests).values(row).onConflictDoNothing().returning({ id: adminRequests.id });
  if (inserted.length === 0) {
    // A parallel retry with the same key won the race.
    const [dup] = await db.select().from(adminRequests).where(and(eq(adminRequests.requestedBy, requester.userId), eq(adminRequests.requestKey, key ?? ''))).limit(1);
    if (dup) return { id: dup.id, expiresAt: dup.expiresAt, duplicate: true };
    throw new HttpError(500, 'Could not store the request', 'internal_error');
  }
  try {
    await audit(request, requester.userId, 'admin.request_created', { type: 'account', id: input.targetUserId }, { requestId: row.id, kind: input.kind, ...input.payload }, { reason: input.reason, actorRole: requester.role, sensitive: true });
  } catch (e) {
    // No audit row, no request: close it so nothing pending exists without a trail.
    await db.update(adminRequests).set({ status: 'rejected', decidedAt: Date.now(), decisionReason: 'audit_unavailable' }).where(eq(adminRequests.id, row.id));
    throw e;
  }
  return { id: row.id, expiresAt: row.expiresAt, duplicate: false };
}

export async function listRequests(status: string) {
  await expireStale();
  const db = getDb();
  const rows = await db.select().from(adminRequests).where(status === 'all' ? undefined : eq(adminRequests.status, status)).orderBy(desc(adminRequests.createdAt)).limit(100);
  const ids = [...new Set(rows.flatMap(r => [r.targetUserId, r.requestedBy, r.decidedBy].filter((x): x is string => !!x)))];
  const people = ids.length ? await db.select({ userId: accounts.userId, email: accounts.email }).from(accounts).where(inArray(accounts.userId, ids)) : [];
  const email = new Map(people.map(p => [p.userId, p.email]));
  return rows.map(r => ({
    id: r.id, kind: r.kind, status: r.status, payload: JSON.parse(r.payload) as Record<string, unknown>, reason: r.reason,
    target: { id: r.targetUserId, email: email.get(r.targetUserId) ?? null }, requestedBy: { id: r.requestedBy, email: email.get(r.requestedBy) ?? null },
    decidedBy: r.decidedBy ? { id: r.decidedBy, email: email.get(r.decidedBy) ?? null } : null, decisionReason: r.decisionReason,
    createdAt: r.createdAt, expiresAt: r.expiresAt, decidedAt: r.decidedAt,
  }));
}

/** Re-checks a request at approval time. A request that no longer matches the world is rejected as stale (409). */
async function assertStillValid(request: Request, r: RequestRow, actor: Actor): Promise<void> {
  const db = getDb();
  const p = JSON.parse(r.payload) as { role?: string; from?: string };
  const [requester] = await db.select({ role: accounts.role, email: accounts.email, status: accounts.status, verified: accounts.emailVerifiedAt }).from(accounts).where(eq(accounts.userId, r.requestedBy)).limit(1);
  const [target] = await db.select({ role: accounts.role, status: accounts.status }).from(accounts).where(eq(accounts.userId, r.targetUserId)).limit(1);
  let problem: string | null = null;
  if (!target || target.status === 'deleted') throw new HttpError(404, 'User not found', 'not_found');
  if (!requester || requester.status !== 'active') problem = 'The person who made this request is no longer active.';
  else if (r.kind === 'role_change') {
    // Stored role only: ADMIN_EMAILS never lets a requester make or approve role changes.
    if (requester.role !== 'super_admin') problem = 'The person who made this request is no longer a super admin.';
    else if (p.role !== 'admin' && p.role !== 'super_admin') problem = 'This request asks for a role that needs no approval.';
    else if (target.role !== p.from) problem = 'The role of this person changed after the request was made.';
  } else if (!isAdminRole((await effectiveRole(requester.role, requester.email, !!requester.verified)).role)) problem = 'The person who made this request is no longer an admin.';
  if (problem) {
    const now = Date.now();
    const rejected = await db.update(adminRequests).set({ status: 'rejected', decidedBy: actor.userId, decidedAt: now, decisionReason: 'stale' }).where(and(eq(adminRequests.id, r.id), eq(adminRequests.status, 'pending'))).returning({ id: adminRequests.id });
    // Nothing rejected means a parallel call already decided it; the claim below then reports that outcome.
    if (!rejected.length) return;
    await audit(request, actor.userId, 'admin.request_rejected', { type: 'account', id: r.targetUserId }, { requestId: r.id, kind: r.kind, requestedBy: r.requestedBy, reason: 'stale', detail: problem }, { result: 'denied', reason: 'stale', actorRole: actor.role });
    throw new HttpError(409, `${problem} Make a new request if it is still needed.`, 'request_stale');
  }
  if (target.status !== 'active') throw new HttpError(409, 'This account is not active. Nothing was changed.', 'target_inactive');
}

const REAPPLY_WINDOW_MS = 15 * 60 * 1000;

async function applyRequest(r: RequestRow, approver: Actor): Promise<void> {
  const db = getDb();
  const [target] = await db.select({ status: accounts.status }).from(accounts).where(eq(accounts.userId, r.targetUserId)).limit(1);
  if (!target || target.status === 'deleted') throw new HttpError(404, 'User not found', 'not_found');
  const p = JSON.parse(r.payload) as { amountUsd?: number; note?: string; role?: string; from?: string; flag?: string; enabled?: boolean };
  if (r.kind === 'credit_adjustment') {
    // The idempotency key is the request id, so the ledger can never take this request twice.
    await addLedgerEntry({ userId: r.targetUserId, deltaMicroUsd: Math.round((p.amountUsd ?? 0) * 1e6), type: 'adjustment', idempotencyKey: `adjust-request:${r.id}`, note: p.note, createdBy: approver.userId });
  } else if (r.kind === 'flag_change') {
    // Only "turn on" is ever requested; turning off never needs a second person.
    if (!isFlagKey(p.flag) || p.enabled !== true) throw new HttpError(409, 'This request is not valid. Make a new one.', 'request_stale');
    await setFlag(p.flag, true, approver.userId);
  } else {
    // Only from the role the request was made for, so a retry never overwrites a later change.
    const changed = await db.update(accounts).set({ role: p.role as string }).where(and(eq(accounts.userId, r.targetUserId), eq(accounts.role, p.from ?? ''))).returning({ id: accounts.userId });
    // A role change ends MFA verification of the target's sessions; the new role is read on the target's next request.
    if (changed.length) await db.update(sessions).set({ mfaVerifiedAt: null }).where(eq(sessions.userId, r.targetUserId));
  }
}

/**
 * Approve or reject. Checks run before any state changes. The claim is one conditional UPDATE (pending -> approved),
 * so two parallel approvals cannot both apply it. A repeated approval returns `duplicate: true`. It re-applies only for the same approver within 15 minutes (crash retry).
 */
export async function decideRequest(request: Request, actor: Actor, id: string, action: 'approve' | 'reject', reason: string) {
  const db = getDb();
  await expireStale();
  const [r] = await db.select().from(adminRequests).where(eq(adminRequests.id, id)).limit(1);
  if (!r) throw new HttpError(404, 'Request not found', 'not_found');
  const isRequester = r.requestedBy === actor.userId;
  const mayDecide = r.kind === 'role_change' ? actor.role === 'super_admin' : isAdminRole(actor.role);
  // Every refusal leaves a `denied` row, then the same error as before.
  const deny = async (status: number, message: string, code: string): Promise<never> => {
    await auditDenied(request, actor.userId, 'admin.request_denied', { type: 'account', id: r.targetUserId }, code, { actorRole: actor.role });
    throw new HttpError(status, message, code);
  };
  if (action === 'approve') {
    if (isRequester) await deny(403, 'You cannot approve your own request. Another admin must approve it.', 'self_approval');
    if (r.targetUserId === actor.userId) await deny(403, 'You cannot approve a request about your own account.', 'self_target');
    if (!mayDecide) await deny(403, r.kind === 'role_change' ? 'Only a super admin can approve a role change.' : 'Forbidden', r.kind === 'role_change' ? 'super_admin_required' : 'forbidden');
    if (r.kind === 'credit_adjustment' || r.kind === 'flag_change') {
      try {
        assertRecentMfa(actor); // money and the emergency stop: MFA verified in the last 15 minutes
      } catch (e) {
        if (e instanceof HttpError) await deny(e.status, e.message, e.code ?? 'mfa_recent_required');
        throw e;
      }
    }
  } else if (!isRequester && !mayDecide) {
    await deny(403, r.kind === 'role_change' ? 'Only a super admin can reject a role change.' : 'Forbidden', r.kind === 'role_change' ? 'super_admin_required' : 'forbidden');
  }

  const next = action === 'approve' ? 'approved' : 'rejected';
  if (action === 'approve' && r.status === 'pending') await assertStillValid(request, r, actor);
  const now = Date.now();
  const claimed = await db
    .update(adminRequests)
    .set({ status: next, decidedBy: actor.userId, decidedAt: now, decisionReason: reason })
    .where(and(eq(adminRequests.id, id), eq(adminRequests.status, 'pending'), gt(adminRequests.expiresAt, now)))
    .returning();
  if (claimed.length === 0) {
    const [cur] = await db.select().from(adminRequests).where(eq(adminRequests.id, id)).limit(1);
    if (cur?.status === 'pending' && cur.expiresAt <= now) {
      // It crossed its expiry between the first check and the claim.
      await expireStale(now);
      throw new HttpError(410, 'This request has expired. Make a new one.', 'request_expired');
    }
    if (cur?.status === next) {
      // A crash after the claim leaves "approved" with nothing applied. Only the same approver, within a short window, may re-apply.
      // Anyone else, or a later retry, changes nothing (a role change must never be re-granted after a later demotion).
      if (action === 'approve' && cur.decidedBy === actor.userId && cur.decidedAt !== null && now - cur.decidedAt < REAPPLY_WINDOW_MS) {
        const dupTarget = { type: 'account', id: cur.targetUserId };
        const dp = JSON.parse(cur.payload) as Record<string, unknown>;
        // Write-ahead, as for a first approval: if the rows cannot be written (503) nothing is applied. The request stays
        // approved (it must not go back to pending: that would let any approver apply it), and the same approver may retry in the window.
        await audit(request, actor.userId, 'admin.request_approved', dupTarget, { requestId: id, kind: cur.kind, requestedBy: cur.requestedBy, duplicate: true, ...dp }, { reason, actorRole: actor.role, after: { status: next }, sensitive: true });
        if (cur.kind === 'credit_adjustment') await audit(request, actor.userId, 'admin.credit_adjustment', dupTarget, { amountUsd: dp.amountUsd, note: dp.note, requestId: id, duplicate: true }, { reason, actorRole: actor.role, after: { amountUsd: dp.amountUsd }, sensitive: true });
        else if (cur.kind === 'flag_change') await audit(request, actor.userId, 'admin.flag_changed', { type: 'feature_flag', id: String(dp.flag) }, { flag: dp.flag, enabled: dp.enabled, requestId: id, duplicate: true }, { reason, actorRole: actor.role, after: { enabled: dp.enabled }, sensitive: true });
        else await audit(request, actor.userId, 'admin.user_updated', dupTarget, { role: dp.role, requestId: id, duplicate: true }, { reason, actorRole: actor.role, before: { role: dp.from }, after: { role: dp.role }, sensitive: true });
        try {
          await applyRequest(cur, actor);
        } catch (e) {
          await audit(request, actor.userId, 'admin.request_apply_failed', dupTarget, { requestId: id, kind: cur.kind, duplicate: true }, { result: 'failed', reason: e instanceof Error ? e.message.slice(0, 200) : 'apply failed', actorRole: actor.role });
          throw e;
        }
        await audit(request, actor.userId, 'admin.request_reapplied', dupTarget, { requestId: id, kind: cur.kind });
      }
      return { status: next, duplicate: true };
    }
    if (cur?.status === 'expired') throw new HttpError(410, 'This request has expired. Make a new one.', 'request_expired');
    throw new HttpError(409, `This request is already ${cur?.status ?? 'closed'}.`, 'request_closed', { status: cur?.status });
  }
  const p = JSON.parse(r.payload) as Record<string, unknown>;
  const target = { type: 'account', id: r.targetUserId };
  const revert = () => db.update(adminRequests).set({ status: 'pending', decidedBy: null, decidedAt: null, decisionReason: null }).where(eq(adminRequests.id, id));
  // Write-ahead: the audit rows are written BEFORE the change. If they cannot be written (503 audit_unavailable) the claim is
  // put back and nothing is applied. If the change then fails, a `failed` row follows. Rows use the same actions as before.
  try {
    await audit(request, actor.userId, action === 'approve' ? 'admin.request_approved' : 'admin.request_rejected', target, { requestId: id, kind: r.kind, requestedBy: r.requestedBy, ...p }, { reason, actorRole: actor.role, after: { status: next }, sensitive: action === 'approve' });
    if (action === 'approve') {
      // Same audit actions the direct routes wrote before, so existing audit views keep working.
      if (r.kind === 'credit_adjustment') await audit(request, actor.userId, 'admin.credit_adjustment', target, { amountUsd: p.amountUsd, note: p.note, requestId: id }, { reason, actorRole: actor.role, after: { amountUsd: p.amountUsd }, sensitive: true });
      else if (r.kind === 'flag_change') await audit(request, actor.userId, 'admin.flag_changed', { type: 'feature_flag', id: String(p.flag) }, { flag: p.flag, enabled: p.enabled, requestId: id }, { reason, actorRole: actor.role, before: { enabled: false }, after: { enabled: p.enabled }, sensitive: true });
      else await audit(request, actor.userId, 'admin.user_updated', target, { role: p.role, requestId: id }, { reason, actorRole: actor.role, before: { role: p.from }, after: { role: p.role }, sensitive: true });
    }
  } catch (e) {
    await revert();
    throw e;
  }
  if (action === 'approve') {
    try {
      await applyRequest(r, actor);
    } catch (e) {
      // Not applied: put it back so the request is not lost.
      await revert();
      await audit(request, actor.userId, 'admin.request_apply_failed', target, { requestId: id, kind: r.kind }, { result: 'failed', reason: e instanceof Error ? e.message.slice(0, 200) : 'apply failed', actorRole: actor.role });
      throw e;
    }
  }
  return { status: next, duplicate: false };
}
