import { env } from 'cloudflare:workers';
import { hmacSha256Hex, safeEqual } from './crypto';
import { HttpError } from './http';

export type StripeCheckoutInput = {
  paymentId: string;
  amountCents: number;
  email: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
};

export async function createStripeCheckout(input: StripeCheckoutInput): Promise<{ id: string; url: string }> {
  const form = new URLSearchParams({
    mode: 'payment',
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.paymentId,
    customer_email: input.email,
    'metadata[payment_id]': input.paymentId,
    'payment_intent_data[metadata][payment_id]': input.paymentId,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(input.amountCents),
    'line_items[0][price_data][product_data][name]': input.description,
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `checkout:${input.paymentId}` },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await res.json().catch(() => ({}))) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !payload.id || !payload.url) {
    console.error('stripe checkout failed', res.status, payload.error?.message);
    throw new HttpError(502, 'Could not start checkout. Please try again.', 'checkout_failed');
  }
  return { id: payload.id, url: payload.url };
}

/** Verifies a `Stripe-Signature` header against the raw body. Tolerance: 5 minutes. */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string, toleranceSec = 300): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(',').map(p => p.trim().split('='));
  const t = parts.find(p => p[0] === 't')?.[1];
  const signatures = parts.filter(p => p[0] === 'v1').map(p => p[1]);
  if (!t || signatures.length === 0) return false;
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  return signatures.some(s => safeEqual(s, expected));
}
