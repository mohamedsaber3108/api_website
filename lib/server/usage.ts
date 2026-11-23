import { and, eq, gte, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../../db';
import { usageEvents } from '../../db/schema';

/** Daily buckets and per-model totals for a user (or the whole platform when userId is null). */
export async function usageSummary(userId: string | null, days: number) {
  const since = Date.now() - days * 86_400_000;
  const where: SQL | undefined = userId ? and(eq(usageEvents.userId, userId), gte(usageEvents.createdAt, since)) : gte(usageEvents.createdAt, since);
  const db = getDb();
  const day = sql<string>`strftime('%Y-%m-%d', ${usageEvents.createdAt} / 1000, 'unixepoch')`;
  const [daily, byModel, [totals]] = await Promise.all([
    db
      .select({
        day,
        requests: sql<number>`COUNT(*)`,
        tokens: sql<number>`COALESCE(SUM(${usageEvents.inputTokens} + ${usageEvents.outputTokens}), 0)`,
        costMicroUsd: sql<number>`COALESCE(SUM(${usageEvents.costMicroUsd}), 0)`,
      })
      .from(usageEvents)
      .where(where)
      .groupBy(day)
      .orderBy(day),
    db
      .select({
        model: usageEvents.model,
        requests: sql<number>`COUNT(*)`,
        inputTokens: sql<number>`COALESCE(SUM(${usageEvents.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)`,
        costMicroUsd: sql<number>`COALESCE(SUM(${usageEvents.costMicroUsd}), 0)`,
      })
      .from(usageEvents)
      .where(where)
      .groupBy(usageEvents.model)
      .orderBy(sql`SUM(${usageEvents.costMicroUsd}) DESC`)
      .limit(25),
    db
      .select({
        requests: sql<number>`COUNT(*)`,
        errors: sql<number>`COALESCE(SUM(CASE WHEN ${usageEvents.status} = 'error' THEN 1 ELSE 0 END), 0)`,
        inputTokens: sql<number>`COALESCE(SUM(${usageEvents.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)`,
        costMicroUsd: sql<number>`COALESCE(SUM(${usageEvents.costMicroUsd}), 0)`,
        providerCostMicroUsd: sql<number>`COALESCE(SUM(${usageEvents.providerCostMicroUsd}), 0)`,
      })
      .from(usageEvents)
      .where(where),
  ]);
  return { days, daily, byModel, totals };
}

export function csvEscape(v: unknown): string {
  let s = String(v ?? '');
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
