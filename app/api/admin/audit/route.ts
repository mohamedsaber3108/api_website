import { and, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { accounts, auditLogs } from '../../../../db/schema';
import { requireRole } from '../../../../lib/server/auth';
import { handle, json, parseQuery } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

const text = z.string().trim().min(1).max(120);

/**
 * Audit viewer. super_admin only (AUD-1, D-22): admin, support and customers get 403, and the refusal is written as a denied row.
 * Filters (all optional, combined with AND):
 * actor = user id or e-mail; action = part of the action name; target = target id or type; result = success | denied | failed;
 * from / to = time in ms since 1970 (the screen turns the viewer's local dates into these); before = paging cursor (created_at).
 */
export const GET = handle(async request => {
  await requireRole(request, 'super_admin');
  const q = parseQuery(request, z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.coerce.number().int().optional(),
    actor: text.optional(), action: text.optional(), target: text.optional(),
    result: z.enum(['success', 'denied', 'failed']).optional(),
    from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional(),
  }));
  const db = getDb();
  const conds = [];
  if (q.before) conds.push(lt(auditLogs.createdAt, q.before));
  if (q.from !== undefined) conds.push(gte(auditLogs.createdAt, q.from));
  if (q.to !== undefined) conds.push(lte(auditLogs.createdAt, q.to));
  if (q.result) conds.push(eq(auditLogs.result, q.result));
  if (q.action) conds.push(sql`instr(lower(${auditLogs.action}), ${q.action.toLowerCase()}) > 0`);
  if (q.target) conds.push(or(eq(auditLogs.targetId, q.target), eq(auditLogs.targetType, q.target)));
  if (q.actor) {
    const byEmail = await db.select({ id: accounts.userId }).from(accounts).where(eq(accounts.email, q.actor.toLowerCase())).limit(5);
    conds.push(or(eq(auditLogs.actorId, q.actor), byEmail.length ? inArray(auditLogs.actorId, byEmail.map(r => r.id)) : undefined));
  }
  const rows = await db.select().from(auditLogs).where(conds.length ? and(...conds) : undefined).orderBy(desc(auditLogs.createdAt), desc(auditLogs.seq)).limit(q.limit);
  const ids = [...new Set(rows.map(r => r.actorId).filter((x): x is string => !!x))];
  const people = ids.length ? await db.select({ userId: accounts.userId, email: accounts.email }).from(accounts).where(inArray(accounts.userId, ids)) : [];
  const email = new Map(people.map(p => [p.userId, p.email]));
  const parse = (v: string | null) => { try { return v ? JSON.parse(v) : null; } catch { return v; } };
  return json({ events: rows.map(r => ({ ...r, actorEmail: r.actorId ? email.get(r.actorId) ?? null : null, meta: parse(r.meta), before: parse(r.before), after: parse(r.after) })) });
});
