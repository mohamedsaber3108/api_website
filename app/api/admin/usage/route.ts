import { z } from 'zod';
import { requireRole } from '../../../../lib/server/auth';
import { handle, json, parseQuery } from '../../../../lib/server/http';
import { usageSummary } from '../../../../lib/server/usage';

export const dynamic = 'force-dynamic';

export const GET = handle(async request => {
  await requireRole(request, 'admin');
  const { days } = parseQuery(request, z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }));
  return json(await usageSummary(null, days));
});
