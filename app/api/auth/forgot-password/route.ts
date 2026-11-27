import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { accounts } from '../../../../db/schema';
import { createAuthToken } from '../../../../lib/server/auth';
import { baseUrl, isProduction } from '../../../../lib/server/config';
import { sendEmail } from '../../../../lib/server/email';
import { mailLang, renderMail } from '../../../../lib/server/mail-templates';
import { clientIp, emailSchema, handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';
import { rateLimit } from '../../../../lib/server/ratelimit';

export const dynamic = 'force-dynamic';

/** Always answers 202 so the endpoint cannot be used to discover which emails have accounts. */
export const POST = handle(async request => {
  requireSameOrigin(request);
  const { email } = await parseBody(request, z.object({ email: emailSchema }));
  await rateLimit(`forgot:ip:${clientIp(request)}`, 10, 3600);
  await rateLimit(`forgot:email:${email}`, 3, 3600);

  const [account] = await getDb().select().from(accounts).where(and(eq(accounts.email, email), eq(accounts.authProvider, 'password'), eq(accounts.status, 'active'))).limit(1);
  let devToken: string | undefined;
  if (account) {
    const token = await createAuthToken(account.userId, 'reset_password', 3600 * 1000);
    devToken = token;
    const link = `${baseUrl(request)}/reset-password?token=${token}`;
    await sendEmail({ to: email, ...renderMail('reset_password', mailLang(account.preferences, request), { link }) });
  }
  return json({ ok: true, ...(!isProduction() && devToken ? { dev_reset_token: devToken } : {}) }, 202);
});
