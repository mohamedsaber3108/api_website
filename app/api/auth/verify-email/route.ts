import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { accounts } from '../../../../db/schema';
import { audit } from '../../../../lib/server/audit';
import { consumeAuthToken } from '../../../../lib/server/auth';
import { grantSignupBonus } from '../../../../lib/server/bonus';
import { clientIp, fail, handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';
import { rateLimit } from '../../../../lib/server/ratelimit';
import { errText } from '../../../../lib/server/redact';

export const dynamic = 'force-dynamic';

export const POST = handle(async request => {
  requireSameOrigin(request);
  await rateLimit(`verify:ip:${clientIp(request)}`, 20, 3600);
  const { token } = await parseBody(request, z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }));
  const userId = await consumeAuthToken(token, 'verify_email');
  if (!userId) return fail(400, 'This verification link is invalid or has expired', 'invalid_token');
  await getDb().update(accounts).set({ emailVerifiedAt: Date.now() }).where(eq(accounts.userId, userId));
  await audit(request, userId, 'auth.email_verified', { type: 'account', id: userId });
  const [acct] = await getDb().select({ email: accounts.email }).from(accounts).where(eq(accounts.userId, userId)).limit(1);
  // bonus: true = credit added now, false = not added (once per e-mail), null = the check failed.
  let bonus: boolean | null = false;
  try {
    if (acct && (await grantSignupBonus(userId, acct.email))) {
      bonus = true;
      // Metric: bonus count per e-mail domain (domains only, no addresses), so disposable-domain use can be counted later.
      await audit(request, userId, 'auth.signup_bonus', { type: 'account', id: userId }, { domain: acct.email.split('@')[1] });
    }
  } catch (e) {
    // The link is already used; a bonus failure must not turn a verified e-mail into a 500.
    console.error('signup bonus failed', errText(e));
    bonus = null;
  }
  return json({ ok: true, bonus });
});
