import { z } from 'zod';
import { createRequest, listRequests } from '../../../../lib/server/approvals';
import { requireRole } from '../../../../lib/server/auth';
import { dbEnabled, flagStatus, FLAGS, turnOff } from '../../../../lib/server/flags';
import { handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

const pendingOn = async (key: string) => (await listRequests('pending')).find(r => r.kind === 'flag_change' && r.payload.flag === key) ?? null;

/** Flag state for the Settings tab. Booleans only, never a key value. */
export const GET = handle(async request => {
  await requireRole(request, 'admin');
  const flags = await flagStatus();
  const pending = await listRequests('pending');
  return json({
    flags: flags.map(f => {
      const p = pending.find(r => r.kind === 'flag_change' && r.payload.flag === f.key);
      return { ...f, pending: p ? { id: p.id, requestedBy: p.requestedBy.email, createdAt: p.createdAt, expiresAt: p.expiresAt } : null };
    }),
  });
});

/**
 * OFF: any admin, applied and audited at once. ON: stored as a request that a different admin must approve
 * (POST /api/admin/requests/:id). The requester cannot approve their own request.
 */
export const POST = handle(async request => {
  requireSameOrigin(request);
  const actor = await requireRole(request, 'admin');
  const body = await parseBody(request, z.object({ flag: z.enum(FLAGS), enabled: z.boolean(), reason: z.string().trim().min(3).max(200), requestKey: z.string().max(100).optional() }));
  if (!body.enabled) {
    await turnOff(request, actor, body.flag, body.reason);
    return json({ ok: true, enabled: false });
  }
  if ((await dbEnabled(body.flag)) === true) return json({ ok: true, unchanged: true });
  const existing = await pendingOn(body.flag);
  if (existing) return json({ ok: true, pending: true, requestId: existing.id, expiresAt: existing.expiresAt, duplicate: true });
  const r = await createRequest(request, actor, { kind: 'flag_change', targetUserId: actor.userId, payload: { flag: body.flag, enabled: true }, reason: body.reason, requestKey: body.requestKey });
  return json({ ok: true, pending: true, requestId: r.id, expiresAt: r.expiresAt, duplicate: r.duplicate }, 202);
});
