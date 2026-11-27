import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { accounts } from '../../../../db/schema';
import { TERMS_VERSION } from '../../../../lib/legal-versions';
import { audit } from '../../../../lib/server/audit';
import { requireUser } from '../../../../lib/server/auth';
import { fail, handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';
import { rateLimit } from '../../../../lib/server/ratelimit';

export const dynamic = 'force-dynamic';

const schema = z.object({ version: z.string().min(1).max(32) });

/**
 * Records that the signed-in user accepted the current terms. The client sends the version it showed; a stale one gets
 * 409, so nobody accepts a version they were not shown. The write is conditional, so two calls (or two parallel clicks)
 * add one audit entry. The API gateway is NOT blocked before acceptance (LEGAL-1 default).
 */
export const POST = handle(async request => {
  requireSameOrigin(request);
  const p = await requireUser(request);
  await rateLimit(`accept-terms:user:${p.userId}`, 20, 3600, 'Too many requests. Please try again later.');
  const body = await parseBody(request, schema);
  if (body.version !== TERMS_VERSION) {
    return fail(409, 'The terms changed while this page was open. Reload and review them again.', 'terms_version_changed', { message_ar: 'تغيّرت الشروط أثناء فتح الصفحة. أعد التحميل وراجعها مرة أخرى.', currentTermsVersion: TERMS_VERSION });
  }
  const db = getDb();
  const [a] = await db.select({ v: accounts.termsVersion }).from(accounts).where(eq(accounts.userId, p.userId)).limit(1);
  const changed = await db
    .update(accounts)
    .set({ termsAcceptedAt: Date.now(), termsVersion: TERMS_VERSION })
    .where(and(eq(accounts.userId, p.userId), or(isNull(accounts.termsVersion), lt(accounts.termsVersion, TERMS_VERSION))))
    .returning({ id: accounts.userId });
  if (changed.length) {
    await audit(request, p.userId, 'auth.terms_accepted', { type: 'account', id: p.userId }, { from: a?.v ?? null, to: TERMS_VERSION }, { before: { termsVersion: a?.v ?? null }, after: { termsVersion: TERMS_VERSION } });
  }
  return json({ ok: true, termsVersion: TERMS_VERSION, termsUpdateRequired: false });
});
