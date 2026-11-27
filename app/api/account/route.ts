import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../db';
import { accounts, apiKeys, sessions, usageEvents } from '../../../db/schema';
import { audit } from '../../../lib/server/audit';
import { requireUser } from '../../../lib/server/auth';
import { features } from '../../../lib/server/config';
import { fail, handle, json, parseBody, requireSameOrigin } from '../../../lib/server/http';
import { verifyPassword } from '../../../lib/server/crypto';
import { keyColumns } from '../../../lib/server/keys';
import { getBalanceSummary } from '../../../lib/server/ledger';

export const dynamic = 'force-dynamic';

export const GET = handle(async request => {
  const user = await requireUser(request);
  const db = getDb();
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [keys, events, [month], summary, [acct]] = await Promise.all([
    db.select(keyColumns).from(apiKeys).where(and(eq(apiKeys.userId, user.userId), isNull(apiKeys.revokedAt))).orderBy(desc(apiKeys.createdAt)),
    db
      .select({ id: usageEvents.id, model: usageEvents.model, inputTokens: usageEvents.inputTokens, outputTokens: usageEvents.outputTokens, costMicroUsd: usageEvents.costMicroUsd, createdAt: usageEvents.createdAt, status: usageEvents.status, source: usageEvents.source })
      .from(usageEvents)
      .where(eq(usageEvents.userId, user.userId))
      .orderBy(desc(usageEvents.createdAt))
      .limit(50),
    db
      .select({
        requests: sql<number>`COUNT(*)`,
        costMicroUsd: sql<number>`COALESCE(SUM(${usageEvents.costMicroUsd}), 0)`,
        tokens: sql<number>`COALESCE(SUM(${usageEvents.inputTokens} + ${usageEvents.outputTokens}), 0)`,
      })
      .from(usageEvents)
      .where(and(eq(usageEvents.userId, user.userId), gte(usageEvents.createdAt, monthStart.getTime()))),
    getBalanceSummary(user.userId),
    db.select({ preferences: accounts.preferences, createdAt: accounts.createdAt }).from(accounts).where(eq(accounts.userId, user.userId)).limit(1),
  ]);
  return json({
    account: {
      email: user.email,
      displayName: user.name,
      name: user.name,
      role: user.role,
      provider: user.provider,
      emailVerified: user.emailVerified,
      createdAt: acct?.createdAt ?? null,
      preferences: acct?.preferences ? JSON.parse(acct.preferences) : {},
    },
    balanceMicroUsd: summary.balanceMicroUsd,
    heldMicroUsd: summary.heldMicroUsd,
    availableMicroUsd: summary.availableMicroUsd,
    month: { requests: Number(month?.requests ?? 0), costMicroUsd: Number(month?.costMicroUsd ?? 0), tokens: Number(month?.tokens ?? 0) },
    keys,
    usage: events,
    service: { keyIssuance: true, inference: features.inference(), checkout: features.billing() },
  });
});

/** Deletes the account: revokes keys and sessions and anonymises personal data. Ledger and invoices are kept for accounting. */
export const DELETE = handle(async request => {
  requireSameOrigin(request);
  const user = await requireUser(request);
  const { password } = await parseBody(request, z.object({ password: z.string().max(200).optional(), confirm: z.literal('DELETE') }));
  const db = getDb();
  if (user.provider === 'password') {
    const [a] = await db.select({ hash: accounts.passwordHash }).from(accounts).where(eq(accounts.userId, user.userId)).limit(1);
    if (!password || !(await verifyPassword(password, a?.hash ?? null))) return fail(403, 'Password is incorrect', 'invalid_credentials');
  }
  const now = Date.now();
  await db.batch([
    db.update(apiKeys).set({ revokedAt: now }).where(and(eq(apiKeys.userId, user.userId), isNull(apiKeys.revokedAt))),
    db.delete(sessions).where(eq(sessions.userId, user.userId)),
    db.update(accounts).set({ status: 'deleted', email: `deleted+${user.userId}@invalid.local`, name: null, passwordHash: null, preferences: null }).where(eq(accounts.userId, user.userId)),
  ]);
  await audit(request, user.userId, 'account.deleted', { type: 'account', id: user.userId });
  return json({ ok: true }, 200, { 'Set-Cookie': 'wasl_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
});
