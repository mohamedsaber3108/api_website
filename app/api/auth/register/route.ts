import { z } from 'zod';
import { getDb } from '../../../../db';
import { accounts } from '../../../../db/schema';
import { baseUrl, isProduction, signupBonusMicroUsd, TERMS_VERSION } from '../../../../lib/server/config';
import { audit } from '../../../../lib/server/audit';
import { createAuthToken, createSession } from '../../../../lib/server/auth';
import { hashPassword } from '../../../../lib/server/crypto';
import { sendEmail } from '../../../../lib/server/email';
import { clientIp, emailSchema, fail, handle, json, parseBody, passwordSchema, requireSameOrigin } from '../../../../lib/server/http';
import { addLedgerEntry } from '../../../../lib/server/ledger';
import { rateLimit } from '../../../../lib/server/ratelimit';

export const dynamic = 'force-dynamic';

const schema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(2).max(80),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the terms' }) }),
});

export const POST = handle(async request => {
  requireSameOrigin(request);
  await rateLimit(`register:ip:${clientIp(request)}`, 10, 3600, 'Too many sign-up attempts. Please try again later.');
  const body = await parseBody(request, schema);

  const userId = `usr_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Date.now();
  try {
    await getDb().insert(accounts).values({
      userId,
      email: body.email,
      name: body.name,
      authProvider: 'password',
      passwordHash: await hashPassword(body.password),
      role: 'customer',
      status: 'active',
      termsAcceptedAt: now,
      termsVersion: TERMS_VERSION,
      createdAt: now,
    });
  } catch (e) {
    if (e instanceof Error && /UNIQUE|constraint/i.test(`${e.message} ${(e as { cause?: { message?: string } }).cause?.message ?? ''}`)) {
      return fail(409, 'An account with this email already exists', 'email_taken');
    }
    throw e;
  }

  const bonus = signupBonusMicroUsd();
  if (bonus > 0) await addLedgerEntry({ userId, deltaMicroUsd: bonus, type: 'bonus', idempotencyKey: `bonus:signup:${userId}`, note: 'Sign-up credit' });

  const token = await createAuthToken(userId, 'verify_email', 48 * 3600 * 1000);
  const link = `${baseUrl(request)}/verify-email?token=${token}`;
  await sendEmail({
    to: body.email,
    subject: 'Verify your Wasl AI email',
    text: `Hi ${body.name},\n\nConfirm your email to finish setting up your Wasl AI account:\n${link}\n\nThis link expires in 48 hours. If you did not sign up, ignore this message.`,
  });
  await audit(request, userId, 'auth.register', { type: 'account', id: userId });

  const cookie = await createSession(request, userId);
  return json(
    {
      user: { id: userId, email: body.email, name: body.name, role: 'customer', provider: 'password', emailVerified: false },
      ...(isProduction() ? {} : { dev_verify_token: token }),
    },
    201,
    { 'Set-Cookie': cookie },
  );
});
