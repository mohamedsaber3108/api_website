import { requireUser } from '../../../../lib/server/auth';
import { enforceGatewayRateLimit, GatewayError, gatewayErrorResponse, newChatContext, parseChatRequest, runChat } from '../../../../lib/server/gateway';
import { discardBody, requireSameOrigin } from '../../../../lib/server/http';

export const dynamic = 'force-dynamic';

/** Same metered gateway as /api/v1/chat/completions, authenticated by the browser session instead of a key. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    await enforceGatewayRateLimit({ userId: user.userId, keyId: null, rateLimitPerMin: 20 });
    const raw = await request.json().catch(() => {
      throw new GatewayError(400, 'invalid_json', 'Request body must be valid JSON');
    });
    const body = parseChatRequest({ ...(raw as object), max_tokens: Math.min(Number((raw as { max_tokens?: number })?.max_tokens) || 1024, 2048) });
    return await runChat(newChatContext(user.userId, null, 'playground'), body, request.signal);
  } catch (e) {
    await discardBody(request);
    return gatewayErrorResponse(e);
  }
}
