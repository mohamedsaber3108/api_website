/**
 * Payment provider interface (PAY-1). The checkout and webhook routes talk only to this.
 * Q-API-2: no real provider is chosen yet, so Stripe stays as it was and a local stub is added for development.
 */
export type CheckoutInput = {
  paymentId: string;
  amountMinor: number;
  currency: string;
  email: string;
  description: string;
  /** Public origin of our own site (used by the stub to build its local checkout URL). */
  origin: string;
  successUrl: string;
  cancelUrl: string;
};

/** What a provider webhook means for us, in one provider-neutral shape. */
export type ProviderEvent =
  | { kind: 'paid'; eventId: string; type: string; sessionId: string; paymentId: string; intent: string | null; amountMinor: number; currency: string }
  | { kind: 'closed'; eventId: string; type: string; paymentId: string; status: 'expired' | 'failed' }
  | { kind: 'refunded'; eventId: string; type: string; intent: string; amountRefunded: number }
  | { kind: 'ignored'; eventId: string; type: string };

export interface PaymentProvider {
  /** Stored in payments.provider and payment_webhook_events.provider. */
  readonly id: 'stripe' | 'stub';
  /** The real charge currency (lower case ISO code). */
  readonly currency: string;
  /** True if this provider can charge in this currency (upper-case ISO code). Checked before any payment row is written. */
  supportsCurrency(currency: string): boolean;
  createCheckout(input: CheckoutInput): Promise<{ id: string; url: string }>;
  /** True only if the raw body is genuinely from the provider. */
  verifyWebhook(rawBody: string, headers: Headers): Promise<boolean>;
  /** Null when the body is not a usable event. */
  parseEvent(rawBody: string): ProviderEvent | null;
}
