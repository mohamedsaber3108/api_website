import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../../db';
import { apiKeys } from '../../../../../db/schema';
import { audit } from '../../../../../lib/server/audit';
import { requireUser } from '../../../../../lib/server/auth';
import { fail, handle, json, parseBody, requireSameOrigin } from '../../../../../lib/server/http';
import { createApiKey } from '../../../../../lib/server/keys';

export const dynamic = 'force-dynamic';

/** Issues a replacement key with the same settings and revokes the old one. */
export const POST = handle(async request => {
  requireSameOrigin(request);
  const user = await requireUser(request);
  const { id } = await parseBody(request, z.object({ id: z.string().min(1).max(64) }));
  const db = getDb();
  const [old] = await db.select().from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.userId), isNull(apiKeys.revokedAt))).limit(1);
  if (!old) return fail(404, 'Key not found', 'not_found');
  const remaining = old.expiresAt ? Math.max(old.expiresAt - Date.now(), 86_400_000) : null;
  // Revoke first so the 10-key cap does not block rotation of a full set.
  await db.update(apiKeys).set({ revokedAt: Date.now() }).where(eq(apiKeys.id, old.id));
  const { secret, key } = await createApiKey(user.userId, {
    name: old.name,
    scopes: old.scopes.split(','),
    expiresAt: remaining ? Date.now() + remaining : null,
    rateLimitPerMin: old.rateLimitPerMin,
    rotatedFromId: old.id,
  });
  await audit(request, user.userId, 'key.rotated', { type: 'api_key', id: old.id }, { newId: key.id });
  return json({ key, secret, notice: 'The previous key is revoked. Copy the new key now.' }, 201);
});
