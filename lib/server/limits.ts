import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db';
import { accounts, apiKeys } from '../../db/schema';
import { db1 } from './http';

/** FEAT-2: spend limits. A limit is in micro-USD, counts one UTC calendar month, and is optional (null = none). */
export const MAX_LIMIT_USD = 100_000;
export const MIN_LIMIT_USD = 0.000001;

export const usdToMicro = (usd: number) => Math.round(usd * 1_000_000);

/** Start of the current UTC month, in ms. */
export function monthStartMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * This month's charges plus open, unexpired holds, for the whole account (keyId null) or for one key.
 * A settled hold is already a usage row, so nothing is counted twice.
 */
export async function getMonthSpendAndHolds(userId: string, keyId: string | null, now = Date.now()): Promise<number> {
  const row = await db1()
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(cost_micro_usd) FROM usage_events WHERE user_id = ?1 AND created_at >= ?2 AND (?4 IS NULL OR key_id = ?4)), 0) +
         COALESCE((SELECT SUM(amount_micro_usd) FROM credit_holds WHERE user_id = ?1 AND status = 'open' AND expires_at > ?3 AND (?4 IS NULL OR key_id = ?4)), 0) AS used`,
    )
    .bind(userId, monthStartMs(now), now, keyId)
    .first<{ used: number }>();
  return Number(row?.used ?? 0);
}

export type SpendLimitHit = { scope: 'key' | 'account'; limitMicroUsd: number; usedMicroUsd: number };

/**
 * Call AFTER the credit hold is made: the used amount then includes this call's worst-case cost.
 * Returns the first limit that would be passed (key first, then account), or null when there is none.
 * shortcut: the hold is the worst case (max_tokens), so a call near the limit can be refused even if it would have cost less; fine for a safety limit.
 */
export async function checkSpendLimits(userId: string, keyId: string | null): Promise<SpendLimitHit | null> {
  const db = getDb();
  if (keyId) {
    const [k] = await db.select({ limit: apiKeys.monthlyLimitMicroUsd }).from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);
    if (k?.limit != null) {
      const used = await getMonthSpendAndHolds(userId, keyId);
      if (used > k.limit) return { scope: 'key', limitMicroUsd: k.limit, usedMicroUsd: used };
    }
  }
  const [a] = await db.select({ limit: accounts.monthlyLimitMicroUsd }).from(accounts).where(eq(accounts.userId, userId)).limit(1);
  if (a?.limit != null) {
    const used = await getMonthSpendAndHolds(userId, null);
    if (used > a.limit) return { scope: 'account', limitMicroUsd: a.limit, usedMicroUsd: used };
  }
  return null;
}

/** English and Arabic text for the 402. It says which limit was reached. */
export function spendLimitMessage(hit: SpendLimitHit): string {
  const limit = `$${(hit.limitMicroUsd / 1e6).toFixed(4)}`;
  const used = `$${(hit.usedMicroUsd / 1e6).toFixed(4)}`;
  const link = `${(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/dashboard`;
  return hit.scope === 'key'
    ? `Monthly spend limit reached for this API key (limit ${limit}; used or reserved this month ${used}). Raise or remove it in the dashboard. | تم بلوغ حد الإنفاق الشهري لهذا المفتاح (الحد ${limit}، المستخدم أو المحجوز هذا الشهر ${used}). يمكنك رفعه أو إزالته من لوحة التحكم: ${link}`
    : `Monthly spend limit reached for your account (limit ${limit}; used or reserved this month ${used}). Raise or remove it in the dashboard. | تم بلوغ حد الإنفاق الشهري لحسابك (الحد ${limit}، المستخدم أو المحجوز هذا الشهر ${used}). يمكنك رفعه أو إزالته من لوحة التحكم: ${link}`;
}
