import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { accounts } from '../../../../db/schema';
import { audit } from '../../../../lib/server/audit';
import { consumeAuthToken } from '../../../../lib/server/auth';
import { clientIp, fail, handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';
import { rateLimit } from '../../../../lib/server/ratelimit';

export const dynamic = 'force-dynamic';

export const POST = handle(async request => {
  requireSameOrigin(request);
  await rateLimit(`verify:ip:${clientIp(request)}`, 20, 3600);
  const { token } = await parseBody(request, z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }));
  const userId = await consumeAuthToken(token, 'verify_email');
  if (!userId) return fail(400, 'This verification link is invalid or has expired', 'invalid_token');
  await getDb().update(accounts).set({ emailVerifiedAt: Date.now() }).where(eq(accounts.userId, userId));
  await audit(request, userId, 'auth.email_verified', { type: 'account', id: userId });
  return json({ ok: true });
});
