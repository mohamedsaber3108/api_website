import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../../../db';
import { accounts, apiKeys, creditLedger, payments, supportTickets, usageEvents } from '../../../../db/schema';
import { requireRole } from '../../../../lib/server/auth';
import { handle, json } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async request => {
  await requireRole(request, 'admin', 'support');
  const db = getDb();
  const since = Date.now() - 30 * 86_400_000;
  const [[users], [keys], [openTickets], [revenue], [usage], [liability], recent] = await Promise.all([
    db.select({ total: sql<number>`COUNT(*)`, last30: sql<number>`COALESCE(SUM(CASE WHEN ${accounts.createdAt} >= ${since} THEN 1 ELSE 0 END), 0)` }).from(accounts).where(eq(accounts.status, 'active')),
    db.select({ total: sql<number>`COUNT(*)` }).from(apiKeys).where(isNull(apiKeys.revokedAt)),
    db.select({ total: sql<number>`COUNT(*)` }).from(supportTickets).where(eq(supportTickets.status, 'open')),
    db.select({ amountMinor: sql<number>`COALESCE(SUM(${payments.amountMinor} - ${payments.refundedMinor}), 0)` }).from(payments).where(and(eq(payments.status, 'paid'), gte(payments.completedAt, since))),
    db
      .select({
        requests: sql<number>`COUNT(*)`,
        billedMicroUsd: sql<number>`COALESCE(SUM(${usageEvents.costMicroUsd}), 0)`,
        providerMicroUsd: sql<number>`COALESCE(SUM(${usageEvents.providerCostMicroUsd}), 0)`,
      })
      .from(usageEvents)
      .where(gte(usageEvents.createdAt, since)),
    db.select({ total: sql<number>`COALESCE(SUM(${creditLedger.deltaMicroUsd}), 0)` }).from(creditLedger),
    db.select({ id: accounts.userId, email: accounts.email, name: accounts.name, createdAt: accounts.createdAt }).from(accounts).orderBy(desc(accounts.createdAt)).limit(8),
  ]);
  return json({
    users: { total: Number(users?.total ?? 0), last30Days: Number(users?.last30 ?? 0) },
    activeKeys: Number(keys?.total ?? 0),
    openTickets: Number(openTickets?.total ?? 0),
    revenueLast30DaysMinor: Number(revenue?.amountMinor ?? 0),
    usageLast30Days: { requests: Number(usage?.requests ?? 0), billedMicroUsd: Number(usage?.billedMicroUsd ?? 0), providerMicroUsd: Number(usage?.providerMicroUsd ?? 0) },
    customerCreditsOutstandingMicroUsd: Number(liability?.total ?? 0),
    recentSignups: recent,
  });
});
