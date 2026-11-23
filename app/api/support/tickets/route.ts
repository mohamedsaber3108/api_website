import { desc, eq } from 'drizzle-orm';
import { getDb } from '../../../../db';
import { supportTickets } from '../../../../db/schema';
import { requireUser } from '../../../../lib/server/auth';
import { handle, json } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async request => {
  const user = await requireUser(request);
  const rows = await getDb()
    .select({ id: supportTickets.id, subject: supportTickets.subject, status: supportTickets.status, createdAt: supportTickets.createdAt, updatedAt: supportTickets.updatedAt })
    .from(supportTickets)
    .where(eq(supportTickets.userId, user.userId))
    .orderBy(desc(supportTickets.createdAt))
    .limit(50);
  return json({ tickets: rows });
});
