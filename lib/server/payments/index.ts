import { paymentProvider } from '../config';
import { stripeProvider } from './stripe';
import { stubProvider } from './stub';
import type { PaymentProvider } from './types';

export type { CheckoutInput, PaymentProvider, ProviderEvent } from './types';
export { completePayment } from './complete';

/** The active provider, or null when billing is off. Selection rules live in config.ts (paymentProvider). */
export function getPaymentProvider(): PaymentProvider | null {
  switch (paymentProvider()) {
    case 'stripe': return stripeProvider;
    case 'stub': return stubProvider;
    default: return null;
  }
}
