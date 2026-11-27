import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { invoices, payments } from '../db/schema';
import { paymentProvider } from '../lib/server/config';
import { getPaymentProvider } from '../lib/server/payments';
import { getBalanceMicroUsd } from '../lib/server/ledger';
import { POST as checkout } from '../app/api/billing/checkout/route';
import { POST as stubPay } from '../app/api/billing/stub/pay/route';
import { POST as webhook } from '../app/api/billing/webhook/route';
import { makeUser, ORIGIN, req, startDb } from './helpers/db';

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
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'PAYMENT_PROVIDER', 'APP_ENV', 'INFERENCE_ENABLED', 'OPENROUTER_API_KEY'] as const) delete env[k];
});

const startCheckout = (u: U, amountUsd = 25) => checkout(req('/api/billing/checkout', { method: 'POST', cookie: u.cookie, body: { amountUsd } }), ctx);
const pay = (u: U | null, body: unknown) => stubPay(req('/api/billing/stub/pay', { method: 'POST', cookie: u?.cookie, body }), ctx);
function stubDev() {
  env.PAYMENT_PROVIDER = 'stub';
  env.APP_ENV = 'development';
}

describe('provider selection', () => {
  it('unset and no keys: billing off', () => {
    expect(paymentProvider()).toBeNull();
    expect(getPaymentProvider()).toBeNull();
  });
  it('Stripe when both keys are set (default, and when PAYMENT_PROVIDER=stripe)', () => {
    env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
    expect(paymentProvider()).toBeNull(); // one key is not enough
    env.STRIPE_WEBHOOK_SECRET = 'whsec_test_not_a_real_secret';
    expect(paymentProvider()).toBe('stripe');
    expect(getPaymentProvider()?.id).toBe('stripe');
    env.PAYMENT_PROVIDER = 'stripe';
    expect(paymentProvider()).toBe('stripe');
  });
  it('stub only in development, and it wins over Stripe keys', () => {
    env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
    env.STRIPE_WEBHOOK_SECRET = 'whsec_test_not_a_real_secret';
    env.PAYMENT_PROVIDER = 'stub';
    expect(paymentProvider()).toBeNull(); // APP_ENV is not development: fail safe
    env.APP_ENV = 'development';
    expect(paymentProvider()).toBe('stub');
    expect(getPaymentProvider()?.id).toBe('stub');
  });
  it('an unknown value turns billing off', () => {
    env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
    env.STRIPE_WEBHOOK_SECRET = 'whsec_test_not_a_real_secret';
    env.PAYMENT_PROVIDER = 'paypal';
    expect(paymentProvider()).toBeNull();
  });
});

describe('stub checkout and pay', () => {
  it('checkout returns a local URL, names the currency, and makes no network call', async () => {
    stubDev();
    const u = await makeUser();
    const res = await startCheckout(u, 25);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ currency: 'usd', amountMinor: 2500, provider: 'stub' });
    expect(body.url.startsWith(`${ORIGIN}/billing/stub-checkout?session=`)).toBe(true);
    const [p] = await getDb().select().from(payments).where(eq(payments.id, body.paymentId));
    expect(p).toMatchObject({ provider: 'stub', status: 'pending', currency: 'usd', amountMinor: 2500, creditMicroUsd: 25_000_000, userId: u.userId });
    expect(body.url).toContain(encodeURIComponent(p.providerSessionId!));
    expect(await getBalanceMicroUsd(u.userId)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('pay credits once: repeated and parallel calls give one credit and one invoice', async () => {
    stubDev();
    const u = await makeUser();
    const { paymentId } = await (await startCheckout(u, 10)).json();
    const [p] = await getDb().select().from(payments).where(eq(payments.id, paymentId));
    const sessionId = p.providerSessionId!;
    const results = await Promise.all(Array.from({ length: 5 }, () => pay(u, { sessionId })));
    expect(results.map(r => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect((await pay(u, { sessionId })).status).toBe(200);
    expect(await getBalanceMicroUsd(u.userId)).toBe(10_000_000);
    const [after] = await getDb().select().from(payments).where(eq(payments.id, paymentId));
    expect(after.status).toBe('paid');
    expect(await getDb().select().from(invoices).where(eq(invoices.paymentId, paymentId))).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('another user cannot pay my session; unknown session is 404; bad body is 400; no login is 401', async () => {
    stubDev();
    const me = await makeUser();
    const other = await makeUser();
    const { paymentId } = await (await startCheckout(me, 5)).json();
    const [p] = await getDb().select().from(payments).where(eq(payments.id, paymentId));
    expect((await pay(other, { sessionId: p.providerSessionId })).status).toBe(404);
    expect((await pay(me, { sessionId: 'stub_cs_unknown' })).status).toBe(404);
    expect((await pay(me, {})).status).toBe(400);
    expect((await pay(null, { sessionId: p.providerSessionId })).status).toBe(401);
    expect(await getBalanceMicroUsd(me.userId)).toBe(0);
    expect(await getBalanceMicroUsd(other.userId)).toBe(0);
  });
  it('a failed or expired stub payment cannot be paid', async () => {
    stubDev();
    const u = await makeUser();
    const { paymentId } = await (await startCheckout(u, 5)).json();
    await getDb().update(payments).set({ status: 'expired' }).where(eq(payments.id, paymentId));
    const [p] = await getDb().select().from(payments).where(eq(payments.id, paymentId));
    const res = await pay(u, { sessionId: p.providerSessionId });
    expect(res.status).toBe(409);
    expect(await getBalanceMicroUsd(u.userId)).toBe(0);
  });
  it('the stub pay route is refused in production (APP_ENV not development) and credits nothing', async () => {
    stubDev();
    const u = await makeUser();
    const { paymentId } = await (await startCheckout(u, 10)).json();
    const [p] = await getDb().select().from(payments).where(eq(payments.id, paymentId));
    delete env.APP_ENV; // now production
    const res = await pay(u, { sessionId: p.providerSessionId });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('stub_payments_disabled');
    env.APP_ENV = 'production';
    expect((await pay(u, { sessionId: p.providerSessionId })).status).toBe(403);
    expect(await getBalanceMicroUsd(u.userId)).toBe(0);
    const [after] = await getDb().select().from(payments).where(eq(payments.id, paymentId));
    expect(after.status).toBe('pending');
  });
  it('the stub pay route is refused when the provider is not the stub', async () => {
    env.APP_ENV = 'development';
    env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
    env.STRIPE_WEBHOOK_SECRET = 'whsec_test_not_a_real_secret';
    const res = await pay(await makeUser(), { sessionId: 'x' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('stub_payments_disabled');
  });
  it('checkout with the stub in production is billing_not_configured, no payment row', async () => {
    env.PAYMENT_PROVIDER = 'stub'; // APP_ENV unset = production
    const u = await makeUser();
    const res = await startCheckout(u, 10);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('billing_not_configured');
    expect(await getDb().select().from(payments).where(eq(payments.userId, u.userId))).toEqual([]);
  });
  it('the webhook route answers 404 while the stub is active', async () => {
    stubDev();
    const res = await webhook(req('/api/billing/webhook', { method: 'POST', origin: false, body: '{}' }), ctx);
    expect(res.status).toBe(404);
  });
});
