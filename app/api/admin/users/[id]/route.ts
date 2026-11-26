import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../../db';
import { accounts, apiKeys, sessions } from '../../../../../db/schema';
import { audit } from '../../../../../lib/server/audit';
import { createRequest } from '../../../../../lib/server/approvals';
import { isAdminRole, requireRole, type Role } from '../../../../../lib/server/auth';
import { HttpError, fail, handle, json, parseBody, requireSameOrigin } from '../../../../../lib/server/http';

export const dynamic = 'force-dynamic';

export const PATCH = handle<{ id: string }>(async (request, ctx) => {
  requireSameOrigin(request);
  const admin = await requireRole(request, 'admin');
  const { id } = await ctx.params;
  const body = await parseBody(request, z.object({ role: z.enum(['customer', 'support', 'admin', 'super_admin']).optional(), status: z.enum(['active', 'suspended']).optional(), reason: z.string().trim().min(3).max(200).optional(), requestKey: z.string().max(80).optional() }));
  if (id === admin.userId) return fail(400, 'You cannot change your own role or status', 'self_change');
  const db = getDb();
  const [target] = await db.select({ status: accounts.status, role: accounts.role }).from(accounts).where(eq(accounts.userId, id)).limit(1);
  if (!target || target.status === 'deleted') return fail(404, 'User not found', 'not_found');
  if (!body.role && !body.status) return fail(400, 'Nothing to change', 'invalid_request');
  // Only a super_admin creates or changes admins (promote, demote, suspend). An admin may not touch them.
  const promoting = body.role === 'admin' || body.role === 'super_admin';
  if ((promoting || isAdminRole(target.role as Role)) && admin.role !== 'super_admin') throw new HttpError(403, 'Only a super admin can create or change admins.', 'super_admin_required');
  if (promoting) {
    if (body.status) return fail(400, 'Send a promotion on its own, without a status change.', 'invalid_request');
    if (!body.reason) return fail(400, 'A reason is required to promote someone to admin.', 'reason_required');
    const r = await createRequest(request, admin, { kind: 'role_change', targetUserId: id, payload: { role: body.role, from: target.role }, reason: body.reason, requestKey: body.requestKey });
    return json({ ok: true, pending: true, requestId: r.id, expiresAt: r.expiresAt, duplicate: r.duplicate }, r.duplicate ? 200 : 202);
  }
  await db.update(accounts).set({ ...(body.role ? { role: body.role } : {}), ...(body.status ? { status: body.status } : {}) }).where(eq(accounts.userId, id));
  // A role change ends MFA verification of that user's sessions (a demoted then promoted admin must verify again).
  if (body.role) await db.update(sessions).set({ mfaVerifiedAt: null }).where(eq(sessions.userId, id));
  if (body.status === 'suspended') {
    // Suspension takes effect immediately: drop sessions and disable keys.
    await db.batch([db.delete(sessions).where(eq(sessions.userId, id)), db.update(apiKeys).set({ revokedAt: Date.now() }).where(and(eq(apiKeys.userId, id), isNull(apiKeys.revokedAt)))]);
  }
  await audit(request, admin.userId, 'admin.user_updated', { type: 'account', id }, { role: body.role, status: body.status });
  return json({ ok: true });
});
