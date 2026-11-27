import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { accounts } from '../../../../db/schema';
import { audit } from '../../../../lib/server/audit';
import { createSession, publicUser, type Principal } from '../../../../lib/server/auth';
import { adminEmails } from '../../../../lib/server/config';
import { verifyPassword } from '../../../../lib/server/crypto';
import { clientIp, emailSchema, fail, handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';
import { rateLimit } from '../../../../lib/server/ratelimit';

export const dynamic = 'force-dynamic';

const schema = z.object({ email: emailSchema, password: z.string().min(1).max(200) });

export const POST = handle(async request => {
  requireSameOrigin(request);
  const body = await parseBody(request, schema);
  await rateLimit(`login:ip:${clientIp(request)}`, 30, 900, 'Too many sign-in attempts. Please try again later.');
  await rateLimit(`login:email:${body.email}`, 8, 900, 'Too many sign-in attempts for this account. Please try again later.');

  const db = getDb();
  const [account] = await db.select().from(accounts).where(and(eq(accounts.email, body.email), eq(accounts.authProvider, 'password'))).limit(1);
  const valid = await verifyPassword(body.password, account?.passwordHash ?? null);
  if (!account || !valid) {
    await audit(request, account?.userId ?? null, 'auth.login_failed', { type: 'email', id: body.email });
    return fail(401, 'Incorrect email or password', 'invalid_credentials');
  }
  if (account.status !== 'active') return fail(403, 'This account is not active', 'account_inactive');

  await db.update(accounts).set({ lastLoginAt: Date.now() }).where(eq(accounts.userId, account.userId));
  const cookie = await createSession(request, account.userId);
  await audit(request, account.userId, 'auth.login', { type: 'account', id: account.userId });

  const verified = !!account.emailVerifiedAt;
  const role = verified && adminEmails().has(account.email) ? 'admin' : account.role;
  const principal: Principal = { userId: account.userId, email: account.email, name: account.name || account.email, role: role as Principal['role'], provider: 'password', emailVerified: verified, sessionId: null, mfaVerifiedAt: null };
  return json({ user: publicUser(principal) }, 200, { 'Set-Cookie': cookie });
});
