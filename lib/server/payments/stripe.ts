import { env } from 'cloudflare:workers';
import { createStripeCheckout, verifyStripeSignature } from '../stripe';
import type { PaymentProvider, ProviderEvent } from './types';

function parseStripeEvent(raw: string): ProviderEvent | null {
  let e: { id?: unknown; type?: unknown; data?: { object?: unknown } };
  try {
    e = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!e || typeof e.id !== 'string' || typeof e.type !== 'string' || !e.data || typeof e.data.object !== 'object' || e.data.object === null) return null;
  const obj = e.data.object as Record<string, unknown>;
  const base = { eventId: e.id, type: e.type };
  if (e.type === 'checkout.session.completed' || e.type === 'checkout.session.async_payment_succeeded') {
    const meta = obj.metadata as Record<string, string> | null | undefined;
    const paymentId = (obj.client_reference_id as string | null) || (meta?.payment_id ?? null);
    if (obj.payment_status === 'paid' && paymentId) {
      // A missing amount becomes -1 so it can never equal a stored payment: completePayment refuses it.
      return { kind: 'paid', ...base, sessionId: String(obj.id), paymentId, intent: typeof obj.payment_intent === 'string' ? obj.payment_intent : null, amountMinor: typeof obj.amount_total === 'number' ? obj.amount_total : -1, currency: typeof obj.currency === 'string' ? obj.currency : '' };
    }
  } else if (e.type === 'checkout.session.expired' || e.type === 'checkout.session.async_payment_failed') {
    const paymentId = obj.client_reference_id as string | null;
    if (paymentId) return { kind: 'closed', ...base, paymentId, status: e.type.endsWith('expired') ? 'expired' : 'failed' };
  } else if (e.type === 'charge.refunded') {
    if (typeof obj.payment_intent === 'string') return { kind: 'refunded', ...base, intent: obj.payment_intent, amountRefunded: Number(obj.amount_refunded) || 0 };
  }
  return { kind: 'ignored', ...base };
}

export const stripeProvider: PaymentProvider = {
  id: 'stripe',
  currency: 'usd',
  createCheckout: input =>
    createStripeCheckout({
      paymentId: input.paymentId,
      amountCents: input.amountMinor,
      email: input.email,
      description: input.description,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    }),
  verifyWebhook: (raw, headers) => verifyStripeSignature(raw, headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET!),
  parseEvent: parseStripeEvent,
};
