import { healthReport, openIncidents } from '../../../../lib/server/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [health, incidents] = await Promise.all([healthReport(), openIncidents(10)]);
  return Response.json({ health, incidents }, { headers: { 'Cache-Control': 'public, max-age=30', 'Access-Control-Allow-Origin': '*' } });
}
