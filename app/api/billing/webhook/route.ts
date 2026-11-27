import { and, eq, or } from 'drizzle-orm';
import { getDb } from '../../../../db';
import { payments, paymentWebhookEvents } from '../../../../db/schema';
import { audit } from '../../../../lib/server/audit';
import { fail, handle } from '../../../../lib/server/http';
import { errText } from '../../../../lib/server/redact';
import { ledgerInsert } from '../../../../lib/server/ledger';
import { completePayment, getPaymentProvider } from '../../../../lib/server/payments';

export const dynamic = 'force-dynamic';

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
  const provider = getPaymentProvider();
  if (!provider) return fail(503, 'Billing is not configured', 'billing_not_configured');
  // The stub has no external webhook; its payments are completed by the development-only stub route.
  if (provider.id === 'stub') return fail(404, 'Not found', 'not_found');
  // Signature must be verified against the exact bytes the provider sent.
  const raw = await request.text();
  if (raw.length > 512_000) return fail(413, 'Payload too large', 'payload_too_large');
  if (!(await provider.verifyWebhook(raw, request.headers))) return fail(400, 'Invalid signature', 'invalid_signature');

  const event = provider.parseEvent(raw);
  if (!event) return fail(400, 'Invalid JSON', 'invalid_json');

  const db = getDb();
  const inserted = await db.insert(paymentWebhookEvents).values({ id: event.eventId, provider: provider.id, type: event.type, receivedAt: Date.now() }).onConflictDoNothing().returning({ id: paymentWebhookEvents.id });
  if (inserted.length === 0) {
    const [prev] = await db.select().from(paymentWebhookEvents).where(eq(paymentWebhookEvents.id, event.eventId)).limit(1);
    if (prev?.processedAt) return Response.json({ received: true, duplicate: true });
  }

  try {
    if (event.kind === 'paid') {
      const [p] = await db.select({ id: payments.id }).from(payments).where(and(eq(payments.id, event.paymentId), or(eq(payments.providerSessionId, event.sessionId), eq(payments.status, 'pending')))).limit(1);
      if (p) await completePayment(event.paymentId, event.intent, { amountMinor: event.amountMinor, currency: event.currency });
    } else if (event.kind === 'closed') {
      await db.update(payments).set({ status: event.status }).where(and(eq(payments.id, event.paymentId), eq(payments.status, 'pending')));
    } else if (event.kind === 'refunded') {
      await applyRefund(event.intent, event.amountRefunded);
    }
    await db.update(paymentWebhookEvents).set({ processedAt: Date.now(), error: null }).where(eq(paymentWebhookEvents.id, event.eventId));
  } catch (e) {
    const message = errText(e);
    await db.update(paymentWebhookEvents).set({ error: message.slice(0, 500) }).where(eq(paymentWebhookEvents.id, event.eventId));
    console.error('webhook processing failed', event.eventId, errText(e));
    // 500 makes the provider retry; the ledger idempotency key makes the retry safe.
    return fail(500, 'Processing failed', 'webhook_failed');
  }
  return Response.json({ received: true });
});
