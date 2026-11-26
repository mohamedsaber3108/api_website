import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { apiKeys } from '../db/schema';
import { authenticateApiKey } from '../lib/server/gateway';
import { createApiKey, MAX_ACTIVE_KEYS } from '../lib/server/keys';
import { makeUser, req, startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });

const bearer = (secret: string) => req('/api/v1/chat/completions', { method: 'POST', origin: false, headers: { authorization: `Bearer ${secret}` } });

async function newKey(opts: Partial<{ scopes: string[]; expiresAt: number | null }> = {}, user?: { userId: string }) {
  const u = user ?? (await makeUser());
  const { secret, key } = await createApiKey(u.userId, { name: 'k', scopes: opts.scopes ?? ['chat'], expiresAt: opts.expiresAt ?? null, rateLimitPerMin: 60 });
  return { u, secret, key };
}

describe('API key auth', () => {
  it('accepts a valid key and records last use', async () => {
    const { u, secret, key } = await newKey();
    const auth = await authenticateApiKey(bearer(secret), 'chat');
    expect(auth).toMatchObject({ userId: u.userId, keyId: key.id, scopes: ['chat'], rateLimitPerMin: 60 });
    const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(row.lastUsedAt).toBeGreaterThan(0);
  });
  it('stores a hash, never the secret', async () => {
    const { secret, key } = await newKey();
    const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(row.hash).not.toBe(secret);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(secret).toMatch(/^wasl_[a-f0-9]{64}$/);
  });
  it.each([
    ['no header', undefined],
    ['wrong scheme', 'Basic abc'],
    ['malformed key', 'Bearer wasl_short'],
    ['unknown key', `Bearer wasl_${'0'.repeat(64)}`],
  ])('%s -> 401 invalid_api_key', async (_n, header) => {
    const r = new Request('http://localhost/x', { headers: header ? { authorization: header } : {} });
    await expect(authenticateApiKey(r, 'chat')).rejects.toMatchObject({ status: 401, code: 'invalid_api_key' });
  });
  it('a revoked key -> 401', async () => {
    const { secret, key } = await newKey();
    await getDb().update(apiKeys).set({ revokedAt: Date.now() }).where(eq(apiKeys.id, key.id));
    await expect(authenticateApiKey(bearer(secret), 'chat')).rejects.toMatchObject({ status: 401, code: 'invalid_api_key' });
  });
  it('an expired key -> 401, a key expiring later works', async () => {
    const expired = await newKey({ expiresAt: Date.now() - 1000 });
    await expect(authenticateApiKey(bearer(expired.secret), 'chat')).rejects.toMatchObject({ status: 401, code: 'invalid_api_key' });
    const later = await newKey({ expiresAt: Date.now() + 60_000 });
    await expect(authenticateApiKey(bearer(later.secret), 'chat')).resolves.toBeTruthy();
  });
  it('wrong scope -> 403 insufficient_scope', async () => {
    const { secret } = await newKey({ scopes: ['usage'] });
    await expect(authenticateApiKey(bearer(secret), 'chat')).rejects.toMatchObject({ status: 403, code: 'insufficient_scope' });
    await expect(authenticateApiKey(bearer(secret), 'usage')).resolves.toBeTruthy();
  });
  it('a key of a suspended account -> 401', async () => {
    const u = await makeUser({ status: 'suspended' });
    const { secret } = await newKey({}, u);
    await expect(authenticateApiKey(bearer(secret), 'chat')).rejects.toMatchObject({ status: 401 });
  });
  it(`limits active keys to ${MAX_ACTIVE_KEYS} (429 key_limit)`, async () => {
    const u = await makeUser();
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) await newKey({}, u);
    await expect(newKey({}, u)).rejects.toMatchObject({ status: 429, code: 'key_limit' });
  });
});
