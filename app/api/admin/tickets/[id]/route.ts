import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../../db';
import { supportTickets, ticketMessages } from '../../../../../db/schema';
import { audit } from '../../../../../lib/server/audit';
import { requireRole } from '../../../../../lib/server/auth';
import { sendEmail } from '../../../../../lib/server/email';
import { fail, handle, json, parseBody, requireSameOrigin } from '../../../../../lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handle<{ id: string }>(async (request, ctx) => {
  await requireRole(request, 'admin', 'support');
  const { id } = await ctx.params;
  const db = getDb();
  const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.id, id)).limit(1);
  if (!ticket) return fail(404, 'Ticket not found', 'not_found');
  const messages = await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, id)).orderBy(asc(ticketMessages.createdAt));
  return json({ ticket, messages });
});

export const PATCH = handle<{ id: string }>(async (request, ctx) => {
  requireSameOrigin(request);
  const staff = await requireRole(request, 'admin', 'support');
  const { id } = await ctx.params;
  const body = await parseBody(request, z.object({ status: z.enum(['open', 'pending', 'resolved', 'closed']).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), assigneeId: z.string().max(80).nullable().optional() }));
  const rows = await getDb().update(supportTickets).set({ ...body, updatedAt: Date.now() }).where(eq(supportTickets.id, id)).returning({ id: supportTickets.id });
  if (!rows.length) return fail(404, 'Ticket not found', 'not_found');
  await audit(request, staff.userId, 'support.ticket_updated', { type: 'ticket', id }, body);
  return json({ ok: true });
});

/** Staff reply. Sets the ticket to "pending" (waiting on the customer) and emails them. */
export const POST = handle<{ id: string }>(async (request, ctx) => {
  requireSameOrigin(request);
  const staff = await requireRole(request, 'admin', 'support');
  const { id } = await ctx.params;
  const { body } = await parseBody(request, z.object({ body: z.string().trim().min(2).max(4000) }));
  const db = getDb();
  const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.id, id)).limit(1);
  if (!ticket) return fail(404, 'Ticket not found', 'not_found');
  const now = Date.now();
  await db.batch([
    db.insert(ticketMessages).values({ id: crypto.randomUUID(), ticketId: id, authorId: staff.userId, authorRole: 'staff', authorName: staff.name, body, createdAt: now }),
    db.update(supportTickets).set({ status: 'pending', updatedAt: now, assigneeId: ticket.assigneeId ?? staff.userId }).where(eq(supportTickets.id, id)),
  ]);
  await sendEmail({ to: ticket.email, subject: `Re: ${ticket.subject}`, text: `${body}\n\n—\nWasl AI support\nReply from your dashboard to continue this conversation.` });
  await audit(request, staff.userId, 'support.ticket_replied', { type: 'ticket', id });
  return json({ ok: true }, 201);
});
