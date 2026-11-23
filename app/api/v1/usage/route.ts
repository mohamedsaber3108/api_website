import { authenticateApiKey, gatewayErrorResponse } from '../../../../lib/server/gateway';
import { usageSummary } from '../../../../lib/server/usage';

export const dynamic = 'force-dynamic';

/** Programmatic usage summary for keys with the "usage" scope. `?days=1..365` (default 30). */
export async function GET(request: Request) {
  try {
    const auth = await authenticateApiKey(request, 'usage');
    const days = Math.min(365, Math.max(1, Number.parseInt(new URL(request.url).searchParams.get('days') || '30', 10) || 30));
    const s = await usageSummary(auth.userId, days);
    return Response.json(
      {
        days,
        totals: { requests: s.totals?.requests ?? 0, input_tokens: s.totals?.inputTokens ?? 0, output_tokens: s.totals?.outputTokens ?? 0, cost_usd: +((s.totals?.costMicroUsd ?? 0) / 1e6).toFixed(6) },
        daily: s.daily.map(d => ({ day: d.day, requests: d.requests, tokens: d.tokens, cost_usd: +(d.costMicroUsd / 1e6).toFixed(6) })),
        by_model: s.byModel.map(m => ({ model: m.model, requests: m.requests, input_tokens: m.inputTokens, output_tokens: m.outputTokens, cost_usd: +(m.costMicroUsd / 1e6).toFixed(6) })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return gatewayErrorResponse(e);
  }
}
