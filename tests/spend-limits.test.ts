import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { auditLogs, creditHolds, usageEvents } from '../db/schema';
import { GET as limitsGet, PUT as limitsPut } from '../app/api/account/limits/route';
import { gatewayErrorResponse, newChatContext, parseChatRequest, runChat } from '../lib/server/gateway';
import { createApiKey } from '../lib/server/keys';
import { addLedgerEntry } from '../lib/server/ledger';
import { monthStartMs } from '../lib/server/limits';
import { usageSummary } from '../lib/server/usage';
import { makeUser, req, startDb } from './helpers/db';

// FEAT-2. Provider stubbed, no network. Same request as reservation.test.ts: worst-case hold 75 micro-USD,
// and a provider cost of 10 micro-USD is charged as 12 (20% markup).
const MODEL = 'minimax/minimax-m3.1-flash';
const HOLD = 75;
const CHARGE = 12;
let h: Awaited<ReturnType<typeof startDb>>;
const fetchSpy = vi.fn();
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });
beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
  env.INFERENCE_ENABLED = 'true';
  env.OPENROUTER_API_KEY = 'sk-or-not-a-real-key';
  fetchSpy.mockImplementation(async () => Response.json({ id: 'g', choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 12, completion_tokens: 2, cost: 0.00001 } }));
});
afterEach(() => { vi.unstubAllGlobals(); for (const k of ['INFERENCE_ENABLED', 'OPENROUTER_API_KEY', 'PUBLIC_BASE_URL']) delete (env as Record<string, unknown>)[k]; });

const noCtx = { params: Promise.resolve({}) };
const body = () => ({ model: MODEL, messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 });
const chatCalls = () => fetchSpy.mock.calls.filter(c => String(c[0]).startsWith('https://openrouter.ai/api/v1/chat/completions'));
const call = (userId: string, keyId: string | null = null) => runChat(newChatContext(userId, keyId, 'api'), parseChatRequest(body()));
const put = (cookie: string, b: object) => limitsPut(req('/api/account/limits', { method: 'PUT', cookie, body: b }), noCtx);
const holdsOf = (userId: string) => getDb().select().from(creditHolds).where(eq(creditHolds.userId, userId));
let n = 0;
const openHold = (userId: string, amount: number, keyId: string | null = null) => {
  const now = Date.now();
  return getDb().insert(creditHolds).values({ id: crypto.randomUUID(), userId, requestId: `x${++n}-${userId}`, amountMicroUsd: amount, status: 'open', createdAt: now, expiresAt: now + 600_000, keyId });
};
async function funded() {
  const u = await makeUser();
  await addLedgerEntry({ userId: u.userId, deltaMicroUsd: 10_000_000, type: 'topup', idempotencyKey: `fund:${u.userId}` });
  return u;
}
const newKey = async (userId: string) => (await createApiKey(userId, { name: 'k', scopes: ['chat'], expiresAt: null, rateLimitPerMin: 60 })).key.id;

describe('FEAT-2 spend limits in the gateway', () => {
  it('no limit: behaviour is unchanged', async () => {
    const u = await funded();
    const keyId = await newKey(u.userId);
    await expect(call(u.userId, keyId)).resolves.toBeInstanceOf(Response);
    expect(chatCalls()).toHaveLength(1);
  });

  it('an account limit below the worst-case cost blocks BEFORE the provider call, releases the hold, writes no usage', async () => {
    env.PUBLIC_BASE_URL = 'https://wasl.example';
    const u = await funded();
    expect((await put(u.cookie, { scope: 'account', limitUsd: 0.00005 })).status).toBe(200); // 50 micro < 75
    const err = await call(u.userId).catch(e => e);
    expect(err).toMatchObject({ status: 402, code: 'spend_limit_reached' });
    expect(err.message).toContain('for your account');
    expect(err.message).toContain('لحسابك');
    expect(err.extra.limit_micro_usd).toBe(50);
    expect(chatCalls()).toHaveLength(0);
    expect((await holdsOf(u.userId)).map(x => x.status)).toEqual(['released']);
    expect(await getDb().select().from(usageEvents).where(eq(usageEvents.userId, u.userId))).toHaveLength(0);
    const res = gatewayErrorResponse(err);
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe('spend_limit_reached');
  });

  it('charges this month count: calls pass until charges plus the new hold pass the limit', async () => {
    const u = await funded();
    await put(u.cookie, { scope: 'account', limitUsd: 0.00009 }); // 90 micro
    await call(u.userId); // 0 + 75 <= 90
    await call(u.userId); // 12 + 75 = 87 <= 90
    await expect(call(u.userId)).rejects.toMatchObject({ status: 402, code: 'spend_limit_reached' }); // 24 + 75 = 99 > 90
    expect(chatCalls()).toHaveLength(2);
  });

  it('charges from an earlier month are not counted', async () => {
    const u = await funded();
    await getDb().insert(usageEvents).values({ id: crypto.randomUUID(), userId: u.userId, model: MODEL, inputTokens: 1, outputTokens: 1, costMicroUsd: 5_000_000, createdAt: monthStartMs() - 1000, requestId: `old-${u.userId}` });
    await put(u.cookie, { scope: 'account', limitUsd: 0.0001 });
    await expect(call(u.userId)).resolves.toBeInstanceOf(Response);
  });

  it('open holds count toward the limit; an expired hold does not', async () => {
    const u = await funded();
    await put(u.cookie, { scope: 'account', limitUsd: 0.0001 }); // 100 micro
    await openHold(u.userId, 60); // 60 + 75 > 100
    await expect(call(u.userId)).rejects.toMatchObject({ code: 'spend_limit_reached' });
    await getDb().update(creditHolds).set({ expiresAt: Date.now() - 1 }).where(eq(creditHolds.userId, u.userId));
    await expect(call(u.userId)).resolves.toBeInstanceOf(Response);
  });

  it('a per-key limit blocks that key only; another key and the playground still work', async () => {
    env.PUBLIC_BASE_URL = 'https://wasl.example';
    const u = await funded();
    const a = await newKey(u.userId);
    const b = await newKey(u.userId);
    expect((await put(u.cookie, { scope: 'key', keyId: a, limitUsd: 0.00005 })).status).toBe(200);
    const err = await call(u.userId, a).catch(e => e);
    expect(err).toMatchObject({ status: 402, code: 'spend_limit_reached' });
    expect(err.message).toContain('this API key');
    expect(err.message).toContain('لهذا المفتاح');
    await expect(call(u.userId, b)).resolves.toBeInstanceOf(Response);
    await expect(call(u.userId, null)).resolves.toBeInstanceOf(Response);
  });

  it('per-key counting uses that key charges and holds only; the account limit counts all keys', async () => {
    const u = await funded();
    const a = await newKey(u.userId);
    const b = await newKey(u.userId);
    await put(u.cookie, { scope: 'key', keyId: a, limitUsd: 0.0001 }); // 100 micro
    await openHold(u.userId, 60, b); // other key: does not count for key a
    await expect(call(u.userId, a)).resolves.toBeInstanceOf(Response);
    await openHold(u.userId, 60, a); // key a: now 60 + 12 + 75 > 100
    await expect(call(u.userId, a)).rejects.toMatchObject({ code: 'spend_limit_reached' });
    await put(u.cookie, { scope: 'key', keyId: a, limitUsd: null });
    await put(u.cookie, { scope: 'account', limitUsd: 0.0001 }); // account counts both keys: 120 + 12 + 75 > 100
    await expect(call(u.userId, b)).rejects.toMatchObject({ code: 'spend_limit_reached' });
  });
});

describe('FEAT-2 parallel calls near the limit', () => {
  it('two parallel calls cannot charge more than the limit (both refused is allowed)', async () => {
    const u = await funded();
    const limit = 90; // micro-USD. One call needs a 75 hold, so two holds (150) do not fit.
    await put(u.cookie, { scope: 'account', limitUsd: limit / 1e6 });
    const results = await Promise.allSettled([call(u.userId), call(u.userId)]);
    const ok = results.filter(r => r.status === 'fulfilled').length;
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 402, code: 'spend_limit_reached' });
    const charged = (await getDb().select().from(usageEvents).where(eq(usageEvents.userId, u.userId))).reduce((s, e) => s + e.costMicroUsd, 0);
    expect(charged).toBeLessThanOrEqual(limit);
    expect(ok).toBeLessThanOrEqual(1);
    expect(chatCalls()).toHaveLength(ok);
    expect(charged).toBe(ok * CHARGE);
  });
});

describe('FEAT-2 usage truncation', () => {
  it('byDayModelTruncated is false at the cap and true above it, and only cap rows come back', async () => {
    const u = await makeUser();
    const now = Date.now();
    const ev = (model: string) => getDb().insert(usageEvents).values({ id: crypto.randomUUID(), userId: u.userId, model, inputTokens: 1, outputTokens: 1, costMicroUsd: 1, createdAt: now, requestId: `trunc-${crypto.randomUUID()}` });
    await ev('m/a');
    await ev('m/b');
    const atCap = await usageSummary(u.userId, 7, 2);
    expect(atCap.byDayModel).toHaveLength(2);
    expect(atCap.byDayModelTruncated).toBe(false);
    await ev('m/c');
    const over = await usageSummary(u.userId, 7, 2);
    expect(over.byDayModel).toHaveLength(2);
    expect(over.byDayModelTruncated).toBe(true);
  });
});

describe('FEAT-2 limits route', () => {
  it('a change writes an audit row with before and after; removing the limit is audited too', async () => {
    const u = await funded();
    const keyId = await newKey(u.userId);
    await put(u.cookie, { scope: 'account', limitUsd: 5 });
    await put(u.cookie, { scope: 'key', keyId, limitUsd: 2.5 });
    await put(u.cookie, { scope: 'account', limitUsd: null });
    const rows = (await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'spend_limit.changed'))).filter(r => r.actorId === u.userId).sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0));
    expect(rows).toHaveLength(3);
    expect(JSON.parse(rows[0].after!)).toEqual({ monthlyLimitMicroUsd: 5_000_000 });
    expect(JSON.parse(rows[0].before!)).toEqual({ monthlyLimitMicroUsd: null });
    expect(rows[1]).toMatchObject({ targetType: 'api_key', targetId: keyId });
    expect(JSON.parse(rows[1].after!)).toEqual({ monthlyLimitMicroUsd: 2_500_000 });
    expect(JSON.parse(rows[2].before!)).toEqual({ monthlyLimitMicroUsd: 5_000_000 });
    const got = await (await limitsGet(req('/api/account/limits', { cookie: u.cookie }), noCtx)).json();
    expect(got.account.limitMicroUsd).toBeNull();
    expect(got.keys.find((k: { id: string }) => k.id === keyId).limitMicroUsd).toBe(2_500_000);
  });

  it.each([
    ['zero', { scope: 'account', limitUsd: 0 }],
    ['negative', { scope: 'account', limitUsd: -1 }],
    ['above 100000', { scope: 'account', limitUsd: 100_001 }],
    ['not a number', { scope: 'account', limitUsd: 'ten' }],
    ['unknown scope', { scope: 'team', limitUsd: 1 }],
    ['key scope without keyId', { scope: 'key', limitUsd: 1 }],
  ])('bad input (%s) -> 400 and nothing is saved', async (_n, b) => {
    const u = await funded();
    const r = await put(u.cookie, b);
    expect(r.status).toBe(400);
    expect((await (await limitsGet(req('/api/account/limits', { cookie: u.cookie }), noCtx)).json()).account.limitMicroUsd).toBeNull();
  });

  it('100000 USD is accepted; another user key gets 404; a foreign origin gets 403', async () => {
    const u = await funded();
    const other = await funded();
    const otherKey = await newKey(other.userId);
    expect((await put(u.cookie, { scope: 'account', limitUsd: 100_000 })).status).toBe(200);
    expect((await put(u.cookie, { scope: 'key', keyId: otherKey, limitUsd: 1 })).status).toBe(404);
    const r = await limitsPut(req('/api/account/limits', { method: 'PUT', cookie: u.cookie, body: { scope: 'account', limitUsd: 1 }, origin: false, headers: { origin: 'https://evil.example' } }), noCtx);
    expect(r.status).toBe(403);
  });

  it('requires a signed-in user', async () => {
    expect((await limitsGet(req('/api/account/limits'), noCtx)).status).toBe(401);
  });
});

describe('FEAT-2 usage aggregation', () => {
  it('groups by day and by model for one user only, and respects the day window', async () => {
    const u = await makeUser();
    const other = await makeUser();
    const now = Date.now();
    const ev = (userId: string, model: string, cost: number, createdAt: number) =>
      getDb().insert(usageEvents).values({ id: crypto.randomUUID(), userId, model, inputTokens: 10, outputTokens: 5, costMicroUsd: cost, createdAt, requestId: `agg-${crypto.randomUUID()}` });
    await ev(u.userId, 'm/a', 100, now);
    await ev(u.userId, 'm/a', 50, now);
    await ev(u.userId, 'm/b', 10, now);
    await ev(u.userId, 'm/a', 5, now - 2 * 86_400_000);
    await ev(other.userId, 'm/a', 999, now);
    const today = new Date(now).toISOString().slice(0, 10);
    const s7 = await usageSummary(u.userId, 7);
    expect(s7.byDayModel).toHaveLength(3);
    expect(s7.byDayModel.find(r => r.day === today && r.model === 'm/a')).toMatchObject({ requests: 2, costMicroUsd: 150 });
    expect(s7.byDayModel.find(r => r.day === today && r.model === 'm/b')).toMatchObject({ requests: 1, costMicroUsd: 10 });
    expect(s7.daily.find(d => d.day === today)).toMatchObject({ requests: 3, costMicroUsd: 160 });
    expect(s7.byModel.find(m => m.model === 'm/a')).toMatchObject({ requests: 3, costMicroUsd: 155 });
    const s1 = await usageSummary(u.userId, 1);
    expect(s1.byDayModel.every(r => r.day === today)).toBe(true);
  });
});
