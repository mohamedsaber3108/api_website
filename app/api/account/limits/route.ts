import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { accounts, apiKeys, usageEvents } from '../../../../db/schema';
import { audit } from '../../../../lib/server/audit';
import { requireUser } from '../../../../lib/server/auth';
import { handle, HttpError, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';
import { MAX_LIMIT_USD, MIN_LIMIT_USD, monthStartMs, usdToMicro } from '../../../../lib/server/limits';

export const dynamic = 'force-dynamic';

/** Limits and this month's spend, for the account and for each active key. */
export const GET = handle(async request => {
  const user = await requireUser(request);
  const db = getDb();
  const [[acct], keys, spent] = await Promise.all([
    db.select({ limit: accounts.monthlyLimitMicroUsd }).from(accounts).where(eq(accounts.userId, user.userId)).limit(1),
    db
      .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, limit: apiKeys.monthlyLimitMicroUsd })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, user.userId), isNull(apiKeys.revokedAt)))
      .orderBy(desc(apiKeys.createdAt)),
    db
      .select({ keyId: usageEvents.keyId, spent: sql<number>`COALESCE(SUM(${usageEvents.costMicroUsd}), 0)` })
      .from(usageEvents)
      .where(and(eq(usageEvents.userId, user.userId), gte(usageEvents.createdAt, monthStartMs())))
      .groupBy(usageEvents.keyId),
  ]);
  const byKey = new Map(spent.map(s => [s.keyId, Number(s.spent)]));
  const total = spent.reduce((n, s) => n + Number(s.spent), 0);
  return json({
    monthStart: monthStartMs(),
    account: { limitMicroUsd: acct?.limit ?? null, spentMicroUsd: total },
    keys: keys.map(k => ({ id: k.id, name: k.name, prefix: k.prefix, limitMicroUsd: k.limit ?? null, spentMicroUsd: byKey.get(k.id) ?? 0 })),
  });
});

const putSchema = z
  .object({
    scope: z.enum(['account', 'key']),
    keyId: z.string().min(1).max(64).optional(),
    /** USD. null removes the limit. */
    limitUsd: z.number().min(MIN_LIMIT_USD, 'must be more than 0').max(MAX_LIMIT_USD, `must be at most ${MAX_LIMIT_USD}`).nullable(),
  })
  .refine(b => b.scope !== 'key' || !!b.keyId, { message: 'keyId is required for scope "key"', path: ['keyId'] });

/** Sets or removes a monthly limit. Every change writes an audit row with the old and new value. */
export const PUT = handle(async request => {
  requireSameOrigin(request);
  const user = await requireUser(request);
  const body = await parseBody(request, putSchema);
  const limit = body.limitUsd === null ? null : usdToMicro(body.limitUsd);
  const db = getDb();
  if (body.scope === 'account') {
    const [before] = await db.select({ limit: accounts.monthlyLimitMicroUsd }).from(accounts).where(eq(accounts.userId, user.userId)).limit(1);
    await db.update(accounts).set({ monthlyLimitMicroUsd: limit }).where(eq(accounts.userId, user.userId));
    await audit(request, user.userId, 'spend_limit.changed', { type: 'account', id: user.userId }, { scope: 'account' }, { before: { monthlyLimitMicroUsd: before?.limit ?? null }, after: { monthlyLimitMicroUsd: limit } });
  } else {
    const [before] = await db
      .select({ limit: apiKeys.monthlyLimitMicroUsd })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, body.keyId!), eq(apiKeys.userId, user.userId), isNull(apiKeys.revokedAt)))
      .limit(1);
    if (!before) throw new HttpError(404, 'Key not found', 'key_not_found');
    await db.update(apiKeys).set({ monthlyLimitMicroUsd: limit }).where(and(eq(apiKeys.id, body.keyId!), eq(apiKeys.userId, user.userId)));
    await audit(request, user.userId, 'spend_limit.changed', { type: 'api_key', id: body.keyId! }, { scope: 'key' }, { before: { monthlyLimitMicroUsd: before.limit ?? null }, after: { monthlyLimitMicroUsd: limit } });
  }
  return json({ ok: true, limitMicroUsd: limit });
});
