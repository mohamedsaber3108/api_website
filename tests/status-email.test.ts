import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as forgot from '../app/api/auth/forgot-password/route';
import * as status from '../app/api/v1/status/route';
import { getDb } from '../db';
import { accounts, incidents } from '../db/schema';
import { resetFlagCache } from '../lib/server/flags';
import { mailLang, renderMail } from '../lib/server/mail-templates';
import { makeUser, req, startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
let realDb: D1Database | undefined;
beforeAll(async () => { h = await startDb(); realDb = env.DB; });
afterAll(async () => { await h.dispose(); });
beforeEach(async () => {
  env.DB = realDb;
  await getDb().delete(incidents);
  resetFlagCache();
});
afterEach(() => {
  env.DB = realDb;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of ['INFERENCE_ENABLED', 'OPENROUTER_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM', 'PUBLIC_BASE_URL']) delete (env as Record<string, unknown>)[k];
});

const getStatus = async () => {
  const res = await status.GET();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads a JSON body of many shapes
  return { res, text: await res.clone().text(), body: (await res.json()) as Record<string, any> };
};
const DAY = 24 * 3600 * 1000;

describe('GET /api/v1/status', () => {
  it('returns the status shape with a short cache', async () => {
    const { res, body } = await getStatus();
    expect(res.status).toBe(200);
    expect(Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1])).toBeLessThanOrEqual(30);
    expect(body.status).toBe('operational');
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
    expect(body.checks).toEqual({ database: 'ok', inference: 'off', billing: 'not_configured', email: 'not_configured' });
    expect(Array.isArray(body.incidents)).toBe(true);
    expect(body.health.status).toBe('ok'); // older clients
  });

  it('shows switch and configuration state as words and never leaks values', async () => {
    env.INFERENCE_ENABLED = 'true';
    env.OPENROUTER_API_KEY = 'sk-or-secret-value-1';
    env.STRIPE_SECRET_KEY = 'sk_test_secret_value_2';
    env.STRIPE_WEBHOOK_SECRET = 'whsec_secret_value_3';
    env.RESEND_API_KEY = 're_secret_value_4';
    env.EMAIL_FROM = 'noreply@secret-host.example';
    const { body, text } = await getStatus();
    expect(body.checks).toEqual({ database: 'ok', inference: 'on', billing: 'configured', email: 'configured' });
    for (const secret of ['secret_value', 'secret-value', 'secret-host', 'whsec', 'sk-or', 'sk_test']) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/stack|at .*\.(ts|js):\d+/);
  });

  it('answers degraded, without error text, when the database is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DB = { prepare: () => { throw new Error('boom host=db.internal.example'); } } as unknown as D1Database;
    const { res, body, text } = await getStatus();
    expect(res.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.checks.database).toBe('down');
    expect(body.incidents).toEqual([]);
    expect(text).not.toContain('boom');
    expect(text).not.toContain('internal.example');
  });

  it('lists open and recently resolved incidents, not old resolved ones', async () => {
    const now = Date.now();
    const row = (id: string, title: string, o: { status?: string; severity?: string; createdAt: number; resolvedAt?: number | null }) =>
      getDb().insert(incidents).values({ id, title, body: 'details', status: o.status ?? 'investigating', severity: o.severity ?? 'minor', createdAt: o.createdAt, resolvedAt: o.resolvedAt ?? null });
    await row('i1', 'Open one', { createdAt: now - 3600_000 });
    await row('i2', 'Resolved recently', { status: 'resolved', createdAt: now - 2 * DAY, resolvedAt: now - DAY });
    await row('i3', 'Resolved long ago', { status: 'resolved', createdAt: now - 40 * DAY, resolvedAt: now - 39 * DAY });
    const { body } = await getStatus();
    const byTitle = Object.fromEntries((body.incidents as { title: string }[]).map(i => [i.title, i]));
    expect(Object.keys(byTitle).sort()).toEqual(['Open one', 'Resolved recently']);
    expect(byTitle['Open one']).toMatchObject({ open: true, status: 'investigating', severity: 'minor', resolvedAt: null });
    expect(byTitle['Resolved recently']).toMatchObject({ open: false, status: 'resolved' });
    expect(body.status).toBe('operational'); // minor incident only
  });

  it('is degraded while a major incident is open', async () => {
    await getDb().insert(incidents).values({ id: 'i9', title: 'Big', body: 'x', status: 'identified', severity: 'major', createdAt: Date.now() });
    const { body } = await getStatus();
    expect(body.status).toBe('degraded');
  });
});

describe('mail templates', () => {
  const link = 'https://wasl.example/reset-password?token=abc';

  it('Arabic mail is rtl with lang="ar", English is ltr with lang="en", and the text part is kept', () => {
    const ar = renderMail('reset_password', 'ar', { link });
    expect(ar.html).toContain('<html lang="ar" dir="rtl">');
    expect(ar.html).toContain(`href="${link}"`);
    expect(ar.text).toContain(link);
    expect(ar.subject).toMatch(/[\u0600-\u06FF]/);
    const en = renderMail('verify_email', 'en', { link, name: 'Sam' });
    expect(en.html).toContain('<html lang="en" dir="ltr">');
    expect(en.text).toContain('Hi Sam,');
    expect(en.text).toContain(link);
    expect(link.startsWith('https://')).toBe(true);
  });

  it('escapes every inserted value', () => {
    const evil = '<script>alert(1)</script>"\'&';
    const m = renderMail('verify_email', 'en', { link: 'https://wasl.example/x?a=1&b="2"', name: evil });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('a=1&amp;b=&quot;2&quot;');
    expect(m.text).toContain(evil); // text part is plain text
  });

  it('picks the language: saved preference, then Accept-Language, then Arabic', () => {
    const en = new Request('http://x', { headers: { 'accept-language': 'en-US,en;q=0.9' } });
    const fr = new Request('http://x', { headers: { 'accept-language': 'fr' } });
    expect(mailLang(JSON.stringify({ lang: 'en' }))).toBe('en');
    expect(mailLang(JSON.stringify({ lang: 'ar' }), en)).toBe('ar');
    expect(mailLang(null, en)).toBe('en');
    expect(mailLang(null, fr)).toBe('ar');
    expect(mailLang('not json')).toBe('ar');
    expect(mailLang(undefined)).toBe('ar');
  });
});

describe('forgot-password mail', () => {
  it('sends html and text in the saved language through the (stubbed) provider and no real mail', async () => {
    env.RESEND_API_KEY = 're_test_not_real';
    env.EMAIL_FROM = 'noreply@example.test';
    env.PUBLIC_BASE_URL = 'https://wasl.example';
    const fetchStub = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    const sent = async (lang: string) => {
      const u = await makeUser();
      await getDb().update(accounts).set({ preferences: JSON.stringify({ lang }) }).where(eq(accounts.userId, u.userId));
      const res = await forgot.POST(req('/api/auth/forgot-password', { method: 'POST', body: { email: u.email } }), { params: Promise.resolve({}) });
      expect(res.status).toBe(202);
      const call = fetchStub.mock.calls.at(-1) as unknown as [string, { body: string }];
      expect(call[0]).toBe('https://api.resend.com/emails');
      return JSON.parse(call[1].body) as { subject: string; text: string; html: string };
    };
    const en = await sent('en');
    expect(en.html).toContain('<html lang="en" dir="ltr">');
    expect(en.text).toContain('https://wasl.example/reset-password?token=');
    const ar = await sent('ar');
    expect(ar.html).toContain('<html lang="ar" dir="rtl">');
    expect(ar.text).toContain('https://wasl.example/reset-password?token=');
  });
});
