import { env } from 'cloudflare:workers';
import { and, eq, or } from 'drizzle-orm';
import { getDb } from '../../../../db';
import { invoices, payments, paymentWebhookEvents } from '../../../../db/schema';
import { audit } from '../../../../lib/server/audit';
import { features } from '../../../../lib/server/config';
import { sendEmail } from '../../../../lib/server/email';
import { fail, handle } from '../../../../lib/server/http';
import { errText } from '../../../../lib/server/redact';
import { ledgerInsert } from '../../../../lib/server/ledger';
import { verifyStripeSignature } from '../../../../lib/server/stripe';
import { accounts } from '../../../../db/schema';

export const dynamic = 'force-dynamic';

type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

async function completePayment(paymentId: string, intent: string | null) {
  const db = getDb();
  const [p] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!p) return;
  if (p.status === 'paid' || p.status === 'refunded' || p.status === 'partially_refunded') return;
  const now = Date.now();
  const number = `INV-${new Date(now).toISOString().slice(0, 7).replace('-', '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  // One atomic batch: payment state, ledger credit (idempotent), invoice.
  await db.batch([
    db.update(payments).set({ status: 'paid', completedAt: now, providerPaymentIntent: intent }).where(and(eq(payments.id, p.id), eq(payments.status, p.status))),
    ledgerInsert({ userId: p.userId, deltaMicroUsd: p.creditMicroUsd, type: 'topup', idempotencyKey: `topup:${p.id}`, refType: 'payment', refId: p.id, note: 'Credit purchase' }),
    db.insert(invoices).values({ id: crypto.randomUUID(), number, userId: p.userId, paymentId: p.id, amountMinor: p.amountMinor, currency: p.currency, description: `Wasl AI credits ($${(p.creditMicroUsd / 1e6).toFixed(2)})`, status: 'paid', issuedAt: now }).onConflictDoNothing(),
  ]);
  const [acct] = await db.select({ email: accounts.email }).from(accounts).where(eq(accounts.userId, p.userId)).limit(1);
  if (acct) await sendEmail({ to: acct.email, subject: `Wasl AI receipt ${number}`, text: `Thanks. We added $${(p.creditMicroUsd / 1e6).toFixed(2)} in credits to your account.\nInvoice: ${number}` });
  await audit(null, p.userId, 'billing.payment_completed', { type: 'payment', id: p.id });
}

async function applyRefund(intent: string, amountRefunded: number) {
  const db = getDb();
  const [p] = await db.select().from(payments).where(eq(payments.providerPaymentIntent, intent)).limit(1);
  if (!p || amountRefunded <= p.refundedMinor) return;
  const deltaMinor = Math.min(amountRefunded, p.amountMinor) - p.refundedMinor;
  const creditBack = Math.round((p.creditMicroUsd * deltaMinor) / p.amountMinor);
  const fullyRefunded = amountRefunded >= p.amountMinor;
  await db.batch([
    db.update(payments).set({ refundedMinor: Math.min(amountRefunded, p.amountMinor), status: fullyRefunded ? 'refunded' : 'partially_refunded' }).where(eq(payments.id, p.id)),
    ledgerInsert({ userId: p.userId, deltaMicroUsd: -creditBack, type: 'refund', idempotencyKey: `refund:${p.id}:${Math.min(amountRefunded, p.amountMinor)}`, refType: 'payment', refId: p.id, note: 'Refund' }),
  ]);
  await audit(null, p.userId, 'billing.refund_applied', { type: 'payment', id: p.id }, { amountRefunded });
}

export const POST = handle(async request => {
  if (!features.billing()) return fail(503, 'Billing is not configured', 'billing_not_configured');
  // Signature must be verified against the exact bytes Stripe sent.
  const raw = await request.text();
  if (raw.length > 512_000) return fail(413, 'Payload too large', 'payload_too_large');
  if (!(await verifyStripeSignature(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET!))) return fail(400, 'Invalid signature', 'invalid_signature');

  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    return fail(400, 'Invalid JSON', 'invalid_json');
  }

  const db = getDb();
  const inserted = await db.insert(paymentWebhookEvents).values({ id: event.id, provider: 'stripe', type: event.type, receivedAt: Date.now() }).onConflictDoNothing().returning({ id: paymentWebhookEvents.id });
  if (inserted.length === 0) {
    const [prev] = await db.select().from(paymentWebhookEvents).where(eq(paymentWebhookEvents.id, event.id)).limit(1);
    if (prev?.processedAt) return Response.json({ received: true, duplicate: true });
  }

  try {
    const obj = event.data.object;
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const sessionId = String(obj.id);
      const paymentId = (obj.client_reference_id as string | null) || ((obj.metadata as Record<string, string> | null)?.payment_id ?? null);
      if (obj.payment_status === 'paid' && paymentId) {
        const [p] = await db.select({ id: payments.id }).from(payments).where(and(eq(payments.id, paymentId), or(eq(payments.providerSessionId, sessionId), eq(payments.status, 'pending')))).limit(1);
        if (p) await completePayment(paymentId, typeof obj.payment_intent === 'string' ? obj.payment_intent : null);
      }
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      const paymentId = obj.client_reference_id as string | null;
      if (paymentId) await db.update(payments).set({ status: event.type.endsWith('expired') ? 'expired' : 'failed' }).where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')));
    } else if (event.type === 'charge.refunded') {
      if (typeof obj.payment_intent === 'string') await applyRefund(obj.payment_intent, Number(obj.amount_refunded) || 0);
    }
    await db.update(paymentWebhookEvents).set({ processedAt: Date.now(), error: null }).where(eq(paymentWebhookEvents.id, event.id));
  } catch (e) {
    const message = errText(e);
    await db.update(paymentWebhookEvents).set({ error: message.slice(0, 500) }).where(eq(paymentWebhookEvents.id, event.id));
    console.error('webhook processing failed', event.id, errText(e));
    // 500 makes Stripe retry; the ledger idempotency key makes the retry safe.
    return fail(500, 'Processing failed', 'webhook_failed');
  }
  return Response.json({ received: true });
});
