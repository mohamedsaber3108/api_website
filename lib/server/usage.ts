import { and, eq, gte, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../../db';
import { usageEvents } from '../../db/schema';

/** Most day-by-model rows returned. More rows set `byDayModelTruncated`. */
export const BY_DAY_MODEL_LIMIT = 1000;

/** Daily buckets and per-model totals for a user (or the whole platform when userId is null). `cap` is only for tests. */
export async function usageSummary(userId: string | null, days: number, cap = BY_DAY_MODEL_LIMIT) {
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
  // Day by model rows for the customer table. Skipped for the platform-wide (admin) view.
  // One extra row is read so a cut-off is known, not silent.
  const dayModelRows = userId
    ? await db
        .select({
          day,
          model: usageEvents.model,
          requests: sql<number>`COUNT(*)`,
          costMicroUsd: sql<number>`COALESCE(SUM(${usageEvents.costMicroUsd}), 0)`,
        })
        .from(usageEvents)
        .where(where)
        .groupBy(day, usageEvents.model)
        .orderBy(day, usageEvents.model)
        .limit(cap + 1)
    : [];
  const byDayModelTruncated = dayModelRows.length > cap;
  const byDayModel = byDayModelTruncated ? dayModelRows.slice(0, cap) : dayModelRows;
  return { days, daily, byModel, byDayModel, byDayModelTruncated, totals };
}

export function csvEscape(v: unknown): string {
  let s = String(v ?? '');
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
