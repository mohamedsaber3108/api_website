import type { PaymentProvider } from './types';

/**
 * Development stub. Never contacts any network. The checkout URL points to our own site; the payment is
 * marked paid by POST /api/billing/stub/pay (development only), which uses the same completePayment
 * as the real webhook. There is no external webhook, so verifyWebhook is always false.
 */
export const stubProvider: PaymentProvider = {
  id: 'stub',
  currency: 'usd',
  async createCheckout(input) {
    const id = `stub_cs_${crypto.randomUUID().replace(/-/g, '')}`;
    return { id, url: `${input.origin}/billing/stub-checkout?session=${encodeURIComponent(id)}` };
  },
  verifyWebhook: async () => false,
  parseEvent: () => null,
};
