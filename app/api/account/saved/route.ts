import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { savedModels } from '../../../../db/schema';
import { requireUser } from '../../../../lib/server/auth';
import { fail, handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

const modelId = z.string().regex(/^[a-zA-Z0-9._:\/-]{3,150}$/);

export const GET = handle(async request => {
  const user = await requireUser(request);
  const rows = await getDb().select({ modelId: savedModels.modelId }).from(savedModels).where(eq(savedModels.userId, user.userId)).orderBy(desc(savedModels.createdAt));
  return json({ models: rows.map(r => r.modelId) });
});

/** Merges local favourites into the account: `{ models: string[] }`. */
export const PUT = handle(async request => {
  requireSameOrigin(request);
  const user = await requireUser(request);
  const { models } = await parseBody(request, z.object({ models: z.array(modelId).max(200) }));
  const db = getDb();
  const now = Date.now();
  if (models.length) await db.insert(savedModels).values(models.map(m => ({ userId: user.userId, modelId: m, createdAt: now }))).onConflictDoNothing();
  const rows = await db.select({ modelId: savedModels.modelId }).from(savedModels).where(eq(savedModels.userId, user.userId));
  return json({ models: rows.map(r => r.modelId) });
});

export const DELETE = handle(async request => {
  requireSameOrigin(request);
  const user = await requireUser(request);
  const body = await parseBody(request, z.object({ modelId }));
  const rows = await getDb().delete(savedModels).where(and(eq(savedModels.userId, user.userId), eq(savedModels.modelId, body.modelId))).returning({ id: savedModels.modelId });
  return rows.length ? json({ ok: true }) : fail(404, 'Not saved', 'not_found');
});
