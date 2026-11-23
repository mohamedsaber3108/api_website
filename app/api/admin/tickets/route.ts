import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { supportTickets } from '../../../../db/schema';
import { requireRole } from '../../../../lib/server/auth';
import { handle, json, parseQuery } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async request => {
  await requireRole(request, 'admin', 'support');
  const { status, limit } = parseQuery(request, z.object({ status: z.enum(['open', 'pending', 'resolved', 'closed']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }));
  const rows = await getDb()
    .select({ id: supportTickets.id, email: supportTickets.email, name: supportTickets.name, subject: supportTickets.subject, status: supportTickets.status, priority: supportTickets.priority, assigneeId: supportTickets.assigneeId, createdAt: supportTickets.createdAt, updatedAt: supportTickets.updatedAt })
    .from(supportTickets)
    .where(status ? eq(supportTickets.status, status) : undefined)
    .orderBy(desc(supportTickets.updatedAt), desc(supportTickets.createdAt))
    .limit(limit);
  return json({ tickets: rows });
});
