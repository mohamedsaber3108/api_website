import { eq } from 'drizzle-orm';
import { getDb } from '../../../../db';
import { accounts } from '../../../../db/schema';
import { baseUrl, isProduction } from '../../../../lib/server/config';
import { createAuthToken, requireUser } from '../../../../lib/server/auth';
import { sendEmail } from '../../../../lib/server/email';
import { mailLang, renderMail } from '../../../../lib/server/mail-templates';
import { handle, json, requireSameOrigin } from '../../../../lib/server/http';
import { rateLimit } from '../../../../lib/server/ratelimit';

export const dynamic = 'force-dynamic';

export const POST = handle(async request => {
  requireSameOrigin(request);
  const user = await requireUser(request);
  if (user.emailVerified) return json({ ok: true, alreadyVerified: true });
  await rateLimit(`resend-verify:${user.userId}`, 3, 3600, 'Please wait before requesting another email.');
  const token = await createAuthToken(user.userId, 'verify_email', 48 * 3600 * 1000);
  const link = `${baseUrl(request)}/verify-email?token=${token}`;
  const [acct] = await getDb().select({ preferences: accounts.preferences }).from(accounts).where(eq(accounts.userId, user.userId)).limit(1);
  const { delivered } = await sendEmail({ to: user.email, ...renderMail('verify_email', mailLang(acct?.preferences, request), { link }) });
  return json({ ok: true, delivered, ...(isProduction() ? {} : { dev_verify_token: token }) });
});
