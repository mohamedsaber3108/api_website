import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { incidents } from '../../../../db/schema';
import { audit } from '../../../../lib/server/audit';
import { requireRole } from '../../../../lib/server/auth';
import { fail, handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async request => {
  await requireRole(request, 'admin', 'support');
  return json({ incidents: await getDb().select().from(incidents).orderBy(desc(incidents.createdAt)).limit(50) });
});

export const POST = handle(async request => {
  requireSameOrigin(request);
  const admin = await requireRole(request, 'admin');
  const body = await parseBody(request, z.object({ title: z.string().trim().min(3).max(140), body: z.string().trim().min(3).max(2000), severity: z.enum(['minor', 'major', 'critical']).default('minor') }));
  const id = crypto.randomUUID();
  await getDb().insert(incidents).values({ id, ...body, status: 'investigating', createdAt: Date.now() });
  await audit(request, admin.userId, 'admin.incident_created', { type: 'incident', id });
  return json({ ok: true, id }, 201);
});

export const PATCH = handle(async request => {
  requireSameOrigin(request);
  const admin = await requireRole(request, 'admin');
  const body = await parseBody(request, z.object({ id: z.string().max(64), status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']), body: z.string().trim().min(3).max(2000).optional() }));
  const rows = await getDb()
    .update(incidents)
    .set({ status: body.status, ...(body.body ? { body: body.body } : {}), resolvedAt: body.status === 'resolved' ? Date.now() : null })
    .where(eq(incidents.id, body.id))
    .returning({ id: incidents.id });
  if (!rows.length) return fail(404, 'Incident not found', 'not_found');
  await audit(request, admin.userId, 'admin.incident_updated', { type: 'incident', id: body.id }, { status: body.status });
  return json({ ok: true });
});
