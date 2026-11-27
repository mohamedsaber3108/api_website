import { authenticateApiKey, gatewayErrorResponse } from '../../../../lib/server/gateway';
import { getBalanceSummary } from '../../../../lib/server/ledger';

export const dynamic = 'force-dynamic';

const usd = (micro: number) => +(micro / 1e6).toFixed(6);

/** Programmatic balance check for keys with the "usage" scope. `balance_usd` is the ledger balance; `available_usd` is that minus open holds. */
export async function GET(request: Request) {
  try {
    const auth = await authenticateApiKey(request, 'usage');
    const s = await getBalanceSummary(auth.userId);
    return Response.json(
      {
        balance_usd: usd(s.balanceMicroUsd),
        available_usd: usd(s.availableMicroUsd),
        available_micro_usd: s.availableMicroUsd,
        held_micro_usd: s.heldMicroUsd,
        currency: 'USD',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return gatewayErrorResponse(e);
  }
}
