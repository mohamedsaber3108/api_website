import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { payments } from '../../../../db/schema';
import { INFERENCE_OFF_MESSAGE } from '../../../../lib/checkout-error';
import { audit } from '../../../../lib/server/audit';
import { requireUser } from '../../../../lib/server/auth';
import { baseUrl, CREDIT_PACKAGES, features, MICRO } from '../../../../lib/server/config';
import { inferenceEnabled } from '../../../../lib/server/flags';
import { fail, handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';
import { rateLimit } from '../../../../lib/server/ratelimit';
import { createStripeCheckout } from '../../../../lib/server/stripe';

export const dynamic = 'force-dynamic';

export const POST = handle(async request => {
  requireSameOrigin(request);
  const user = await requireUser(request);
  if (!features.billing()) return fail(503, 'Online payments are not activated yet', 'billing_not_configured');
  // No payment row and no Stripe call while paid inference is off. Webhook and refunds of past payments are separate routes.
  if (!(await inferenceEnabled())) return fail(503, INFERENCE_OFF_MESSAGE.en, 'inference_not_enabled', { message_ar: INFERENCE_OFF_MESSAGE.ar });
  if (!user.emailVerified) return fail(403, 'Verify your email before adding credits', 'email_not_verified');
  await rateLimit(`checkout:${user.userId}`, 10, 3600);
  const { amountUsd } = await parseBody(request, z.object({ amountUsd: z.number().refine(v => (CREDIT_PACKAGES as readonly number[]).includes(v), 'Choose one of the listed amounts') }));

  const id = `pay_${crypto.randomUUID().replace(/-/g, '')}`;
  const db = getDb();
  await db.insert(payments).values({ id, userId: user.userId, provider: 'stripe', amountMinor: amountUsd * 100, currency: 'usd', creditMicroUsd: amountUsd * MICRO, status: 'pending', createdAt: Date.now() });
  try {
    const origin = baseUrl(request);
    const session = await createStripeCheckout({
      paymentId: id,
      amountCents: amountUsd * 100,
      email: user.email,
      description: `Wasl AI credits ($${amountUsd})`,
      successUrl: `${origin}/dashboard?tab=billing&payment=success`,
      cancelUrl: `${origin}/dashboard?tab=billing&payment=cancelled`,
    });
    await db.update(payments).set({ providerSessionId: session.id }).where(eq(payments.id, id));
    await audit(request, user.userId, 'billing.checkout_started', { type: 'payment', id }, { amountUsd });
    return json({ url: session.url, paymentId: id }, 201);
  } catch (e) {
    await db.update(payments).set({ status: 'failed' }).where(eq(payments.id, id));
    throw e;
  }
});
