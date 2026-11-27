import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { env } from 'cloudflare:workers';
import { getDb } from '../../db';
import { accounts, sessions } from '../../db/schema';
import { randomHex, sha256Hex } from '../../lib/server/crypto';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Starts a local, in-memory D1 (real SQLite inside the Workers runtime, via wrangler),
 * applies every drizzle migration and binds it as env.DB. Never touches a live database.
 */
export async function startDb() {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: path.join(ROOT, 'tests/wrangler.test.json'), persist: false });
  const files = readdirSync(path.join(ROOT, 'drizzle')).filter(f => /^\d+.*\.sql$/.test(f)).sort();
  for (const f of files) {
    for (const stmt of readFileSync(path.join(ROOT, 'drizzle', f), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await proxy.env.DB.prepare(stmt).run();
    }
  }
  env.DB = proxy.env.DB;
  // Admin routes fail closed without this (production mode). Tests that check that behaviour delete it.
  env.MFA_ENCRYPTION_KEY = 'test-only-mfa-key-0123456789-abcdefghij';
  return { dispose: () => proxy.dispose() };
}

export const ORIGIN = 'http://localhost';

/** Adds another session for a user. `mfaVerifiedAt` defaults to null (a fresh sign-in has not passed MFA). */
export async function newSession(userId: string, mfaVerifiedAt: number | null = null) {
  const token = randomHex(32);
  const now = Date.now();
  await getDb().insert(sessions).values({ id: await sha256Hex(token), userId, createdAt: now, lastSeenAt: now, expiresAt: now + 3600_000, mfaVerifiedAt });
  return `wasl_session=${token}`;
}

/** Admins get an MFA-verified session by default so older admin tests keep testing role checks; pass mfaVerifiedAt: null for a fresh sign-in. */
export async function makeUser(opts: { role?: string; verified?: boolean; status?: string; email?: string; expiresAt?: number; mfaVerifiedAt?: number | null } = {}) {
  const userId = `u_${randomHex(6)}`;
  const email = opts.email ?? `${userId}@example.test`;
  const now = Date.now();
  const db = getDb();
  await db.insert(accounts).values({ userId, email, createdAt: now, authProvider: 'password', role: opts.role ?? 'customer', status: opts.status ?? 'active', emailVerifiedAt: opts.verified === false ? null : now });
  const token = randomHex(32);
  await db.insert(sessions).values({ id: await sha256Hex(token), userId, createdAt: now, lastSeenAt: now, expiresAt: opts.expiresAt ?? now + 3600_000, mfaVerifiedAt: opts.mfaVerifiedAt !== undefined ? opts.mfaVerifiedAt : opts.role === 'admin' ? now : null });
  return { userId, email, cookie: `wasl_session=${token}` };
}

export function req(pathname: string, init: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string>; origin?: boolean } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.origin !== false && init.method && init.method !== 'GET') headers.origin = ORIGIN;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`${ORIGIN}${pathname}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body) });
}
