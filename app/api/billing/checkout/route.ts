import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { payments } from '../../../../db/schema';
import { INFERENCE_OFF_MESSAGE } from '../../../../lib/checkout-error';
import { audit } from '../../../../lib/server/audit';
import { requireUser } from '../../../../lib/server/auth';
import { baseUrl, MICRO } from '../../../../lib/server/config';
import { inferenceEnabled } from '../../../../lib/server/flags';
import { fail, handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';
import { getPaymentProvider } from '../../../../lib/server/payments';
import { CURRENCY_UNSUPPORTED_MESSAGE, findPricePoint, PACKAGE_ID_RE, PRICE_UNAVAILABLE_MESSAGE } from '../../../../lib/server/prices';
import { rateLimit } from '../../../../lib/server/ratelimit';

export const dynamic = 'force-dynamic';

export const POST = handle(async request => {
  requireSameOrigin(request);
  const user = await requireUser(request);
  const provider = getPaymentProvider();
  if (!provider) return fail(503, 'Online payments are not activated yet', 'billing_not_configured');
  // No payment row and no provider call while paid inference is off. Webhook and refunds of past payments are separate routes.
  if (!(await inferenceEnabled())) return fail(503, INFERENCE_OFF_MESSAGE.en, 'inference_not_enabled', { message_ar: INFERENCE_OFF_MESSAGE.ar });
  if (!user.emailVerified) return fail(403, 'Verify your email before adding credits', 'email_not_verified');
  await rateLimit(`checkout:${user.userId}`, 10, 3600);
  // `amountUsd` is the old body (USD packages only); it maps to package `credits-<n>` in USD.
  const body = await parseBody(request, z.object({
    packageId: z.string().regex(PACKAGE_ID_RE).optional(),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
    amountUsd: z.number().optional(),
  }).refine(b => b.packageId !== undefined || b.amountUsd !== undefined, 'packageId is required'));
  const packageId = body.packageId ?? `credits-${body.amountUsd}`;
  const currency = (body.currency ?? 'USD').toUpperCase();

  // The stored price decides the amount. No conversion between currencies.
  const price = await findPricePoint(packageId, currency);
  if (!price) return fail(400, PRICE_UNAVAILABLE_MESSAGE.en, 'price_not_available', { message_ar: PRICE_UNAVAILABLE_MESSAGE.ar });
  if (!provider.supportsCurrency(price.currency)) return fail(400, CURRENCY_UNSUPPORTED_MESSAGE.en, 'currency_not_supported', { message_ar: CURRENCY_UNSUPPORTED_MESSAGE.ar });

  const id = `pay_${crypto.randomUUID().replace(/-/g, '')}`;
  const amountMinor = price.amountMinor;
  const chargeCurrency = price.currency.toLowerCase();
  const db = getDb();
  await db.insert(payments).values({ id, userId: user.userId, provider: provider.id, amountMinor, currency: chargeCurrency, creditMicroUsd: price.credits, status: 'pending', createdAt: Date.now() });
  try {
    const origin = baseUrl(request);
    const session = await provider.createCheckout({
      paymentId: id,
      amountMinor,
      currency: chargeCurrency,
      email: user.email,
      description: `Wasl AI credits ($${price.credits / MICRO})`,
      origin,
      successUrl: `${origin}/dashboard?tab=billing&payment=success`,
      cancelUrl: `${origin}/dashboard?tab=billing&payment=cancelled`,
    });
    await db.update(payments).set({ providerSessionId: session.id }).where(eq(payments.id, id));
    await audit(request, user.userId, 'billing.checkout_started', { type: 'payment', id }, { packageId, currency: price.currency, amountMinor });
    return json({ url: session.url, paymentId: id, currency: chargeCurrency, amountMinor, provider: provider.id }, 201);
  } catch (e) {
    await db.update(payments).set({ status: 'failed' }).where(eq(payments.id, id));
    throw e;
  }
});
