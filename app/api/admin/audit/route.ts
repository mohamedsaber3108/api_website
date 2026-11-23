import { desc, lt } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { auditLogs } from '../../../../db/schema';
import { requireRole } from '../../../../lib/server/auth';
import { handle, json, parseQuery } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async request => {
  await requireRole(request, 'admin');
  const { limit, before } = parseQuery(request, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().optional() }));
  const rows = await getDb().select().from(auditLogs).where(before ? lt(auditLogs.createdAt, before) : undefined).orderBy(desc(auditLogs.createdAt)).limit(limit);
  return json({ events: rows.map(r => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })) });
});
