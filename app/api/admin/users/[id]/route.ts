import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../../db';
import { accounts, apiKeys, sessions } from '../../../../../db/schema';
import { audit } from '../../../../../lib/server/audit';
import { requireRole } from '../../../../../lib/server/auth';
import { fail, handle, json, parseBody, requireSameOrigin } from '../../../../../lib/server/http';

export const dynamic = 'force-dynamic';

export const PATCH = handle<{ id: string }>(async (request, ctx) => {
  requireSameOrigin(request);
  const admin = await requireRole(request, 'admin');
  const { id } = await ctx.params;
  const body = await parseBody(request, z.object({ role: z.enum(['customer', 'support', 'admin']).optional(), status: z.enum(['active', 'suspended']).optional() }));
  if (id === admin.userId) return fail(400, 'You cannot change your own role or status', 'self_change');
  const db = getDb();
  const [target] = await db.select({ status: accounts.status }).from(accounts).where(eq(accounts.userId, id)).limit(1);
  if (!target || target.status === 'deleted') return fail(404, 'User not found', 'not_found');
  if (!body.role && !body.status) return fail(400, 'Nothing to change', 'invalid_request');
  await db.update(accounts).set({ ...(body.role ? { role: body.role } : {}), ...(body.status ? { status: body.status } : {}) }).where(eq(accounts.userId, id));
  // A role change ends MFA verification of that user's sessions (a demoted then promoted admin must verify again).
  if (body.role) await db.update(sessions).set({ mfaVerifiedAt: null }).where(eq(sessions.userId, id));
  if (body.status === 'suspended') {
    // Suspension takes effect immediately: drop sessions and disable keys.
    await db.batch([db.delete(sessions).where(eq(sessions.userId, id)), db.update(apiKeys).set({ revokedAt: Date.now() }).where(and(eq(apiKeys.userId, id), isNull(apiKeys.revokedAt)))]);
  }
  await audit(request, admin.userId, 'admin.user_updated', { type: 'account', id }, body);
  return json({ ok: true });
});
