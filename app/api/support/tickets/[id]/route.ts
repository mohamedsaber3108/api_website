import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../../db';
import { supportTickets, ticketMessages } from '../../../../../db/schema';
import { requireUser } from '../../../../../lib/server/auth';
import { fail, handle, json, parseBody, requireSameOrigin } from '../../../../../lib/server/http';
import { rateLimit } from '../../../../../lib/server/ratelimit';

export const dynamic = 'force-dynamic';

async function ownTicket(userId: string, id: string) {
  const [t] = await getDb().select().from(supportTickets).where(and(eq(supportTickets.id, id), eq(supportTickets.userId, userId))).limit(1);
  return t ?? null;
}

export const GET = handle<{ id: string }>(async (request, ctx) => {
  const user = await requireUser(request);
  const { id } = await ctx.params;
  const ticket = await ownTicket(user.userId, id);
  if (!ticket) return fail(404, 'Ticket not found', 'not_found');
  const messages = await getDb().select().from(ticketMessages).where(eq(ticketMessages.ticketId, id)).orderBy(asc(ticketMessages.createdAt));
  return json({
    ticket: { id: ticket.id, subject: ticket.subject, status: ticket.status, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt },
    messages: messages.map(m => ({ id: m.id, authorRole: m.authorRole, authorName: m.authorRole === 'staff' ? 'Wasl support' : m.authorName, body: m.body, createdAt: m.createdAt })),
  });
});

export const POST = handle<{ id: string }>(async (request, ctx) => {
  requireSameOrigin(request);
  const user = await requireUser(request);
  const { id } = await ctx.params;
  const ticket = await ownTicket(user.userId, id);
  if (!ticket) return fail(404, 'Ticket not found', 'not_found');
  await rateLimit(`ticket-reply:${user.userId}`, 20, 3600);
  const { body } = await parseBody(request, z.object({ body: z.string().trim().min(2).max(4000) }));
  const now = Date.now();
  const db = getDb();
  await db.batch([
    db.insert(ticketMessages).values({ id: crypto.randomUUID(), ticketId: id, authorId: user.userId, authorRole: 'customer', authorName: user.name, body, createdAt: now }),
    db.update(supportTickets).set({ status: 'open', updatedAt: now }).where(eq(supportTickets.id, id)),
  ]);
  return json({ ok: true }, 201);
});
