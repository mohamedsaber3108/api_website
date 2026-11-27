import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { invoices, payments } from '../db/schema';
import { completePayment } from '../lib/server/payments';
import { PaymentMismatchError } from '../lib/server/payments/complete';
import { stripeProvider } from '../lib/server/payments/stripe';
import { getBalanceMicroUsd } from '../lib/server/ledger';
import { POST as checkout } from '../app/api/billing/checkout/route';
import { POST as stubPay } from '../app/api/billing/stub/pay/route';
import { makeUser, req, startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
const ctx = { params: Promise.resolve({}) };
type U = { userId: string; cookie: string };

beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });
beforeEach(() => {
  env.INFERENCE_ENABLED = 'true';
  env.OPENROUTER_API_KEY = 'or_test_not_a_real_key';
  env.PAYMENT_PROVIDER = 'stub';
  env.APP_ENV = 'development'; // sendEmail logs "[email:dev]" lines instead of sending
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ['PAYMENT_PROVIDER', 'APP_ENV', 'INFERENCE_ENABLED', 'OPENROUTER_API_KEY'] as const) delete env[k];
});

const startCheckout = async (u: U, amountUsd = 10) => {
  const { paymentId } = await (await checkout(req('/api/billing/checkout', { method: 'POST', cookie: u.cookie, body: { amountUsd } }), ctx)).json();
  const [p] = await getDb().select().from(payments).where(eq(payments.id, paymentId));
  return p;
};
const receiptMails = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('[email:dev]') && String(c[0]).includes('receipt'));

describe('PAY-1b receipt mail is sent once', () => {
  it('parallel stub pay: one credit, one invoice, exactly one receipt mail', async () => {
    const u = await makeUser();
    const p = await startCheckout(u);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const results = await Promise.all(Array.from({ length: 5 }, () => stubPay(req('/api/billing/stub/pay', { method: 'POST', cookie: u.cookie, body: { sessionId: p.providerSessionId } }), ctx)));
    expect(results.map(r => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await getBalanceMicroUsd(u.userId)).toBe(10_000_000);
    expect(await getDb().select().from(invoices).where(eq(invoices.paymentId, p.id))).toHaveLength(1);
    expect(receiptMails(log)).toHaveLength(1);
  });
  it('a replay after payment sends no second mail; completePayment returns true once', async () => {
    const u = await makeUser();
    const p = await startCheckout(u);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const paid = { amountMinor: p.amountMinor, currency: p.currency };
    const outcomes = await Promise.all([completePayment(p.id, 'pi_1', paid), completePayment(p.id, 'pi_1', paid), completePayment(p.id, 'pi_1', paid)]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await completePayment(p.id, 'pi_1', paid)).toBe(false);
    expect(receiptMails(log)).toHaveLength(1);
    expect(await getBalanceMicroUsd(u.userId)).toBe(10_000_000);
  });
});

describe('PAY-1b paid amount must match the stored payment', () => {
  it('wrong amount or wrong currency: nothing credited, nothing paid, no invoice, no mail', async () => {
    const u = await makeUser();
    const p = await startCheckout(u);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(completePayment(p.id, 'pi_x', { amountMinor: p.amountMinor - 1, currency: p.currency })).rejects.toBeInstanceOf(PaymentMismatchError);
    await expect(completePayment(p.id, 'pi_x', { amountMinor: p.amountMinor, currency: 'eur' })).rejects.toBeInstanceOf(PaymentMismatchError);
    await expect(completePayment(p.id, 'pi_x', { amountMinor: -1, currency: '' })).rejects.toBeInstanceOf(PaymentMismatchError);
    expect(await getBalanceMicroUsd(u.userId)).toBe(0);
    const [after] = await getDb().select().from(payments).where(eq(payments.id, p.id));
    expect(after.status).toBe('pending');
    expect(await getDb().select().from(invoices).where(eq(invoices.paymentId, p.id))).toHaveLength(0);
    expect(receiptMails(log)).toHaveLength(0);
    expect(err).toHaveBeenCalled();
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/sk_|whsec_|@/);
  });
  it('matching amount (currency case ignored) credits once, even after an earlier mismatch', async () => {
    const u = await makeUser();
    const p = await startCheckout(u);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(completePayment(p.id, 'pi_y', { amountMinor: 1, currency: p.currency })).rejects.toThrow();
    expect(await completePayment(p.id, 'pi_y', { amountMinor: p.amountMinor, currency: p.currency.toUpperCase() })).toBe(true);
    expect(await completePayment(p.id, 'pi_y', { amountMinor: p.amountMinor, currency: p.currency })).toBe(false);
    expect(await getBalanceMicroUsd(u.userId)).toBe(10_000_000);
  });
  it('the Stripe event carries amount_total and currency; a missing amount can never match', () => {
    const ev = (obj: Record<string, unknown>) => stripeProvider.parseEvent(JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', client_reference_id: 'pay_1', payment_status: 'paid', ...obj } } }));
    expect(ev({ amount_total: 1000, currency: 'usd' })).toMatchObject({ kind: 'paid', amountMinor: 1000, currency: 'usd' });
    expect(ev({})).toMatchObject({ kind: 'paid', amountMinor: -1, currency: '' });
  });
});
