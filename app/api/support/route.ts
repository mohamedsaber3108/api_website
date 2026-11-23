import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../db';
import { supportTickets, ticketMessages } from '../../../db/schema';
import { getPrincipal } from '../../../lib/server/auth';
import { clientIp, emailSchema, handle, json, parseBody, requireSameOrigin } from '../../../lib/server/http';
import { rateLimit } from '../../../lib/server/ratelimit';

export const dynamic = 'force-dynamic';

const schema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: emailSchema.optional(),
  subject: z.string().trim().min(3).max(140),
  message: z.string().trim().min(10).max(4000),
  website: z.string().optional(),
});

export const POST = handle(async request => {
  requireSameOrigin(request);
  const body = await parseBody(request, schema);
  // Honeypot: pretend success so bots learn nothing.
  if (body.website) return json({ ok: true }, 202);
  await rateLimit(`support:ip:${clientIp(request)}`, 10, 3600, 'Too many requests. Please try again later.');

  const user = await getPrincipal(request);
  const email = (body.email || user?.email || '').toLowerCase();
  const name = body.name || user?.name || '';
  if (!email || name.length < 2) return json({ error: 'Please provide a valid name and email.', code: 'invalid_request' }, 400);

  const db = getDb();
  const recent = await db.select({ id: supportTickets.id }).from(supportTickets).where(and(eq(supportTickets.email, email), gt(supportTickets.createdAt, Date.now() - 3600_000))).limit(3);
  if (recent.length >= 3) return json({ error: 'Too many requests. Please try again later.', code: 'rate_limited' }, 429);

  const id = crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db.insert(supportTickets).values({ id, userId: user?.userId ?? null, email, name, subject: body.subject, message: body.message, status: 'open', createdAt: now, updatedAt: now }),
    db.insert(ticketMessages).values({ id: crypto.randomUUID(), ticketId: id, authorId: user?.userId ?? null, authorRole: 'customer', authorName: name, body: body.message, createdAt: now }),
  ]);
  return json({ ok: true, id }, 201);
});
