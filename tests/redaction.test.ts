import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { POST as register } from '../app/api/auth/register/route';
import { POST as login } from '../app/api/auth/login/route';
import { POST as forgot } from '../app/api/auth/forgot-password/route';
import { POST as resetPassword } from '../app/api/auth/reset-password/route';
import { POST as verifyEmail } from '../app/api/auth/verify-email/route';
import { POST as chat } from '../app/api/v1/chat/completions/route';
import { POST as tryPost } from '../app/api/v1/try/route';
import { createAuthToken } from '../lib/server/auth';
import { addLedgerEntry } from '../lib/server/ledger';
import { createApiKey } from '../lib/server/keys';
import { gatewayErrorResponse } from '../lib/server/gateway';
import { handle } from '../lib/server/http';
import { redact } from '../lib/server/redact';
import { makeUser, req, startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });

// Fake values only. Every one of them must be absent from everything written to the console.
const EMAIL = 'fake.person@leak-check.test';
const PASSWORD = 'fake-password-LEAK-1234';
const CALLER_KEY = 'sk-or-v1-FAKECALLERKEY0123456789abcdef';
const logs: string[] = [];
const ctx = { params: Promise.resolve({}) };

beforeEach(() => {
  logs.length = 0;
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logs.push(args.map(a => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a))).join(' ')); });
  }
  env.INFERENCE_ENABLED = 'true';
  env.OPENROUTER_API_KEY = 'sk-or-FAKE-SERVER-KEY-0123456789';
  env.SIGNUP_BONUS_USD = '5';
  // APP_ENV is left unset on purpose: production mode. The development-only e-mail preview prints addresses and links by design.
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const k of ['INFERENCE_ENABLED', 'OPENROUTER_API_KEY', 'SIGNUP_BONUS_USD']) delete (env as Record<string, unknown>)[k]; });

const expectClean = (secrets: string[]) => {
  const all = logs.join('\n');
  for (const s of secrets) expect(all, `console output contains ${s.slice(0, 12)}...`).not.toContain(s);
};

describe('console output never holds e-mails, tokens, passwords or API keys', () => {
  it('register, verify, login, forgot, reset (success paths)', async () => {
    let n = 0;
    const ip = () => ({ 'cf-connecting-ip': `192.0.2.${++n}` });
    const r = await register(req('/api/auth/register', { method: 'POST', headers: ip(), body: { email: EMAIL, password: PASSWORD, name: 'Fake Person', acceptTerms: true } }), ctx);
    expect(r.status).toBe(201);
    const { user } = (await r.json()) as { user: { id: string } };
    const verifyToken = await createAuthToken(user.id, 'verify_email', 3600_000);
    expect((await verifyEmail(req('/api/auth/verify-email', { method: 'POST', headers: ip(), body: { token: verifyToken } }), ctx)).status).toBe(200);
    expect((await login(req('/api/auth/login', { method: 'POST', headers: ip(), body: { email: EMAIL, password: PASSWORD } }), ctx)).status).toBe(200);
    expect((await login(req('/api/auth/login', { method: 'POST', headers: ip(), body: { email: EMAIL, password: 'wrong-' + PASSWORD } }), ctx)).status).toBe(401);
    expect((await forgot(req('/api/auth/forgot-password', { method: 'POST', headers: ip(), body: { email: EMAIL } }), ctx)).status).toBe(202);
    const resetToken = await createAuthToken(user.id, 'reset_password', 3600_000);
    expect((await resetPassword(req('/api/auth/reset-password', { method: 'POST', headers: ip(), body: { token: resetToken, password: PASSWORD + '-new' } }), ctx)).status).toBe(200);
    expectClean([EMAIL, PASSWORD, verifyToken, resetToken, 'leak-check.test']);
  });

  it('gateway: caller Wasl key, a provider failure and a metering failure', async () => {
    const u = await makeUser();
    await addLedgerEntry({ userId: u.userId, deltaMicroUsd: 10_000_000, type: 'topup', idempotencyKey: `fund:${u.userId}` });
    const { secret } = await createApiKey(u.userId, { name: 'k', scopes: ['chat'], expiresAt: null, rateLimitPerMin: 60 });
    // The provider answers 500 and its error text echoes the server key and an e-mail; neither may be logged.
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('openrouter.ai/api/v1/chat/completions')) return Response.json({ error: { message: `boom ${EMAIL} Bearer ${CALLER_KEY}` } }, { status: 500 });
      throw new Error('network disabled in tests');
    });
    const res = await chat(req('/api/v1/chat/completions', { method: 'POST', origin: false, headers: { authorization: `Bearer ${secret}` }, body: { model: 'minimax/minimax-m3.1-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 } }));
    expect(res.status).toBe(502);
    // An unexpected error whose text carries secrets goes through the gateway logger.
    gatewayErrorResponse(new Error(`unexpected ${EMAIL} Authorization: Bearer ${secret} ${CALLER_KEY}`));
    expectClean([secret, CALLER_KEY, EMAIL, 'sk-or-FAKE-SERVER-KEY']);
    expect(logs.some(l => l.includes('Gateway failure'))).toBe(true); // the failure itself is still logged
  });

  it('/api/v1/try: the caller\'s own OpenRouter key never appears, also when the provider call fails', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error(`socket closed for Bearer ${CALLER_KEY}`); });
    const res = await tryPost(new Request('http://localhost/api/v1/try', { method: 'POST', headers: { authorization: `Bearer ${CALLER_KEY}`, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.200' }, body: JSON.stringify({ model: 'openai/gpt-4o-mini', prompt: 'hello' }) }));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(CALLER_KEY);
    expectClean([CALLER_KEY]);
  });

  it('unexpected route error with SQL parameters (drizzle style) is logged without the values', async () => {
    const route = handle(async () => {
      throw new Error(`Failed query: insert into "accounts" ("email","password_hash") values (?, ?)\nparams: ${EMAIL},pbkdf2$600000$abcdef$0123456789abcdef0123456789abcdef0123456789abcdef`);
    });
    const res = await route(req('/x', { method: 'POST' }), ctx);
    expect(res.status).toBe(500);
    expectClean([EMAIL, 'pbkdf2$', '0123456789abcdef']);
    expect(logs.some(l => l.includes('Unhandled route error') && l.includes('Failed query'))).toBe(true);
  });
});

describe('redact()', () => {
  it.each([
    ['e-mail', `to ${EMAIL} failed`, EMAIL],
    ['bearer token', 'Authorization: Bearer abc.def-123', 'abc.def-123'],
    ['OpenRouter key', `key ${CALLER_KEY}`, CALLER_KEY],
    ['Wasl key', `key wasl_${'a1'.repeat(32)}`, 'a1a1a1a1'],
    ['64-hex token', `token ${'0f'.repeat(32)}`, '0f0f0f0f'],
    ['Stripe key', 'sk_live_51Abcdef123456', 'sk_live_51Abcdef123456'],
    ['SQL params', 'bad insert params: one,two,three', 'one,two,three'],
  ])('removes %s', (_name, input, secret) => {
    expect(redact(input)).not.toContain(secret);
  });
  it('keeps plain text', () => {
    expect(redact('webhook processing failed evt_123')).toBe('webhook processing failed evt_123');
  });
});
