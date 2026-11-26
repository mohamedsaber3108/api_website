import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET as catalogGet } from '../app/api/catalog/route';
import { GET as fxGet } from '../app/api/fx/route';
import { GET as modelsGet } from '../app/api/v1/models/route';
import { GET as modelGet } from '../app/api/v1/models/[...slug]/route';
import { GET as estimateGet } from '../app/api/v1/pricing/estimate/route';
import { POST as tryPost } from '../app/api/v1/try/route';
import { limitMessage } from '../lib/server/ratelimit';
import { startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });
afterEach(() => vi.unstubAllGlobals());

// Every call comes from its own fake IP so the fixed-window buckets of the tests never mix.
let n = 0;
const ip = () => `203.0.113.${++n}`;
const get = (path: string, addr: string) => new Request(`http://localhost${path}`, { headers: { 'cf-connecting-ip': addr } });

/** Calls `fn` `limit` times (all must pass), then once more (must be the 429). */
async function expectLimit(limit: number, fn: () => Promise<Response>, passes: (r: Response) => boolean = r => r.status !== 429) {
  for (let i = 0; i < limit; i++) expect(passes(await fn()), `call ${i + 1} of ${limit}`).toBe(true);
  const res = await fn();
  expect(res.status).toBe(429);
  const wait = Number(res.headers.get('retry-after'));
  expect(Number.isInteger(wait) && wait >= 1).toBe(true);
  const body = (await res.json()) as { error: string; code: string; retry_after: number };
  expect(body.code).toBe('rate_limited');
  expect(body.retry_after).toBe(wait);
  expect(body.error).toBe(limitMessage(wait));
  expect(body.error).toMatch(/Please wait \d+ seconds/);
  expect(body.error).toMatch(/[\u0600-\u06FF]/); // Arabic text is present
  expect(body.error).toContain(`${wait} ثانية`);
  return res;
}

describe('public per-IP limits: 429 + Retry-After + Arabic and English message with the wait time', () => {
  it('/api/catalog: 120 per minute', async () => {
    const a = ip();
    await expectLimit(120, async () => catalogGet(get('/api/catalog', a)));
  });
  it('/api/fx: 60 per minute', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('network disabled in tests'); });
    const a = ip();
    await expectLimit(60, async () => fxGet(get('/api/fx', a)));
  });
  it('/api/v1/models: 60 per minute, CORS header kept on the 429', async () => {
    const a = ip();
    const res = await expectLimit(60, async () => modelsGet(get('/api/v1/models', a)));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
  it('/api/v1/models/<id>: shares the models bucket of the same IP', async () => {
    const a = ip();
    await expectLimit(60, async () => modelsGet(get('/api/v1/models', a)));
    const res = await modelGet(get('/api/v1/models/x/y', a), { params: Promise.resolve({ slug: ['x', 'y'] }) });
    expect(res.status).toBe(429);
  });
  it('/api/v1/pricing/estimate: 60 per minute', async () => {
    const a = ip();
    // Bad parameters answer 400 and still count: the limit sits in front of validation.
    await expectLimit(60, async () => estimateGet(get('/api/v1/pricing/estimate', a)), r => r.status === 400);
  });
  it('/api/v1/try: 5 per minute per IP, counted before the key check', async () => {
    const a = ip();
    const call = async () => tryPost(new Request('http://localhost/api/v1/try', { method: 'POST', headers: { 'cf-connecting-ip': a, 'content-type': 'application/json' }, body: '{}' }));
    await expectLimit(5, call, r => r.status === 401);
  });
  it('/api/v1/try: 40 per hour per IP even when the minute window is respected', async () => {
    const a = ip();
    const { getDb } = await import('../db');
    const { rateLimitBuckets } = await import('../db/schema');
    // Put the hourly bucket at its cap, as if 40 calls had been made over the last hour.
    await getDb().insert(rateLimitBuckets).values({ key: `pub:try-hour:ip:${a}`, windowStart: Date.now(), count: 40 });
    const res = await tryPost(new Request('http://localhost/api/v1/try', { method: 'POST', headers: { 'cf-connecting-ip': a }, body: '{}' }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(60);
  });
  it('a different IP is not limited by someone else', async () => {
    const a = ip();
    const b = ip();
    await expectLimit(5, async () => tryPost(new Request('http://localhost/api/v1/try', { method: 'POST', headers: { 'cf-connecting-ip': a }, body: '{}' })), r => r.status === 401);
    const res = await tryPost(new Request('http://localhost/api/v1/try', { method: 'POST', headers: { 'cf-connecting-ip': b }, body: '{}' }));
    expect(res.status).toBe(401);
  });
});
