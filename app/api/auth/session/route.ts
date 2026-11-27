import { eq } from 'drizzle-orm';
import { getDb } from '../../../../db';
import { accounts, sessions } from '../../../../db/schema';
import { getPrincipal, publicUser, requireUser } from '../../../../lib/server/auth';
import { features, STAFF_IDLE_MS } from '../../../../lib/server/config';
import { TERMS_VERSION, termsUpdateRequired } from '../../../../lib/legal-versions';
import { inferenceEnabled } from '../../../../lib/server/flags';
import { handle, json, requireSameOrigin } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

/**
 * Always 200. `user` is null for anonymous callers so the UI can boot without a 401.
 * Staff also get `sessionLimits` (when the idle and absolute limits end, and the server clock). `?peek=1` does not count as activity.
 */
export const GET = handle(async request => {
  const peek = new URL(request.url).searchParams.get('peek') === '1';
  const p = await getPrincipal(request, { peek });
  let terms: { termsUpdateRequired: boolean; currentTermsVersion: string } | null = null;
  if (p) {
    const [a] = await getDb().select({ v: accounts.termsVersion }).from(accounts).where(eq(accounts.userId, p.userId)).limit(1);
    terms = { termsUpdateRequired: termsUpdateRequired(a?.v), currentTermsVersion: TERMS_VERSION };
  }
  return json({
    user: p ? publicUser(p) : null,
    ...(terms ?? {}),
    features: { inference: await inferenceEnabled(), billing: features.billing(), email: features.email(), chatgpt: features.chatgptIdentity() },
    ...(p?.sessionEnds ? { sessionLimits: { ...p.sessionEnds, now: Date.now() } } : {}),
  });
});

/** "Stay signed in": moves the idle limit only. The absolute limit (8 hours after sign-in) never moves. */
export const POST = handle(async request => {
  requireSameOrigin(request);
  const p = await requireUser(request);
  if (!p.sessionEnds || !p.sessionId) return json({ ok: true });
  const now = Date.now();
  await getDb().update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, p.sessionId));
  return json({ ok: true, sessionLimits: { idleEndsAt: now + STAFF_IDLE_MS, absoluteEndsAt: p.sessionEnds.absoluteEndsAt, now } });
});
