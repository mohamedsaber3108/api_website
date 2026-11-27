import { GET as getCatalog } from '../../catalog/route';
import { publicLimit } from '../../../../lib/server/ratelimit';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const limited = await publicLimit(request, 'models', 60, 60, { 'Access-Control-Allow-Origin': '*' });
  if (limited) return limited;
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0,100);
  const provider = (url.searchParams.get('provider') || '').toLowerCase();
  const offset = Math.max(0,Number.parseInt(url.searchParams.get('offset') || '0',10)||0);
  const limit = Math.max(1,Math.min(100,Number.parseInt(url.searchParams.get('limit') || '50',10)||50));
  const response = await getCatalog();
  const body = await response.json() as { models: Array<{id:string;name:string;company:string;description:string}>; source:string;updatedAt:string;live:boolean };
  const filtered = body.models.filter(m=>(!query||`${m.id} ${m.name} ${m.company} ${m.description}`.toLowerCase().includes(query))&&(!provider||m.company===provider));
  return Response.json({ data:filtered.slice(offset,offset+limit), meta:{total:filtered.length,offset,limit,updated_at:body.updatedAt,source:body.source,live:body.live} },{headers:{'Cache-Control':'public, max-age=300','Access-Control-Allow-Origin':'*'}});
}
