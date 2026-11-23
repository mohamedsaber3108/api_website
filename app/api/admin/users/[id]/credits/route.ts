import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../../../db';
import { accounts } from '../../../../../../db/schema';
import { audit } from '../../../../../../lib/server/audit';
import { requireRole } from '../../../../../../lib/server/auth';
import { fail, handle, json, parseBody, requireSameOrigin } from '../../../../../../lib/server/http';
import { addLedgerEntry, getBalanceMicroUsd } from '../../../../../../lib/server/ledger';

export const dynamic = 'force-dynamic';

/** Manual credit or debit. A client-supplied `requestKey` makes retries safe. */
export const POST = handle<{ id: string }>(async (request, ctx) => {
  requireSameOrigin(request);
  const admin = await requireRole(request, 'admin');
  const { id } = await ctx.params;
  const body = await parseBody(request, z.object({ amountUsd: z.number().min(-1000).max(1000).refine(v => v !== 0, 'must not be zero'), note: z.string().trim().min(3).max(200), requestKey: z.string().max(80).optional() }));
  const db = getDb();
  const [target] = await db.select({ status: accounts.status }).from(accounts).where(eq(accounts.userId, id)).limit(1);
  if (!target || target.status === 'deleted') return fail(404, 'User not found', 'not_found');
  const key = `adjust:${id}:${body.requestKey ?? crypto.randomUUID()}`;
  const created = await addLedgerEntry({ userId: id, deltaMicroUsd: Math.round(body.amountUsd * 1e6), type: 'adjustment', idempotencyKey: key, note: body.note, createdBy: admin.userId });
  if (created) await audit(request, admin.userId, 'admin.credit_adjustment', { type: 'account', id }, { amountUsd: body.amountUsd, note: body.note });
  return json({ ok: true, duplicate: !created, balanceMicroUsd: await getBalanceMicroUsd(id) }, created ? 201 : 200);
});
