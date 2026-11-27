import { db1, HttpError } from './http';
import { purgeOldHolds } from './ledger';
import { redactText } from './redact';

/**
 * Fixed-window counter stored in D1. Returns when the limit is exceeded.
 * `key` should already include the scope (e.g. "login:ip:1.2.3.4").
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number, message = 'Too many requests. Please try again later.') {
  const now = Date.now();
  await maybePurge(now);
  const windowMs = windowSeconds * 1000;
  const row = await db1()
    .prepare(
      `INSERT INTO rate_limit_buckets (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start < ?3 THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END
       RETURNING count, window_start`,
    )
    .bind(key, now, now - windowMs)
    .first<{ count: number; window_start: number }>();
  if (row && row.count > limit) {
    const retry = Math.max(1, Math.ceil((row.window_start + windowMs - now) / 1000));
    throw new HttpError(429, message, 'rate_limited', { retry_after: retry }, { 'Retry-After': String(retry) });
  }
}

const PURGE_EVERY_MS = 3600 * 1000;
let lastPurge = 0;

/** FU-1, FU-3: at most once an hour per isolate, purge old rate-limit rows and old settled/released holds. A failure is logged (redacted) and never fails the request. */
export async function maybePurge(now = Date.now()) {
  if (now - lastPurge < PURGE_EVERY_MS) return;
  lastPurge = now;
  for (const [name, run] of [['rate limits', purgeRateLimits], ['holds', () => purgeOldHolds()]] as const) {
    try {
      await run();
    } catch (e) {
      console.error(`purge ${name} failed`, redactText(e instanceof Error ? e.message : String(e)));
    }
  }
}

/** For tests only: lets the hourly gate fire again. */
export function resetPurgeGate() {
  lastPurge = 0;
}

/** Deletes rate-limit rows older than the 24 h window. */
export async function purgeRateLimits() {
  await db1().prepare('DELETE FROM rate_limit_buckets WHERE window_start < ?1').bind(Date.now() - 24 * 3600 * 1000).run();
}
