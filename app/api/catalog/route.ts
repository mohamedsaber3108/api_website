import { loadCatalog } from '../../../lib/server/catalog';
import { publicLimit } from '../../../lib/server/ratelimit';
export const dynamic = 'force-dynamic';
// Internal callers (models, pricing) call GET() without a request: they apply their own limit once.
export async function GET(request?: Request) {
  if (request) {
    const limited = await publicLimit(request, 'catalog', 120, 60);
    if (limited) return limited;
  }
  const value = await loadCatalog();
  return Response.json(value, { headers: { 'Cache-Control': `public, max-age=${value.live ? 3600 : 300}` } });
}
