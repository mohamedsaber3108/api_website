import { eq, and } from 'drizzle-orm';
import { getDb } from '../../../db';
import { payments } from '../../../db/schema';
import { isProduction, paymentProvider } from '../../../lib/server/config';
import StubCheckout from '../../../components/stub-checkout';
import { serverLang } from '../../lang-server';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Test checkout', robots: { index: false, follow: false } };

/**
 * Landing page of the development payment stub (PAY-1b). Real only when APP_ENV=development and
 * PAYMENT_PROVIDER=stub; in every other setup it shows "not available" and reads nothing from the database.
 */
export default async function StubCheckoutPage({ searchParams }: { searchParams: Promise<{ session?: string | string[] }> }) {
  const lang = await serverLang();
  let found: { amountMinor: number; currency: string; sessionId: string } | null = null;
  if (!isProduction() && paymentProvider() === 'stub') {
    const raw = (await searchParams).session;
    const sessionId = typeof raw === 'string' ? raw.slice(0, 100) : '';
    if (sessionId) {
      const [p] = await getDb().select({ amountMinor: payments.amountMinor, currency: payments.currency, status: payments.status }).from(payments).where(and(eq(payments.providerSessionId, sessionId), eq(payments.provider, 'stub'))).limit(1);
      if (p && (p.status === 'pending' || p.status === 'paid')) found = { amountMinor: p.amountMinor, currency: p.currency, sessionId };
    }
  }
  return <StubCheckout lang={lang} payment={found} />;
}
