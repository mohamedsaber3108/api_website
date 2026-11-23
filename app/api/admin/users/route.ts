import { desc, like, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { accounts } from '../../../../db/schema';
import { requireRole } from '../../../../lib/server/auth';
import { handle, json, parseQuery } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async request => {
  await requireRole(request, 'admin');
  const { q, limit, offset } = parseQuery(request, z.object({ q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0) }));
  const term = q ? `%${q.toLowerCase().replace(/[%_]/g, '')}%` : null;
  const rows = await getDb()
    .select({
      id: accounts.userId,
      email: accounts.email,
      name: accounts.name,
      role: accounts.role,
      status: accounts.status,
      provider: accounts.authProvider,
      emailVerified: sql<number>`${accounts.emailVerifiedAt} IS NOT NULL`,
      createdAt: accounts.createdAt,
      lastLoginAt: accounts.lastLoginAt,
      // Table-qualified on purpose: drizzle renders bare column names inside sql``, which would
      // make the correlation compare credit_ledger.user_id with itself.
      balanceMicroUsd: sql<number>`COALESCE((SELECT SUM(cl.delta_micro_usd) FROM credit_ledger cl WHERE cl.user_id = "accounts"."user_id"), 0)`,
    })
    .from(accounts)
    .where(term ? or(like(sql`lower(${accounts.email})`, term), like(sql`lower(coalesce(${accounts.name}, ''))`, term)) : undefined)
    .orderBy(desc(accounts.createdAt))
    .limit(limit)
    .offset(offset);
  return json({ users: rows.map(u => ({ ...u, emailVerified: !!u.emailVerified })), limit, offset });
});
