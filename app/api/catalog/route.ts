import { loadCatalog } from '../../../lib/server/catalog';
export const dynamic = 'force-dynamic';
export async function GET() {
  const value = await loadCatalog();
  return Response.json(value, { headers: { 'Cache-Control': `public, max-age=${value.live ? 3600 : 300}` } });
}
