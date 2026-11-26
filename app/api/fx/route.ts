import snapshot from '../../../data/fx-snapshot.json';
import { publicLimit } from '../../../lib/server/ratelimit';

export const dynamic = 'force-dynamic';
let cache: { at: number; value: unknown } | null = null;
const currencies = ['USD', 'EGP', 'SAR', 'AED', 'EUR'] as const;

export async function GET(request?: Request) {
  if (request) {
    const limited = await publicLimit(request, 'fx', 60, 60);
    if (limited) return limited;
  }
  if (cache && Date.now() - cache.at < 86_400_000) return Response.json(cache.value, { headers: { 'Cache-Control': 'public, max-age=3600' } });
  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`FX upstream returned ${response.status}`);
    const result = await response.json() as { result?: string; rates?: Record<string, number>; time_last_update_utc?: string };
    if (result.result !== 'success' || currencies.some(c => !Number.isFinite(result.rates?.[c]))) throw new Error('FX incomplete');
    const rates = Object.fromEntries(currencies.map(c => [c, result.rates![c]]));
    const value = { source: 'https://open.er-api.com/v6/latest/USD', updatedAt: result.time_last_update_utc, rates, live: true };
    cache = { at: Date.now(), value };
    return Response.json(value, { headers: { 'Cache-Control': 'public, max-age=3600' } });
  } catch {
    return Response.json({ ...snapshot, live: false }, { headers: { 'Cache-Control': 'public, max-age=300' } });
  }
}
