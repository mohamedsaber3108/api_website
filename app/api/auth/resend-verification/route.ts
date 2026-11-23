import { baseUrl, isProduction } from '../../../../lib/server/config';
import { createAuthToken, requireUser } from '../../../../lib/server/auth';
import { sendEmail } from '../../../../lib/server/email';
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
  const { delivered } = await sendEmail({ to: user.email, subject: 'Verify your Wasl AI email', text: `Confirm your email:\n${link}\n\nThis link expires in 48 hours.` });
  return json({ ok: true, delivered, ...(isProduction() ? {} : { dev_verify_token: token }) });
});
