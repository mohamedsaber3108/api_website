import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { accounts, sessions } from '../../../../db/schema';
import { audit } from '../../../../lib/server/audit';
import { requireUser } from '../../../../lib/server/auth';
import { hashPassword, verifyPassword } from '../../../../lib/server/crypto';
import { fail, handle, json, parseBody, passwordSchema, requireSameOrigin } from '../../../../lib/server/http';
import { rateLimit } from '../../../../lib/server/ratelimit';

export const dynamic = 'force-dynamic';

export const POST = handle(async request => {
  requireSameOrigin(request);
  const user = await requireUser(request);
  if (user.provider !== 'password') return fail(400, 'This account signs in with ChatGPT and has no password', 'no_password');
  await rateLimit(`pwchange:${user.userId}`, 5, 900);
  const { currentPassword, newPassword } = await parseBody(request, z.object({ currentPassword: z.string().max(200), newPassword: passwordSchema }));
  const db = getDb();
  const [a] = await db.select({ hash: accounts.passwordHash }).from(accounts).where(eq(accounts.userId, user.userId)).limit(1);
  if (!(await verifyPassword(currentPassword, a?.hash ?? null))) return fail(403, 'Current password is incorrect', 'invalid_credentials');
  await db.batch([
    db.update(accounts).set({ passwordHash: await hashPassword(newPassword) }).where(eq(accounts.userId, user.userId)),
    // Sign out every other device.
    db.delete(sessions).where(and(eq(sessions.userId, user.userId), user.sessionId ? ne(sessions.id, user.sessionId) : undefined)),
  ]);
  await audit(request, user.userId, 'auth.password_changed', { type: 'account', id: user.userId });
  return json({ ok: true });
});
