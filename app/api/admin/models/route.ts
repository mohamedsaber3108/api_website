import { z } from 'zod';
import { getDb } from '../../../../db';
import { modelConfigs } from '../../../../db/schema';
import { audit } from '../../../../lib/server/audit';
import { requireRole } from '../../../../lib/server/auth';
import { defaultMarkupPercent } from '../../../../lib/server/config';
import { handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async request => {
  await requireRole(request, 'admin');
  const rows = await getDb().select().from(modelConfigs);
  return json({ defaultMarkupPercent: defaultMarkupPercent(), configs: rows.map(r => ({ ...r, enabled: !!r.enabled })) });
});

/** Upserts availability and markup for one model. `markupPercent: null` falls back to the platform default. */
export const PUT = handle(async request => {
  requireSameOrigin(request);
  const admin = await requireRole(request, 'admin');
  const body = await parseBody(request, z.object({ modelId: z.string().regex(/^[a-zA-Z0-9._:\/-]{3,150}$/), enabled: z.boolean(), markupPercent: z.number().int().min(0).max(500).nullable(), note: z.string().max(200).nullable().optional() }));
  const values = { modelId: body.modelId, enabled: body.enabled ? 1 : 0, markupPercent: body.markupPercent, note: body.note ?? null, updatedAt: Date.now() };
  await getDb().insert(modelConfigs).values(values).onConflictDoUpdate({ target: modelConfigs.modelId, set: values });
  await audit(request, admin.userId, 'admin.model_config', { type: 'model', id: body.modelId }, body);
  return json({ ok: true });
});
