import { authenticateApiKey, gatewayErrorResponse } from '../../../../lib/server/gateway';
import { getBalanceMicroUsd } from '../../../../lib/server/ledger';

export const dynamic = 'force-dynamic';

/** Programmatic balance check for keys with the "usage" scope. */
export async function GET(request: Request) {
  try {
    const auth = await authenticateApiKey(request, 'usage');
    const micro = await getBalanceMicroUsd(auth.userId);
    return Response.json({ balance_usd: +(micro / 1e6).toFixed(6), currency: 'USD' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return gatewayErrorResponse(e);
  }
}
