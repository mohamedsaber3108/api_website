import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { auditLogs, payments, pricePoints } from '../db/schema';
import { CREDIT_PACKAGES, MICRO } from '../lib/server/config';
import { defaultPricePoints, listActivePricePoints } from '../lib/server/prices';
import { GET as billingGet } from '../app/api/billing/route';
import { POST as checkout } from '../app/api/billing/checkout/route';
import { GET as pricesGet, PUT as pricesPut } from '../app/api/admin/prices/route';
import { makeUser, req, startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
const fetchSpy = vi.fn();
const ctx = { params: Promise.resolve({}) };
type U = { userId: string; cookie: string };

beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });
beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
  env.INFERENCE_ENABLED = 'true';
  env.OPENROUTER_API_KEY = 'or_test_not_a_real_key';
  env.PAYMENT_PROVIDER = 'stub';
  env.APP_ENV = 'development';
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ['PAYMENT_PROVIDER', 'APP_ENV', 'INFERENCE_ENABLED', 'OPENROUTER_API_KEY'] as const) delete env[k];
});

const buy = (u: U, body: unknown) => checkout(req('/api/billing/checkout', { method: 'POST', cookie: u.cookie, body }), ctx);
const put = (u: U | null, body: unknown) => pricesPut(req('/api/admin/prices', { method: 'PUT', cookie: u?.cookie, body }), ctx);
const valid = { packageId: 'credits-25', currency: 'EGP', amountMinor: 123456, credits: 25 * MICRO, active: true, reason: 'owner set price' };

describe('seed', () => {
  it('migration rows equal the code defaults, USD only', async () => {
    const rows = await getDb().select().from(pricePoints);
    expect(rows.map(r => ({ packageId: r.packageId, currency: r.currency, amountMinor: r.amountMinor, credits: r.credits, active: r.active === 1 })).sort((a, b) => a.credits - b.credits))
      .toEqual(CREDIT_PACKAGES.map(n => ({ packageId: `credits-${n}`, currency: 'USD', amountMinor: n * 100, credits: n * MICRO, active: true })));
    expect(await listActivePricePoints()).toEqual(defaultPricePoints());
    expect(rows.every(r => r.currency === 'USD')).toBe(true);
  });
});

describe('checkout', () => {
  it('USD via the stub records the stored currency and amount; currency defaults to USD', async () => {
    const u = await makeUser();
    const res = await buy(u, { packageId: 'credits-25', currency: 'USD' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ currency: 'usd', amountMinor: 2500, provider: 'stub' });
    const [p] = await getDb().select().from(payments).where(eq(payments.id, body.paymentId));
    expect(p).toMatchObject({ currency: 'usd', amountMinor: 2500, creditMicroUsd: 25 * MICRO });
    const again = await (await buy(u, { packageId: 'credits-10' })).json();
    expect(again).toMatchObject({ currency: 'usd', amountMinor: 1000 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('the old amountUsd body still works for a listed amount and fails for an unlisted one', async () => {
    const u = await makeUser();
    expect((await buy(u, { amountUsd: 5 })).status).toBe(201);
    expect((await buy(u, { amountUsd: 7 })).status).toBe(400);
  });
  it('refuses an unknown currency or package with a bilingual error and writes no payment', async () => {
    const u = await makeUser();
    for (const body of [{ packageId: 'credits-25', currency: 'EGP' }, { packageId: 'credits-25', currency: 'EUR' }, { packageId: 'nope-1', currency: 'USD' }, {}]) {
      const res = await buy(u, body);
      expect(res.status).toBe(400);
    }
    const res = await buy(u, { packageId: 'credits-25', currency: 'EGP' });
    const j = await res.json();
    expect(j.code).toBe('price_not_available');
    expect(j.message_ar).toBeTruthy();
    expect(await getDb().select().from(payments).where(eq(payments.userId, u.userId))).toEqual([]);
  });
});

describe('admin upsert', () => {
  it('super_admin adds an EGP price: it is audited, listed, and charged exactly as stored', async () => {
    const sa = await makeUser({ role: 'super_admin' });
    expect((await put(sa, valid)).status).toBe(200);
    const audits = await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'admin.price_point'));
    expect(audits.some(a => a.actorId === sa.userId && a.targetId === 'credits-25:EGP')).toBe(true);
    const u = await makeUser();
    const list = await (await billingGet(req('/api/billing', { cookie: u.cookie }), ctx)).json();
    const pkg = list.packages.find((p: { id: string }) => p.id === 'credits-25');
    expect(pkg.prices).toEqual(expect.arrayContaining([{ currency: 'USD', amountMinor: 2500, credits: 25 * MICRO }, { currency: 'EGP', amountMinor: 123456, credits: 25 * MICRO }]));
    const res = await buy(u, { packageId: 'credits-25', currency: 'egp' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ currency: 'egp', amountMinor: 123456 });
    // Change it, then switch it off: checkout refuses the inactive pair.
    expect((await put(sa, { ...valid, amountMinor: 150000 })).status).toBe(200);
    expect((await (await buy(u, { packageId: 'credits-25', currency: 'EGP' })).json()).amountMinor).toBe(150000);
    expect((await put(sa, { ...valid, active: false })).status).toBe(200);
    expect((await buy(u, { packageId: 'credits-25', currency: 'EGP' })).status).toBe(400);
    const rows = await getDb().select().from(pricePoints).where(eq(pricePoints.currency, 'EGP'));
    expect(rows).toHaveLength(1);
    expect(rows[0].updatedBy).toBe(sa.userId);
  });
  it('admin (not super_admin), customer and anonymous are refused; nothing changes', async () => {
    const admin = await makeUser({ role: 'admin' });
    const cust = await makeUser();
    expect((await put(admin, { ...valid, currency: 'SAR' })).status).toBe(403);
    expect((await put(cust, { ...valid, currency: 'SAR' })).status).toBe(403);
    expect((await put(null, { ...valid, currency: 'SAR' })).status).toBe(401);
    expect((await pricesGet(req('/api/admin/prices', { cookie: admin.cookie }), ctx)).status).toBe(403);
    expect(await getDb().select().from(pricePoints).where(eq(pricePoints.currency, 'SAR'))).toEqual([]);
  });
  it('validates currency, amount, credits and reason', async () => {
    const sa = await makeUser({ role: 'super_admin' });
    const bad = [
      { currency: 'EUR' }, { currency: 'egp' }, { amountMinor: 0 }, { amountMinor: -5 }, { amountMinor: 10.5 }, { amountMinor: 100_000_001 },
      { credits: 0 }, { credits: 1.5 }, { credits: 10_001 * MICRO }, { packageId: 'Bad Id' }, { reason: 'x' },
    ];
    for (const b of bad) expect((await put(sa, { ...valid, packageId: 'credits-50', ...b })).status).toBe(400);
    expect(await getDb().select().from(pricePoints).where(eq(pricePoints.packageId, 'credits-50'))).toHaveLength(1);
  });
});
