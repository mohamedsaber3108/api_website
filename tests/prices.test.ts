import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { auditLogs, invoices, payments, pricePoints } from '../db/schema';
import { getBalanceMicroUsd } from '../lib/server/ledger';
import { stubProvider } from '../lib/server/payments/stub';
import { POST as stubPay } from '../app/api/billing/stub/pay/route';
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

const payNow = (u: U, sessionId: string) => stubPay(req('/api/billing/stub/pay', { method: 'POST', cookie: u.cookie, body: { sessionId } }), ctx);
const rowsFor = (packageId: string, currency: string) => getDb().select().from(pricePoints).where(eq(pricePoints.packageId, packageId)).then(r => r.filter(x => x.currency === currency));

describe('non-USD money path and admin guards', () => {
  it('EGP price: checkout, stub pay, then payment, invoice and ledger use the stored amount, currency and credits', async () => {
    const sa = await makeUser({ role: 'super_admin' });
    expect((await put(sa, { ...valid, packageId: 'credits-10', credits: 10 * MICRO })).status).toBe(200);
    const u = await makeUser();
    const body = await (await buy(u, { packageId: 'credits-10', currency: 'EGP' })).json();
    const [p] = await getDb().select().from(payments).where(eq(payments.id, body.paymentId));
    expect((await payNow(u, p.providerSessionId!)).status).toBe(200);
    const [paid] = await getDb().select().from(payments).where(eq(payments.id, body.paymentId));
    expect(paid.status).toBe('paid');
    const [inv] = await getDb().select().from(invoices).where(eq(invoices.paymentId, body.paymentId));
    expect(inv).toMatchObject({ amountMinor: 123456, currency: 'egp' });
    expect(await getBalanceMicroUsd(u.userId)).toBe(10 * MICRO);
  });
  it('PUT refuses a request from another origin, and changes nothing', async () => {
    const sa = await makeUser({ role: 'super_admin' });
    const res = await pricesPut(req('/api/admin/prices', { method: 'PUT', cookie: sa.cookie, body: { ...valid, packageId: 'credits-77' }, origin: false }), ctx);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await rowsFor('credits-77', 'EGP')).toEqual([]);
  });
  it('PUT needs MFA: none is refused, and an old one (20 minutes) is refused too', async () => {
    const none = await makeUser({ role: 'super_admin', mfaVerifiedAt: null });
    const noneRes = await put(none, { ...valid, packageId: 'credits-78' });
    expect(noneRes.status).toBe(403);
    expect((await noneRes.json()).code).toBe('mfa_required');
    const stale = await makeUser({ role: 'super_admin', mfaVerifiedAt: Date.now() - 20 * 60_000 });
    const staleRes = await put(stale, { ...valid, packageId: 'credits-78' });
    expect(staleRes.status).toBe(403);
    expect((await staleRes.json()).code).toBe('mfa_recent_required');
    expect(await rowsFor('credits-78', 'EGP')).toEqual([]);
  });
  it('checkout answers currency_not_supported when the provider cannot charge that currency, and writes no payment', async () => {
    const sa = await makeUser({ role: 'super_admin' });
    expect((await put(sa, { ...valid, packageId: 'credits-79', credits: 79 * MICRO })).status).toBe(200);
    const spy = vi.spyOn(stubProvider, 'supportsCurrency').mockImplementation(c => c.toUpperCase() === 'USD');
    try {
      const u = await makeUser();
      const res = await buy(u, { packageId: 'credits-79', currency: 'EGP' });
      expect(res.status).toBe(400);
      const j = await res.json();
      expect(j.code).toBe('currency_not_supported');
      expect(j.message_ar).toBeTruthy();
      expect(await getDb().select().from(payments).where(eq(payments.userId, u.userId))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
  it('sanity checks: amount under 1 is refused; a move over 50% in amount or credits needs confirm: true', async () => {
    const sa = await makeUser({ role: 'super_admin' });
    const base = { ...valid, packageId: 'credits-80', currency: 'SAR', amountMinor: 1000, credits: 10 * MICRO };
    expect((await put(sa, base)).status).toBe(200);
    const zero = await put(sa, { ...base, amountMinor: 0 });
    expect(zero.status).toBe(400);
    const zj = await zero.json();
    expect(zj.code).toBe('amount_too_small');
    expect(zj.message_ar).toBeTruthy();
    const big = await put(sa, { ...base, amountMinor: 2000 });
    expect(big.status).toBe(400);
    const bj = await big.json();
    expect(bj.code).toBe('change_needs_confirm');
    expect(bj.message_ar).toBeTruthy();
    expect((await put(sa, { ...base, credits: 100 * MICRO })).status).toBe(400);
    expect((await rowsFor('credits-80', 'SAR'))[0]).toMatchObject({ amountMinor: 1000, credits: 10 * MICRO });
    expect((await put(sa, { ...base, amountMinor: 1400 })).status).toBe(200); // 40%: no confirm needed
    expect((await put(sa, { ...base, amountMinor: 5000, confirm: true })).status).toBe(200);
    expect((await rowsFor('credits-80', 'SAR'))[0].amountMinor).toBe(5000);
  });
});
