import { discardBody } from '../../../../../lib/server/http';
import { authenticateApiKey, enforceGatewayRateLimit, GatewayError, gatewayErrorResponse, newChatContext, parseChatRequest, runChat } from '../../../../../lib/server/gateway';

export const dynamic = 'force-dynamic';

/** OpenAI-compatible, metered chat completions authenticated by a Wasl API key. */
export async function POST(request: Request) {
  try {
    if (Number(request.headers.get('content-length') || 0) > 512_000) throw new GatewayError(413, 'payload_too_large', 'Request body too large');
    const auth = await authenticateApiKey(request, 'chat');
    await enforceGatewayRateLimit({ userId: auth.userId, keyId: auth.keyId, rateLimitPerMin: auth.rateLimitPerMin });
    const raw = await request.json().catch(() => {
      throw new GatewayError(400, 'invalid_json', 'Request body must be valid JSON');
    });
    const body = parseChatRequest(raw);
    return await runChat(newChatContext(auth.userId, auth.keyId, 'api'), body, request.signal);
  } catch (e) {
    await discardBody(request);
    return gatewayErrorResponse(e);
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' } });
}
