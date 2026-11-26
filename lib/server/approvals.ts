import { and, desc, eq, inArray, lte, or } from 'drizzle-orm';
import { getDb } from '../../db';
import { accounts, adminRequests, sessions } from '../../db/schema';
import { audit } from './audit';
import { effectiveRole, isAdminRole, type Principal } from './auth';
import { adminEmails } from './config';
import { HttpError } from './http';
import { addLedgerEntry } from './ledger';
import { assertRecentMfa } from './mfa';

/**
 * Second-approver workflow (SEC-2). A credit adjustment, or a promotion to admin or super_admin, is stored as a
 * pending request. A different person approves it; the change is applied once, by the approver's call.
 * Rules are enforced here, on the server. The screen only mirrors them.
 */

export const REQUEST_TTL_MS = 24 * 3600 * 1000;
export type RequestKind = 'credit_adjustment' | 'role_change';
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
  await audit(request, requester.userId, 'admin.request_created', { type: 'account', id: input.targetUserId }, { requestId: row.id, kind: input.kind, ...input.payload, reason: input.reason });
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

async function applyRequest(r: RequestRow, approver: Actor): Promise<void> {
  const db = getDb();
  const [target] = await db.select({ status: accounts.status }).from(accounts).where(eq(accounts.userId, r.targetUserId)).limit(1);
  if (!target || target.status === 'deleted') throw new HttpError(404, 'User not found', 'not_found');
  const p = JSON.parse(r.payload) as { amountUsd?: number; note?: string; role?: string };
  if (r.kind === 'credit_adjustment') {
    // The idempotency key is the request id, so the ledger can never take this request twice.
    await addLedgerEntry({ userId: r.targetUserId, deltaMicroUsd: Math.round((p.amountUsd ?? 0) * 1e6), type: 'adjustment', idempotencyKey: `adjust-request:${r.id}`, note: p.note, createdBy: approver.userId });
  } else {
    await db.update(accounts).set({ role: p.role as string }).where(eq(accounts.userId, r.targetUserId));
    // A role change ends MFA verification of the target's sessions; the new role is read on the target's next request.
    await db.update(sessions).set({ mfaVerifiedAt: null }).where(eq(sessions.userId, r.targetUserId));
  }
}

/**
 * Approve or reject. Checks run before any state changes. The claim is one conditional UPDATE (pending -> approved),
 * so two parallel approvals cannot both apply it. A repeated approval returns `duplicate: true` and changes nothing.
 */
export async function decideRequest(request: Request, actor: Actor, id: string, action: 'approve' | 'reject', reason: string) {
  const db = getDb();
  await expireStale();
  const [r] = await db.select().from(adminRequests).where(eq(adminRequests.id, id)).limit(1);
  if (!r) throw new HttpError(404, 'Request not found', 'not_found');
  const isRequester = r.requestedBy === actor.userId;
  const mayDecide = r.kind === 'role_change' ? actor.role === 'super_admin' : isAdminRole(actor.role);
  if (action === 'approve') {
    if (isRequester) throw new HttpError(403, 'You cannot approve your own request. Another admin must approve it.', 'self_approval');
    if (r.targetUserId === actor.userId) throw new HttpError(403, 'You cannot approve a request about your own account.', 'self_target');
    if (!mayDecide) throw new HttpError(403, r.kind === 'role_change' ? 'Only a super admin can approve a role change.' : 'Forbidden', r.kind === 'role_change' ? 'super_admin_required' : 'forbidden');
    if (r.kind === 'credit_adjustment') assertRecentMfa(actor); // money: MFA verified in the last 15 minutes
  } else if (!isRequester && !mayDecide) {
    throw new HttpError(403, r.kind === 'role_change' ? 'Only a super admin can reject a role change.' : 'Forbidden', r.kind === 'role_change' ? 'super_admin_required' : 'forbidden');
  }

  const next = action === 'approve' ? 'approved' : 'rejected';
  const now = Date.now();
  const claimed = await db
    .update(adminRequests)
    .set({ status: next, decidedBy: actor.userId, decidedAt: now, decisionReason: reason })
    .where(and(eq(adminRequests.id, id), eq(adminRequests.status, 'pending')))
    .returning();
  if (claimed.length === 0) {
    const [cur] = await db.select().from(adminRequests).where(eq(adminRequests.id, id)).limit(1);
    if (cur?.status === next) return { status: next, duplicate: true };
    if (cur?.status === 'expired') throw new HttpError(410, 'This request has expired. Make a new one.', 'request_expired');
    throw new HttpError(409, `This request is already ${cur?.status ?? 'closed'}.`, 'request_closed', { status: cur?.status });
  }
  if (action === 'approve') {
    try {
      await applyRequest(r, actor);
    } catch (e) {
      // Not applied: put it back so the request is not lost.
      await db.update(adminRequests).set({ status: 'pending', decidedBy: null, decidedAt: null, decisionReason: null }).where(eq(adminRequests.id, id));
      throw e;
    }
  }
  const p = JSON.parse(r.payload) as Record<string, unknown>;
  await audit(request, actor.userId, action === 'approve' ? 'admin.request_approved' : 'admin.request_rejected', { type: 'account', id: r.targetUserId }, { requestId: id, kind: r.kind, requestedBy: r.requestedBy, ...p, reason });
  if (action === 'approve') {
    // Same audit actions the direct routes wrote before, so existing audit views keep working.
    if (r.kind === 'credit_adjustment') await audit(request, actor.userId, 'admin.credit_adjustment', { type: 'account', id: r.targetUserId }, { amountUsd: p.amountUsd, note: p.note, requestId: id });
    else await audit(request, actor.userId, 'admin.user_updated', { type: 'account', id: r.targetUserId }, { role: p.role, requestId: id });
  }
  return { status: next, duplicate: false };
}
