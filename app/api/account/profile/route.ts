import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { accounts } from '../../../../db/schema';
import { requireUser } from '../../../../lib/server/auth';
import { handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

const schema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  preferences: z.object({ lang: z.enum(['ar', 'en']).optional(), theme: z.enum(['light', 'dark']).optional(), currency: z.enum(['USD', 'EGP', 'SAR', 'AED', 'EUR']).optional() }).optional(),
});

export const PATCH = handle(async request => {
  requireSameOrigin(request);
  const user = await requireUser(request);
  const body = await parseBody(request, schema);
  const db = getDb();
  const [current] = await db.select({ preferences: accounts.preferences }).from(accounts).where(eq(accounts.userId, user.userId)).limit(1);
  const merged = { ...(current?.preferences ? JSON.parse(current.preferences) : {}), ...(body.preferences ?? {}) };
  await db
    .update(accounts)
    .set({ ...(body.name ? { name: body.name } : {}), ...(body.preferences ? { preferences: JSON.stringify(merged) } : {}) })
    .where(eq(accounts.userId, user.userId));
  return json({ ok: true, name: body.name ?? user.name, preferences: merged });
});
