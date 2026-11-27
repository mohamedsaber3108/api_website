import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { usageEvents } from '../db/schema';
import { enforceGatewayRateLimit, gatewayErrorResponse, newChatContext, parseChatRequest, runChat } from '../lib/server/gateway';
import { addLedgerEntry, getBalanceMicroUsd } from '../lib/server/ledger';
import { fail, handle } from '../lib/server/http';
import { rateLimit } from '../lib/server/ratelimit';
import { POST as chatRoute } from '../app/api/v1/chat/completions/route';
import { createApiKey } from '../lib/server/keys';
import { makeUser, req, startDb } from './helpers/db';

// Snapshot model: input 0.15 and output 0.6 micro-USD per token (see data/catalog-snapshot.json).
const MODEL = 'minimax/minimax-m3.1-flash';
let h: Awaited<ReturnType<typeof startDb>>;
const fetchSpy = vi.fn();
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });
beforeEach(() => {
  fetchSpy.mockReset();
  // The model catalog falls back to the bundled snapshot when this rejects; the chat provider is a local stub.
  fetchSpy.mockImplementation(async (url: string) => {
    if (String(url).startsWith('https://openrouter.ai/api/v1/chat/completions')) return Response.json(providerReply);
    throw new Error('network disabled in tests: ' + url);
  });
  vi.stubGlobal('fetch', fetchSpy);
  env.INFERENCE_ENABLED = 'true';
  env.OPENROUTER_API_KEY = 'sk-or-not-a-real-key';
});
afterEach(() => { vi.unstubAllGlobals(); for (const k of ['INFERENCE_ENABLED', 'OPENROUTER_API_KEY', 'DEFAULT_MARKUP_PERCENT']) delete (env as Record<string, unknown>)[k]; });

let providerReply: Record<string, unknown> = {};
const reply = (usage: Record<string, unknown>) => { providerReply = { id: 'gen-1', provider: 'X', choices: [{ message: { role: 'assistant', content: 'hi' } }], usage }; };
const body = (extra: object = {}) => ({ model: MODEL, messages: [{ role: 'user', content: 'hello' }], max_tokens: 4000, ...extra }); // worst case ~2.9k micro, so provider costs up to that are charged in full (the hold caps a charge)

async function funded(micro = 10_000_000) {
  const u = await makeUser();
  await addLedgerEntry({ userId: u.userId, deltaMicroUsd: micro, type: 'topup', idempotencyKey: `fund:${u.userId}` });
  return u;
}
async function charge(userId: string, usage: Record<string, unknown>) {
  reply(usage);
  const ctx = newChatContext(userId, null, 'api');
  const res = await runChat(ctx, parseChatRequest(body()));
  const json = await res.json();
  return { json, charged: Math.round(json.wasl.charged_usd * 1e6), ctx };
}

describe('chargeMicro (through runChat, provider stubbed)', () => {
  it('adds the default 20% markup and rounds up: provider 1000 micro -> 1200', async () => {
    const u = await funded();
    const { charged, ctx } = await charge(u.userId, { prompt_tokens: 10, completion_tokens: 10, cost: 0.001 });
    expect(charged).toBe(1200);
    expect(await getBalanceMicroUsd(u.userId)).toBe(10_000_000 - 1200);
    const [ev] = await getDb().select().from(usageEvents).where(eq(usageEvents.requestId, ctx.requestId));
    expect(ev).toMatchObject({ costMicroUsd: 1200, providerCostMicroUsd: 1000, status: 'ok' });
  });
  it('charges at least 1 micro-USD whenever the provider cost is above 0', async () => {
    const u = await funded();
    expect((await charge(u.userId, { cost: 0.000001 })).charged).toBe(2); // provider 1 micro -> ceil(1.2)
  });
  it('without a provider cost it prices from tokens: 100*0.15 + 10*0.6 = 21 -> ceil(25.2) = 26', async () => {
    const u = await funded();
    expect((await charge(u.userId, { prompt_tokens: 100, completion_tokens: 10 })).charged).toBe(26);
  });
  it('markup comes from DEFAULT_MARKUP_PERCENT; invalid values fall back to 20', async () => {
    const u = await funded();
    env.DEFAULT_MARKUP_PERCENT = '100';
    expect((await charge(u.userId, { cost: 0.001 })).charged).toBe(2000);
    env.DEFAULT_MARKUP_PERCENT = 'abc';
    expect((await charge(u.userId, { cost: 0.001 })).charged).toBe(1200);
    env.DEFAULT_MARKUP_PERCENT = '9999';
    expect((await charge(u.userId, { cost: 0.001 })).charged).toBe(1200);
  });
  it('rounds with integers: provider 50 micro at 10% markup charges exactly 55', async () => {
    // 50 * (1 + 10/100) is 55.00000000000001 in floating point; the old Math.ceil charged 56.
    const u = await funded();
    env.DEFAULT_MARKUP_PERCENT = '10';
    expect((await charge(u.userId, { cost: 0.00005 })).charged).toBe(55);
  });
  it('a provider cost above 0 but under 0.5 micro-USD still charges at least 1 micro-USD', async () => {
    const u = await funded();
    const { charged, ctx } = await charge(u.userId, { prompt_tokens: 5, completion_tokens: 5, cost: 0.0000004 });
    expect(charged).toBeGreaterThanOrEqual(1);
    const [ev] = await getDb().select().from(usageEvents).where(eq(usageEvents.requestId, ctx.requestId));
    expect(ev.providerCostMicroUsd).toBe(1);
    expect(ev.costMicroUsd).toBe(charged);
  });
  it('a provider cost of exactly 0 stays free', async () => {
    const u = await funded();
    expect((await charge(u.userId, { prompt_tokens: 5, completion_tokens: 5, cost: 0 })).charged).toBe(0);
  });
  it('hides the provider cost, provider name and cost details from the customer', async () => {
    const u = await funded();
    const { json } = await charge(u.userId, { prompt_tokens: 1, completion_tokens: 1, cost: 0.001, cost_details: { x: 1 }, is_byok: false });
    expect(json.usage).toEqual({ prompt_tokens: 1, completion_tokens: 1 });
    expect(json.provider).toBeUndefined();
  });
  it('writes the usage ledger entry once per request id', async () => {
    const u = await funded();
    const { ctx } = await charge(u.userId, { cost: 0.001 });
    reply({ cost: 0.001 });
    await runChat(ctx, parseChatRequest(body())); // same request id again
    expect(await getBalanceMicroUsd(u.userId)).toBe(10_000_000 - 1200);
  });
  it('a provider error charges nothing and is recorded as an error', async () => {
    const u = await funded();
    fetchSpy.mockImplementation(async (url: string) => String(url).includes('chat/completions') ? Response.json({ error: { message: 'x' } }, { status: 500 }) : Promise.reject(new Error('offline')));
    const ctx = newChatContext(u.userId, null, 'api');
    await expect(runChat(ctx, parseChatRequest(body()))).rejects.toMatchObject({ status: 502, code: 'upstream_error' });
    expect(await getBalanceMicroUsd(u.userId)).toBe(10_000_000);
  });
});

describe('gateway preconditions and error codes', () => {
  const asKey = async (u: { userId: string }) => (await createApiKey(u.userId, { name: 'k', scopes: ['chat'], expiresAt: null, rateLimitPerMin: 60 })).secret;
  const call = (secret: string | null, b: unknown = body()) =>
    chatRoute(req('/api/v1/chat/completions', { method: 'POST', origin: false, body: b, headers: secret ? { authorization: `Bearer ${secret}` } : {} }));

  it('401: stable code invalid_api_key, error object shape is OpenAI-like', async () => {
    const res = await call(null);
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.error).toMatchObject({ code: 'invalid_api_key', type: 'invalid_request_error' });
    expect(typeof j.error.message).toBe('string');
  });
  it('402: stable code insufficient_credits when the balance is below the worst-case cost', async () => {
    const u = await makeUser();
    const res = await call(await asKey(u));
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe('insufficient_credits');
    expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('chat/completions'))).toBe(false); // provider never reached
  });
  it('503 service_not_activated when INFERENCE_ENABLED is not true, provider not called', async () => {
    env.INFERENCE_ENABLED = 'false';
    const u = await funded();
    const res = await call(await asKey(u));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('service_not_activated');
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('chat/completions'))).toBe(false);
  });
  it('400 invalid_request / invalid_json, 404 model_not_found, 413 payload_too_large', async () => {
    const u = await funded();
    const k = await asKey(u);
    expect((await (await call(k, { model: 'x', messages: [] })).json()).error.code).toBe('invalid_request');
    expect((await (await call(k, '{not json')).json()).error.code).toBe('invalid_json');
    const nf = await call(k, body({ model: 'nobody/no-such-model' }));
    expect(nf.status).toBe(404);
    expect((await nf.json()).error.code).toBe('model_not_found');
    const big = await chatRoute(req('/x', { method: 'POST', origin: false, body: '{}', headers: { authorization: `Bearer ${k}`, 'content-length': '600000' } }));
    expect(big.status).toBe(413);
  });
  it('429: rateLimit throws rate_limited with Retry-After; the gateway maps it to rate_limit_exceeded', async () => {
    const key = `test:rl:${crypto.randomUUID()}`;
    await rateLimit(key, 2, 60);
    await rateLimit(key, 2, 60);
    const err = await rateLimit(key, 2, 60).catch(e => e);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(Number(err.headers['Retry-After'])).toBeGreaterThanOrEqual(1);

    const auth = { userId: 'u', keyId: `k_${crypto.randomUUID()}`, rateLimitPerMin: 1 };
    await enforceGatewayRateLimit(auth);
    const g = await enforceGatewayRateLimit(auth).then(() => null, e => e);
    expect(g).toMatchObject({ status: 429, code: 'rate_limit_exceeded' });
    const res = gatewayErrorResponse(g);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect((await res.json()).error.code).toBe('rate_limit_exceeded');
  });
  it('web routes: handle() turns HttpError into { error, code } and unknown errors into 500 internal_error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r402 = await handle(async () => fail(402, 'Payment required', 'insufficient_credits'))(req('/x'), { params: Promise.resolve({}) });
    expect(r402.status).toBe(402);
    expect(await r402.json()).toEqual({ error: 'Payment required', code: 'insufficient_credits' });
    const r500 = await handle(async () => { throw new Error('secret detail'); })(req('/x'), { params: Promise.resolve({}) });
    expect(r500.status).toBe(500);
    expect(await r500.json()).toEqual({ error: 'Internal server error', code: 'internal_error' });
  });
  it('unmapped statuses get a default code http_<status>', async () => {
    expect((await fail(418, 'teapot').json()).code).toBe('http_418');
  });
  it.todo('Arabic and English messages: the API returns English messages only today (no Arabic strings under lib/ or app/api). Add when the localisation task lands.');
});
