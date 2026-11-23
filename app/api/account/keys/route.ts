import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { apiKeys } from '../../../../db/schema';
import { audit } from '../../../../lib/server/audit';
import { requireUser } from '../../../../lib/server/auth';
import { handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';
import { createApiKey, KEY_SCOPES } from '../../../../lib/server/keys';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  name: z.string().trim().min(2, 'must be 2–48 characters').max(48, 'must be 2–48 characters'),
  scopes: z.array(z.enum(KEY_SCOPES)).min(1).max(KEY_SCOPES.length).optional(),
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
  rateLimitPerMin: z.number().int().min(1).max(600).optional(),
});

export const POST = handle(async request => {
  requireSameOrigin(request);
  const user = await requireUser(request);
  const body = await parseBody(request, createSchema);
  const { secret, key } = await createApiKey(user.userId, {
    name: body.name,
    scopes: body.scopes ?? ['chat'],
    expiresAt: body.expiresInDays ? Date.now() + body.expiresInDays * 86_400_000 : null,
    rateLimitPerMin: body.rateLimitPerMin ?? 60,
  });
  await audit(request, user.userId, 'key.created', { type: 'api_key', id: key.id });
  return json({ key, secret, notice: 'Copy this key now. Only its SHA-256 hash is stored, so it cannot be shown again.' }, 201);
});

export const DELETE = handle(async request => {
  requireSameOrigin(request);
  const user = await requireUser(request);
  const { id } = await parseBody(request, z.object({ id: z.string().min(1).max(64) }));
  const changed = await getDb()
    .update(apiKeys)
    .set({ revokedAt: Date.now() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.userId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  if (changed.length) await audit(request, user.userId, 'key.revoked', { type: 'api_key', id });
  return json({ revoked: changed.length === 1 });
});
