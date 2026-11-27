import { statusReport } from '../../../../lib/server/health';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'public, max-age=30', 'Access-Control-Allow-Origin': '*' };

export async function GET() {
  try {
    return Response.json(await statusReport(), { headers });
  } catch {
    // Fixed answer: no error text, no stack, no host names.
    return Response.json({ status: 'degraded', checkedAt: new Date().toISOString(), checks: { database: 'down', inference: 'off', billing: 'not_configured', email: 'not_configured' }, incidents: [] }, { headers });
  }
}
