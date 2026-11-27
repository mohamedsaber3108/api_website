import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../../../db';
import { accounts } from '../../../../../../db/schema';
import { requireRole } from '../../../../../../lib/server/auth';
import { createRequest } from '../../../../../../lib/server/approvals';
import { assertRecentMfa } from '../../../../../../lib/server/mfa';
import { fail, handle, json, parseBody, requireSameOrigin } from '../../../../../../lib/server/http';

export const dynamic = 'force-dynamic';

/**
 * Asks for a manual credit or debit. Nothing is applied here: it becomes a pending request that a different admin
 * approves (POST /api/admin/requests/:id). A client-supplied `requestKey` makes a retry return the same request.
 */
export const POST = handle<{ id: string }>(async (request, ctx) => {
  requireSameOrigin(request);
  const admin = await requireRole(request, 'admin');
  assertRecentMfa(admin); // money: MFA must have been verified in the last 15 minutes
  const { id } = await ctx.params;
  const body = await parseBody(request, z.object({ amountUsd: z.number().min(-1000).max(1000).refine(v => v !== 0, 'must not be zero'), note: z.string().trim().min(3).max(200), requestKey: z.string().max(80).optional() }));
  const [target] = await getDb().select({ status: accounts.status }).from(accounts).where(eq(accounts.userId, id)).limit(1);
  if (!target || target.status === 'deleted') return fail(404, 'User not found', 'not_found');
  const r = await createRequest(request, admin, { kind: 'credit_adjustment', targetUserId: id, payload: { amountUsd: body.amountUsd, note: body.note }, reason: body.note, requestKey: body.requestKey });
  return json({ ok: true, pending: true, requestId: r.id, expiresAt: r.expiresAt, duplicate: r.duplicate }, r.duplicate ? 200 : 202);
});
