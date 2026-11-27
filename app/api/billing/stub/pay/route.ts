import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../../db';
import { payments } from '../../../../../db/schema';
import { requireUser } from '../../../../../lib/server/auth';
import { isProduction, paymentProvider } from '../../../../../lib/server/config';
import { fail, handle, json, parseBody, requireSameOrigin } from '../../../../../lib/server/http';
import { completePayment } from '../../../../../lib/server/payments';

export const dynamic = 'force-dynamic';

/**
 * Development only: marks a stub checkout paid through the same completePayment the webhook uses.
 * Refused unless APP_ENV=development and PAYMENT_PROVIDER=stub. Only the user who owns the payment can pay it.
 */
export const POST = handle(async request => {
  if (isProduction() || paymentProvider() !== 'stub') return fail(403, 'Stub payments are disabled', 'stub_payments_disabled');
  requireSameOrigin(request);
  const user = await requireUser(request);
  const { sessionId } = await parseBody(request, z.object({ sessionId: z.string().min(1).max(100) }));
  const db = getDb();
  const [p] = await db.select().from(payments).where(and(eq(payments.providerSessionId, sessionId), eq(payments.provider, 'stub'), eq(payments.userId, user.userId))).limit(1);
  if (!p) return fail(404, 'Payment not found', 'payment_not_found');
  if (p.status !== 'pending' && p.status !== 'paid') return fail(409, 'This payment can no longer be paid', 'payment_not_payable');
  // The stub has no outside charge, so it "pays" exactly what was stored; the amount check is real for Stripe.
  await completePayment(p.id, `stub_pi_${p.id}`, { amountMinor: p.amountMinor, currency: p.currency });
  return json({ paid: true, paymentId: p.id });
});
