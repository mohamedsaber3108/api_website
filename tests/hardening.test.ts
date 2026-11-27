import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { creditHolds, payments, paymentWebhookEvents } from '../db/schema';
import { hmacSha256Hex } from '../lib/server/crypto';
import { newChatContext, parseChatRequest, runChat } from '../lib/server/gateway';
import { addLedgerEntry, getAvailableMicroUsd, getBalanceMicroUsd, HOLD_KEEP_MS, purgeOldHolds } from '../lib/server/ledger';
import { maybePurge, rateLimit, resetPurgeGate } from '../lib/server/ratelimit';
import { redact } from '../lib/server/redact';
import { POST as webhook } from '../app/api/billing/webhook/route';
import { makeUser, req, startDb } from './helpers/db';

// HARDEN-1: FU-1 rate-limit purge, FU-2 webhook error redaction, FU-3 hold purge, FU-6 reconcile logs.
const SECRET = 'whsec_test_not_a_real_secret';
const MODEL = 'minimax/minimax-m3.1-flash';
const HOLD = 75; // worst case of the request below, see reservation.test.ts
const DAY = 24 * 3600 * 1000;
let h: Awaited<ReturnType<typeof startDb>>;
const fetchSpy = vi.fn();
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });
beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
  env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  env.STRIPE_WEBHOOK_SECRET = SECRET;
  env.INFERENCE_ENABLED = 'true';
  env.OPENROUTER_API_KEY = 'sk-or-not-a-real-key';
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'INFERENCE_ENABLED', 'OPENROUTER_API_KEY']) delete (env as Record<string, unknown>)[k];
});

/** Replaces env.DB with a wrapper whose `prepare` / `batch` can be overridden (spyOn does not stick on the platform proxy). Restored after each test. */
const realDb = () => (env as unknown as { DB: D1Database }).DB;
let savedDb: D1Database | null = null;
function wrapDb(over: { prepare?: (real: D1Database, sql: string) => unknown; batch?: (real: D1Database, stmts: D1PreparedStatement[]) => unknown }) {
  const real = realDb();
  savedDb ??= real;
  (env as unknown as { DB: D1Database }).DB = new Proxy(real, {
    get: (t, p) => {
      if (p === 'prepare' && over.prepare) return (sql: string) => over.prepare!(real, sql);
      if (p === 'batch' && over.batch) return (stmts: D1PreparedStatement[]) => over.batch!(real, stmts);
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}
afterEach(() => { if (savedDb) (env as unknown as { DB: D1Database }).DB = savedDb; savedDb = null; });

const bucketKeys = async () => (await realDb().prepare('SELECT key FROM rate_limit_buckets').all<{ key: string }>()).results.map(r => r.key);

describe('FU-1: rate-limit rows are purged', () => {
  it('removes buckets older than 24 h, keeps fresh ones', async () => {
    const now = Date.now();
    await realDb().prepare('INSERT INTO rate_limit_buckets (key, window_start, count) VALUES (?1, ?2, 1), (?3, ?4, 1)').bind('old-k', now - 25 * 3600_000, 'fresh-k', now - 3600_000).run();
    resetPurgeGate();
    await maybePurge();
    const keys = await bucketKeys();
    expect(keys).not.toContain('old-k');
    expect(keys).toContain('fresh-k');
  });
  it('rateLimit() triggers the purge, and only once an hour', async () => {
    const now = Date.now();
    resetPurgeGate();
    await realDb().prepare('INSERT INTO rate_limit_buckets (key, window_start, count) VALUES (?1, ?2, 1)').bind('old-a', now - 25 * 3600_000).run();
    await rateLimit('hard-1', 5, 60);
    expect(await bucketKeys()).not.toContain('old-a');
    await realDb().prepare('INSERT INTO rate_limit_buckets (key, window_start, count) VALUES (?1, ?2, 1)').bind('old-b', now - 25 * 3600_000).run();
    await rateLimit('hard-1', 5, 60);
    expect(await bucketKeys()).toContain('old-b'); // gate closed for an hour
  });
  it('a failing purge never fails the request and logs without secrets', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    resetPurgeGate();
    wrapDb({ prepare: (real, sql) => { if (sql.startsWith('DELETE FROM')) throw new Error('boom sk_live_abcdef123456 for a@b.com'); return real.prepare(sql); } });
    await expect(rateLimit('hard-2', 5, 60)).resolves.toBeUndefined();
    const logged = err.mock.calls.flat().join(' ');
    expect(logged).toContain('purge');
    expect(logged).not.toContain('sk_live_abcdef123456');
    expect(logged).not.toContain('a@b.com');
  });
});

describe('FU-2: webhook errors are stored redacted', () => {
  it('redact hides e-mail, bearer, sk_live_, whsec_ and long hex', () => {
    const out = redact('x a@b.com Bearer abc.def sk_live_abcdef123 whsec_Zz9Zz9 ' + 'a'.repeat(40) + ' keep me');
    for (const s of ['a@b.com', 'abc.def', 'sk_live_abcdef123', 'whsec_Zz9Zz9', 'a'.repeat(40)]) expect(out).not.toContain(s);
    expect(out).toContain('keep me');
  });
  it('a failure containing secrets is stored redacted in payment_webhook_events.error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const u = await makeUser();
    const id = `pay_h_${u.userId}`;
    await getDb().insert(payments).values({ id, userId: u.userId, provider: 'stripe', amountMinor: 1000, currency: 'usd', creditMicroUsd: 10_000_000, status: 'pending', createdAt: Date.now() });
    const ev = { id: `evt_h_${id}`, type: 'checkout.session.completed', data: { object: { id: 'cs_h', client_reference_id: id, payment_status: 'paid', payment_intent: 'pi_h' } } };
    const raw = JSON.stringify(ev);
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${await hmacSha256Hex(SECRET, `${t}.${raw}`)}`;
    wrapDb({ batch: () => Promise.reject(new Error(`db down for ${u.email} using sk_live_abcdef123456 and whsec_AbCd1234`)) });
    const res = await webhook(req('/api/billing/webhook', { method: 'POST', origin: false, body: raw, headers: { 'stripe-signature': sig } }), { params: Promise.resolve({}) });
    expect(res.status).toBe(500);
    const [row] = await getDb().select().from(paymentWebhookEvents).where(eq(paymentWebhookEvents.id, ev.id));
    expect(row.error).toContain('db down');
    expect(row.error).not.toContain(u.email);
    expect(row.error).not.toContain('sk_live_abcdef123456');
    expect(row.error).not.toContain('whsec_AbCd1234');
  });
});

describe('FU-3: old settled and released holds are purged', () => {
  it('removes settled and released rows older than 30 days; open and recent rows stay; balances unchanged', async () => {
    const u = await makeUser();
    await addLedgerEntry({ userId: u.userId, deltaMicroUsd: 1000, type: 'topup', idempotencyKey: `fund:${u.userId}` });
    const now = Date.now();
    const old = now - HOLD_KEEP_MS - DAY;
    const mk = (n: string, status: string, createdAt: number, expiresAt: number) => ({ id: `${n}-${u.userId}`, userId: u.userId, requestId: `${n}-${u.userId}`, amountMicroUsd: 100, status, createdAt, expiresAt });
    await getDb().insert(creditHolds).values([
      mk('old-settled', 'settled', old, old + 600_000),
      mk('old-released', 'released', old, old + 600_000),
      mk('old-open-expired', 'open', old, old + 600_000),
      mk('open-live', 'open', now, now + 600_000),
      mk('recent-settled', 'settled', now - DAY, now - DAY + 600_000),
    ]);
    const balance = await getBalanceMicroUsd(u.userId);
    const available = await getAvailableMicroUsd(u.userId);
    await purgeOldHolds();
    const left = (await getDb().select().from(creditHolds).where(eq(creditHolds.userId, u.userId))).map(r => r.id.replace(`-${u.userId}`, '')).sort();
    expect(left).toEqual(['old-open-expired', 'open-live', 'recent-settled']);
    expect(await getBalanceMicroUsd(u.userId)).toBe(balance);
    expect(await getAvailableMicroUsd(u.userId)).toBe(available);
  });
});

describe('FU-6: reconcile logs', () => {
  const chatOk = (cost: number) => async (url: string) => {
    if (!String(url).startsWith('https://openrouter.ai/api/v1/chat/completions')) throw new Error('no network');
    return Response.json({ id: 'g', choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 12, completion_tokens: 2, cost } });
  };
  const fund = async () => {
    const u = await makeUser();
    await addLedgerEntry({ userId: u.userId, deltaMicroUsd: HOLD, type: 'topup', idempotencyKey: `fund:${u.userId}` });
    return u;
  };
  const request = { model: MODEL, messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 };

  it('logs the request id when a charge is capped at the hold', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const u = await fund();
    fetchSpy.mockImplementation(chatOk(5));
    const ctx = newChatContext(u.userId, null, 'api');
    await runChat(ctx, parseChatRequest(request));
    const line = err.mock.calls.map(c => c.join(' ')).find(l => l.includes('charge capped at hold'));
    expect(line).toContain(ctx.requestId);
    expect(line).not.toContain(u.email);
    expect(line).not.toContain('sk-or-not-a-real-key');
  });
  it('logs the request id when the settle batch fails and the hold stays open', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const u = await fund();
    fetchSpy.mockImplementation(chatOk(0.00001));
    let calls = 0;
    wrapDb({ batch: (real, stmts) => (++calls === 1 ? real.batch(stmts) : Promise.reject(new Error(`settle failed for ${u.email}`))) }); // call 1 is the reservation
    const ctx = newChatContext(u.userId, null, 'api');
    await runChat(ctx, parseChatRequest(request));
    const lines = err.mock.calls.map(c => c.join(' '));
    const line = lines.find(l => l.includes('hold left open'));
    expect(line).toContain(ctx.requestId);
    expect(lines.join(' ')).not.toContain(u.email);
    const [hold] = await getDb().select().from(creditHolds).where(eq(creditHolds.requestId, ctx.requestId));
    expect(hold.status).toBe('open');
  });
});
