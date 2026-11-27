import { z } from 'zod';
import { getDb } from '../../../../db';
import { accounts } from '../../../../db/schema';
import { baseUrl, isProduction, TERMS_VERSION } from '../../../../lib/server/config';
import { audit } from '../../../../lib/server/audit';
import { createAuthToken, createSession } from '../../../../lib/server/auth';
import { hashPassword } from '../../../../lib/server/crypto';
import { sendEmail } from '../../../../lib/server/email';
import { mailLang, renderMail } from '../../../../lib/server/mail-templates';
import { clientIp, emailSchema, fail, handle, json, parseBody, passwordSchema, requireSameOrigin } from '../../../../lib/server/http';
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

  const token = await createAuthToken(userId, 'verify_email', 48 * 3600 * 1000);
  const link = `${baseUrl(request)}/verify-email?token=${token}`;
  await sendEmail({ to: body.email, ...renderMail('verify_email', mailLang(null, request), { link, name: body.name }) });
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
