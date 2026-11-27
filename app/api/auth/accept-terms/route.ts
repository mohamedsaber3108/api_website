import { eq } from 'drizzle-orm';
import { getDb } from '../../../../db';
import { accounts } from '../../../../db/schema';
import { TERMS_VERSION, termsUpdateRequired } from '../../../../lib/legal-versions';
import { audit } from '../../../../lib/server/audit';
import { requireUser } from '../../../../lib/server/auth';
import { handle, json, requireSameOrigin } from '../../../../lib/server/http';
import { rateLimit } from '../../../../lib/server/ratelimit';

export const dynamic = 'force-dynamic';

/**
 * Records that the signed-in user accepted the current terms. Safe to call twice: when the user is already on the
 * current version nothing is written and no audit row is added. The API gateway is NOT blocked before acceptance (LEGAL-1 default).
 */
export const POST = handle(async request => {
  requireSameOrigin(request);
  const p = await requireUser(request);
  await rateLimit(`accept-terms:user:${p.userId}`, 20, 3600, 'Too many requests. Please try again later.');
  const db = getDb();
  const [a] = await db.select({ v: accounts.termsVersion }).from(accounts).where(eq(accounts.userId, p.userId)).limit(1);
  if (termsUpdateRequired(a?.v)) {
    await db.update(accounts).set({ termsAcceptedAt: Date.now(), termsVersion: TERMS_VERSION }).where(eq(accounts.userId, p.userId));
    await audit(request, p.userId, 'auth.terms_accepted', { type: 'account', id: p.userId }, { from: a?.v ?? null, to: TERMS_VERSION });
  }
  return json({ ok: true, termsVersion: TERMS_VERSION, termsUpdateRequired: false });
});
