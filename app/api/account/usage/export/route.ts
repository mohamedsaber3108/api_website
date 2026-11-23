import { and, desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../../db';
import { usageEvents } from '../../../../../db/schema';
import { requireUser } from '../../../../../lib/server/auth';
import { handle, parseQuery } from '../../../../../lib/server/http';
import { csvEscape } from '../../../../../lib/server/usage';

export const dynamic = 'force-dynamic';

export const GET = handle(async request => {
  const user = await requireUser(request);
  const { days } = parseQuery(request, z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }));
  const rows = await getDb()
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, user.userId), gte(usageEvents.createdAt, Date.now() - days * 86_400_000)))
    .orderBy(desc(usageEvents.createdAt))
    .limit(50_000);
  const lines = ['timestamp,request_id,model,source,status,input_tokens,output_tokens,cost_usd,latency_ms'];
  for (const r of rows) {
    lines.push([new Date(r.createdAt).toISOString(), r.requestId ?? r.id, r.model, r.source, r.status, r.inputTokens, r.outputTokens, (r.costMicroUsd / 1e6).toFixed(6), r.latencyMs ?? ''].map(csvEscape).join(','));
  }
  return new Response(lines.join('\n') + '\n', {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="wasl-usage-${days}d.csv"`, 'Cache-Control': 'private, no-store' },
  });
});
