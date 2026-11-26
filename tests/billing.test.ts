import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { payments, paymentWebhookEvents, invoices } from '../db/schema';
import { hmacSha256Hex } from '../lib/server/crypto';
import { getBalanceMicroUsd } from '../lib/server/ledger';
import { verifyStripeSignature } from '../lib/server/stripe';
import { POST as webhook } from '../app/api/billing/webhook/route';
import { POST as checkout } from '../app/api/billing/checkout/route';
import { makeUser, req, startDb } from './helpers/db';

const SECRET = 'whsec_test_not_a_real_secret';
let h: Awaited<ReturnType<typeof startDb>>;
const fetchSpy = vi.fn();
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });
beforeEach(() => {
  fetchSpy.mockReset();
  // No real network: any fetch is recorded and answered locally.
  vi.stubGlobal('fetch', fetchSpy);
  env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  env.STRIPE_WEBHOOK_SECRET = SECRET;
});
afterEach(() => { vi.unstubAllGlobals(); delete env.STRIPE_SECRET_KEY; delete env.STRIPE_WEBHOOK_SECRET; delete env.INFERENCE_ENABLED; });

async function sign(raw: string, t = Math.floor(Date.now() / 1000), secret = SECRET) {
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${raw}`)}`;
}
async function post(event: object, header?: string | null) {
  const raw = JSON.stringify(event);
  const headers: Record<string, string> = {};
  const sig = header === undefined ? await sign(raw) : header;
  if (sig) headers['stripe-signature'] = sig;
  const r = req('/api/billing/webhook', { method: 'POST', origin: false, body: raw, headers });
  return webhook(r, { params: Promise.resolve({}) });
}
let n = 0;
async function pendingPayment(amountMinor = 1000, creditMicroUsd = 10_000_000) {
  const u = await makeUser();
  const id = `pay_${++n}_${u.userId}`;
  await getDb().insert(payments).values({ id, userId: u.userId, provider: 'stripe', amountMinor, currency: 'usd', creditMicroUsd, status: 'pending', createdAt: Date.now() });
  return { u, id };
}
const completed = (eventId: string, paymentId: string, intent = 'pi_' + paymentId) => ({ id: eventId, type: 'checkout.session.completed', data: { object: { id: 'cs_' + paymentId, client_reference_id: paymentId, payment_status: 'paid', payment_intent: intent } } });
const refunded = (eventId: string, intent: string, amountRefunded: number) => ({ id: eventId, type: 'charge.refunded', data: { object: { payment_intent: intent, amount_refunded: amountRefunded } } });

describe('Stripe signature', () => {
  const body = '{"id":"evt_1"}';
  it('accepts a good signature', async () => { expect(await verifyStripeSignature(body, await sign(body), SECRET)).toBe(true); });
  it('rejects a bad signature, wrong secret, tampered body and missing header', async () => {
    expect(await verifyStripeSignature(body, `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`, SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, await sign(body, undefined, 'whsec_other'), SECRET)).toBe(false);
    expect(await verifyStripeSignature(body + ' ', await sign(body), SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, null, SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, 'garbage', SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, `t=${Math.floor(Date.now() / 1000)}`, SECRET)).toBe(false);
  });
  it('rejects a stale timestamp (older than 5 minutes) and one too far in the future', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verifyStripeSignature(body, await sign(body, now - 301), SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, await sign(body, now + 301), SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, await sign(body, now - 200), SECRET)).toBe(true);
  });
  it('accepts when any one of several v1 values matches', async () => {
    const t = Math.floor(Date.now() / 1000);
    const good = await hmacSha256Hex(SECRET, `${t}.${body}`);
    expect(await verifyStripeSignature(body, `t=${t},v1=${'a'.repeat(64)},v1=${good}`, SECRET)).toBe(true);
  });
});

describe('webhook route', () => {
  it('503 billing_not_configured when Stripe is not configured', async () => {
    delete env.STRIPE_WEBHOOK_SECRET;
    const res = await post({ id: 'evt_x', type: 'x', data: { object: {} } });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('billing_not_configured');
  });
  it('400 invalid_signature for missing, bad and stale signatures; nothing is written', async () => {
    const { id } = await pendingPayment();
    const ev = completed('evt_sig_' + id, id);
    for (const header of [null, 'bad', await sign(JSON.stringify(ev), 1)]) {
      const res = await post(ev, header);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_signature');
    }
    expect(await getDb().select().from(paymentWebhookEvents).where(eq(paymentWebhookEvents.id, 'evt_sig_' + id))).toHaveLength(0);
    const [p] = await getDb().select().from(payments).where(eq(payments.id, id));
    expect(p.status).toBe('pending');
  });
  it('a paid checkout credits the user once, marks the payment paid and writes one invoice', async () => {
    const { u, id } = await pendingPayment();
    const res = await post(completed('evt_ok_' + id, id));
    expect(res.status).toBe(200);
    expect(await getBalanceMicroUsd(u.userId)).toBe(10_000_000);
    const [p] = await getDb().select().from(payments).where(eq(payments.id, id));
    expect(p.status).toBe('paid');
    expect(await getDb().select().from(invoices).where(eq(invoices.paymentId, id))).toHaveLength(1);
  });
  it('the same webhook twice = one credit (second answers duplicate:true)', async () => {
    const { u, id } = await pendingPayment();
    const ev = completed('evt_dup_' + id, id);
    expect((await post(ev)).status).toBe(200);
    const second = await post(ev);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(await getBalanceMicroUsd(u.userId)).toBe(10_000_000);
  });
  it('a different event id for an already paid payment still credits only once', async () => {
    const { u, id } = await pendingPayment();
    await post(completed('evt_a_' + id, id));
    await post({ ...completed('evt_b_' + id, id), type: 'checkout.session.async_payment_succeeded' });
    expect(await getBalanceMicroUsd(u.userId)).toBe(10_000_000);
  });
  it('20 parallel deliveries of one event credit once', async () => {
    const { u, id } = await pendingPayment();
    const ev = completed('evt_par_' + id, id);
    await Promise.all(Array.from({ length: 20 }, () => post(ev)));
    expect(await getBalanceMicroUsd(u.userId)).toBe(10_000_000);
  });
  it('an unpaid session or unknown payment id credits nothing', async () => {
    const { u, id } = await pendingPayment();
    const unpaid = completed('evt_unpaid_' + id, id);
    (unpaid.data.object as Record<string, unknown>).payment_status = 'unpaid';
    expect((await post(unpaid)).status).toBe(200);
    expect((await post(completed('evt_ghost_' + id, 'pay_does_not_exist'))).status).toBe(200);
    expect(await getBalanceMicroUsd(u.userId)).toBe(0);
  });
  it('an expired session marks the payment expired and credits nothing', async () => {
    const { u, id } = await pendingPayment();
    await post({ id: 'evt_exp_' + id, type: 'checkout.session.expired', data: { object: { client_reference_id: id } } });
    const [p] = await getDb().select().from(payments).where(eq(payments.id, id));
    expect(p.status).toBe('expired');
    expect(await getBalanceMicroUsd(u.userId)).toBe(0);
  });
  it('the webhook never makes an outbound call (provider stubbed, no network)', async () => {
    const { id } = await pendingPayment();
    await post(completed('evt_net_' + id, id));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('refund math', () => {
  async function paid(amountMinor: number, creditMicroUsd: number) {
    const p = await pendingPayment(amountMinor, creditMicroUsd);
    await post(completed('evt_p_' + p.id, p.id));
    return { ...p, intent: 'pi_' + p.id };
  }
  it('partial refund returns the same share of credit; full refund returns the rest', async () => {
    const p = await paid(1000, 10_000_000);
    await post(refunded('evt_r1_' + p.id, p.intent, 250));
    expect(await getBalanceMicroUsd(p.u.userId)).toBe(7_500_000);
    let [row] = await getDb().select().from(payments).where(eq(payments.id, p.id));
    expect(row).toMatchObject({ status: 'partially_refunded', refundedMinor: 250 });
    await post(refunded('evt_r2_' + p.id, p.intent, 1000));
    expect(await getBalanceMicroUsd(p.u.userId)).toBe(0);
    [row] = await getDb().select().from(payments).where(eq(payments.id, p.id));
    expect(row).toMatchObject({ status: 'refunded', refundedMinor: 1000 });
  });
  it('replaying a refund, or an older smaller amount, changes nothing', async () => {
    const p = await paid(1000, 10_000_000);
    await post(refunded('evt_a_' + p.id, p.intent, 500));
    await post(refunded('evt_a_' + p.id, p.intent, 500));
    await post(refunded('evt_b_' + p.id, p.intent, 500));
    await post(refunded('evt_c_' + p.id, p.intent, 100));
    expect(await getBalanceMicroUsd(p.u.userId)).toBe(5_000_000);
  });
  it('a refund above the amount paid is clamped to the amount paid', async () => {
    const p = await paid(1000, 10_000_000);
    await post(refunded('evt_over_' + p.id, p.intent, 5000));
    expect(await getBalanceMicroUsd(p.u.userId)).toBe(0);
    const [row] = await getDb().select().from(payments).where(eq(payments.id, p.id));
    expect(row.refundedMinor).toBe(1000);
  });
  it('an unknown payment intent changes nothing', async () => {
    const p = await paid(1000, 10_000_000);
    await post(refunded('evt_unk_' + p.id, 'pi_unknown', 1000));
    expect(await getBalanceMicroUsd(p.u.userId)).toBe(10_000_000);
  });
  it('uneven split (300 cents for 1,000,000 micro) in three steps leaves at most 2 micro-USD of drift', async () => {
    // shortcut: per-step rounding. The checkout only sells whole-dollar packages, so real payments divide evenly.
    const p = await paid(300, 1_000_000);
    for (const [i, amt] of [100, 200, 300].entries()) await post(refunded(`evt_u${i}_${p.id}`, p.intent, amt));
    expect(Math.abs(await getBalanceMicroUsd(p.u.userId))).toBeLessThanOrEqual(2);
  });
});

describe('checkout', () => {
  const call = (user: { cookie: string } | null, body: unknown, opts: { origin?: boolean } = {}) =>
    checkout(req('/api/billing/checkout', { method: 'POST', cookie: user?.cookie, body, origin: opts.origin }), { params: Promise.resolve({}) });
  const stripeOk = () => fetchSpy.mockResolvedValue(Response.json({ id: 'cs_test_stub', url: 'https://checkout.stripe.test/stub' }));

  it('401 without a session, 403 from a foreign origin, 403 when email is unverified', async () => {
    expect((await call(null, { amountUsd: 10 })).status).toBe(401);
    const u = await makeUser();
    expect((await call(u, { amountUsd: 10 }, { origin: false })).status).toBe(403);
    const unverified = await makeUser({ verified: false });
    const res = await call(unverified, { amountUsd: 10 });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('email_not_verified');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('503 billing_not_configured when Stripe keys are missing', async () => {
    delete env.STRIPE_SECRET_KEY;
    const res = await call(await makeUser(), { amountUsd: 10 });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('billing_not_configured');
  });
  it('rejects amounts outside the package list', async () => {
    const u = await makeUser();
    for (const amountUsd of [0, 7, -5, 1000, '10']) expect((await call(u, { amountUsd })).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('a listed amount creates a pending payment and returns the (stubbed) Stripe URL', async () => {
    stripeOk();
    const u = await makeUser();
    const res = await call(u, { amountUsd: 25 });
    expect(res.status).toBe(201);
    const { paymentId, url } = await res.json();
    expect(url).toBe('https://checkout.stripe.test/stub');
    const [p] = await getDb().select().from(payments).where(eq(payments.id, paymentId));
    expect(p).toMatchObject({ status: 'pending', amountMinor: 2500, creditMicroUsd: 25_000_000, userId: u.userId });
    expect(await getBalanceMicroUsd(u.userId)).toBe(0); // credit only arrives with the webhook
  });
  it('a Stripe failure returns 502 checkout_failed and marks the payment failed', async () => {
    fetchSpy.mockResolvedValue(Response.json({ error: { message: 'boom' } }, { status: 500 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const u = await makeUser();
    const res = await call(u, { amountUsd: 10 });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('checkout_failed');
    const rows = await getDb().select().from(payments).where(eq(payments.userId, u.userId));
    expect(rows.map(r => r.status)).toEqual(['failed']);
  });
  it('FINDING: with INFERENCE_ENABLED=false checkout still starts a real Stripe charge flow', async () => {
    // Report only (task rule: do not fix in this PR). If this test starts failing, the guard was added: update it.
    env.INFERENCE_ENABLED = 'false';
    stripeOk();
    const res = await call(await makeUser(), { amountUsd: 10 });
    expect(res.status).toBe(201);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://api.stripe.com/v1/checkout/sessions');
  });
});
