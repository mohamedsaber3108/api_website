import { eq } from 'drizzle-orm';
import { getDb } from '../../../../db';
import { sessions } from '../../../../db/schema';
import { SESSION_COOKIE } from '../../../../lib/server/config';
import { clearSessionCookie } from '../../../../lib/server/auth';
import { sha256Hex } from '../../../../lib/server/crypto';
import { handle, json, readCookie, requireSameOrigin } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

export const POST = handle(async request => {
  requireSameOrigin(request);
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await getDb().delete(sessions).where(eq(sessions.id, await sha256Hex(token)));
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(request) });
});
