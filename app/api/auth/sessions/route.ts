import { and, desc, eq, gt, ne } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { sessions } from '../../../../db/schema';
import { requireUser } from '../../../../lib/server/auth';
import { fail, handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async request => {
  const user = await requireUser(request);
  const rows = await getDb()
    .select({ id: sessions.id, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, ip: sessions.ip, userAgent: sessions.userAgent })
    .from(sessions)
    .where(and(eq(sessions.userId, user.userId), gt(sessions.expiresAt, Date.now())))
    .orderBy(desc(sessions.lastSeenAt));
  return json({ sessions: rows.map(s => ({ ...s, current: s.id === user.sessionId })) });
});

/** Body `{ id }` revokes one session; `{ others: true }` revokes every session except the current one. */
export const DELETE = handle(async request => {
  requireSameOrigin(request);
  const user = await requireUser(request);
  const body = await parseBody(request, z.object({ id: z.string().min(8).max(100).optional(), others: z.boolean().optional() }));
  const db = getDb();
  if (body.others) {
    await db.delete(sessions).where(and(eq(sessions.userId, user.userId), user.sessionId ? ne(sessions.id, user.sessionId) : undefined));
    return json({ ok: true });
  }
  if (!body.id) return fail(400, 'Provide a session id', 'invalid_request');
  const rows = await db.delete(sessions).where(and(eq(sessions.id, body.id), eq(sessions.userId, user.userId))).returning({ id: sessions.id });
  return json({ ok: rows.length === 1 });
});
