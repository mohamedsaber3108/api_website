import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../db';
import { apiKeys } from '../../db/schema';
import { randomHex, sha256Hex } from './crypto';
import { HttpError } from './http';

export const MAX_ACTIVE_KEYS = 10;
export const KEY_SCOPES = ['chat', 'usage'] as const;

/** Columns that are safe to return to the owner. The hash is never exposed. */
export const keyColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  expiresAt: apiKeys.expiresAt,
  rateLimitPerMin: apiKeys.rateLimitPerMin,
};

export type NewKeyOptions = { name: string; scopes: string[]; expiresAt: number | null; rateLimitPerMin: number; rotatedFromId?: string };

export async function createApiKey(userId: string, opts: NewKeyOptions) {
  const db = getDb();
  const active = await db.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt))).limit(MAX_ACTIVE_KEYS + 1);
  if (active.length >= MAX_ACTIVE_KEYS) throw new HttpError(429, `Maximum ${MAX_ACTIVE_KEYS} active keys`, 'key_limit');
  const secret = `wasl_${randomHex(32)}`;
  const key = {
    id: crypto.randomUUID(),
    userId,
    name: opts.name,
    prefix: secret.slice(0, 15),
    hash: await sha256Hex(secret),
    createdAt: Date.now(),
    scopes: opts.scopes.join(','),
    expiresAt: opts.expiresAt,
    rateLimitPerMin: opts.rateLimitPerMin,
    rotatedFromId: opts.rotatedFromId ?? null,
  };
  await db.insert(apiKeys).values(key);
  return { secret, key: { id: key.id, name: key.name, prefix: key.prefix, scopes: key.scopes, createdAt: key.createdAt, lastUsedAt: null, expiresAt: key.expiresAt, rateLimitPerMin: key.rateLimitPerMin } };
}
