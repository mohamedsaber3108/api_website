import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { accounts, sessions } from '../../../../db/schema';
import { audit } from '../../../../lib/server/audit';
import { consumeAuthToken } from '../../../../lib/server/auth';
import { grantSignupBonus } from '../../../../lib/server/bonus';
import { signupBonusMicroUsd } from '../../../../lib/server/config';
import { hashPassword } from '../../../../lib/server/crypto';
import { clientIp, fail, handle, json, parseBody, passwordSchema, requireSameOrigin } from '../../../../lib/server/http';
import { rateLimit } from '../../../../lib/server/ratelimit';
import { errText } from '../../../../lib/server/redact';

export const dynamic = 'force-dynamic';

export const POST = handle(async request => {
  requireSameOrigin(request);
  await rateLimit(`reset:ip:${clientIp(request)}`, 10, 3600);
  const { token, password } = await parseBody(request, z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), password: passwordSchema }));
  const userId = await consumeAuthToken(token, 'reset_password');
  if (!userId) return fail(400, 'This reset link is invalid or has expired', 'invalid_token');
  const db = getDb();
  // Receiving the link proves control of the mailbox, so the email counts as verified.
  await db.batch([
    db.update(accounts).set({ passwordHash: await hashPassword(password), emailVerifiedAt: Date.now() }).where(eq(accounts.userId, userId)),
    db.delete(sessions).where(eq(sessions.userId, userId)),
  ]);
  await audit(request, userId, 'auth.password_reset', { type: 'account', id: userId });
  const [acct] = await db.select({ email: accounts.email }).from(accounts).where(eq(accounts.userId, userId)).limit(1);
  // bonus: true = credit added now, false = not added (once per e-mail), null = bonus switched off or the check failed.
  let bonus: boolean | null = signupBonusMicroUsd() > 0 ? false : null;
  try {
    if (acct && (await grantSignupBonus(userId, acct.email))) {
      bonus = true;
      await audit(request, userId, 'auth.signup_bonus', { type: 'account', id: userId }, { domain: acct.email.split('@')[1] });
    }
  } catch (e) {
    // The link is already used and the password changed; a bonus failure must not turn this into a 500.
    console.error('signup bonus failed', errText(e));
    bonus = null;
  }
  return json({ ok: true, bonus });
});
