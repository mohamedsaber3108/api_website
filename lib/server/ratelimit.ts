import { clientIp, db1, HttpError } from './http';

/**
 * Fixed-window counter stored in D1. Returns when the limit is exceeded.
 * `key` should already include the scope (e.g. "login:ip:1.2.3.4").
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number, message = 'Too many requests. Please try again later.') {
  const now = Date.now();
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

/** Plain bilingual 429 text with the wait time. */
export function limitMessage(seconds: number) {
  return `Too many requests. Please wait ${seconds} seconds and try again. | طلبات كثيرة. انتظر ${seconds} ثانية ثم حاول مرة أخرى.`;
}

/**
 * Per-IP limit for public routes that have no HttpError wrapper. Returns a 429 Response when over
 * the limit (Retry-After set, message in English and Arabic), otherwise null.
 * shortcut: fixed window per IP; if the proxy header is missing all callers share the "unknown" bucket.
 */
export async function publicLimit(request: Request, name: string, limit: number, windowSeconds: number, headers: Record<string, string> = {}): Promise<Response | null> {
  try {
    await rateLimit(`pub:${name}:ip:${clientIp(request)}`, limit, windowSeconds);
    return null;
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 429) throw e;
    const retry = Number(e.extra.retry_after) || 1;
    return Response.json({ error: limitMessage(retry), code: 'rate_limited', retry_after: retry }, { status: 429, headers: { 'Cache-Control': 'no-store', ...headers, ...e.headers } });
  }
}

/** Opportunistic cleanup; call occasionally from low-traffic paths. */
export async function purgeRateLimits() {
  await db1().prepare('DELETE FROM rate_limit_buckets WHERE window_start < ?1').bind(Date.now() - 24 * 3600 * 1000).run();
}
