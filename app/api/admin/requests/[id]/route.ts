import { z } from 'zod';
import { decideRequest } from '../../../../../lib/server/approvals';
import { requireRole } from '../../../../../lib/server/auth';
import { handle, json, parseBody, requireSameOrigin } from '../../../../../lib/server/http';

export const dynamic = 'force-dynamic';

/** Approve or reject a pending request. The requester can never approve their own. Repeating a decision changes nothing. */
export const POST = handle<{ id: string }>(async (request, ctx) => {
  requireSameOrigin(request);
  const actor = await requireRole(request, 'admin');
  const { id } = await ctx.params;
  const body = await parseBody(request, z.object({ action: z.enum(['approve', 'reject']), reason: z.string().trim().min(3).max(200) }));
  const r = await decideRequest(request, actor, id, body.action, body.reason);
  return json({ ok: true, ...r });
});
