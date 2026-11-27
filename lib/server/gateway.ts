import { env } from 'cloudflare:workers';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db';
import { accounts, apiKeys, modelConfigs, usageEvents } from '../../db/schema';
import { defaultMarkupPercent, features } from './config';
import { flagEnabled } from './flags';
import { sha256Hex } from './crypto';
import { findModel } from './catalog';
import { closeHold, getAvailableMicroUsd, ledgerInsert, reserveCredit } from './ledger';
import { rateLimit } from './ratelimit';
import { errText } from './redact';
import { HttpError } from './http';

export class GatewayError extends Error {
  constructor(public status: number, public code: string, message: string, public headers: Record<string, string> = {}, public extra: Record<string, number> = {}) {
    super(message);
  }
}

export function gatewayErrorResponse(e: unknown): Response {
  const g =
    e instanceof GatewayError
      ? e
      : e instanceof HttpError
        ? new GatewayError(e.status, e.code ?? 'error', e.message, e.headers)
        : null;
  if (!g) {
    console.error('Gateway failure', errText(e));
    return Response.json({ error: { message: 'Internal server error', type: 'server_error', code: 'internal_error' } }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json({ error: { message: g.message, type: g.status >= 500 ? 'server_error' : 'invalid_request_error', code: g.code, ...g.extra } }, { status: g.status, headers: { 'Cache-Control': 'no-store', ...g.headers } });
}

export type ApiKeyAuth = { userId: string; keyId: string; scopes: string[]; rateLimitPerMin: number };

/** Validates `Authorization: Bearer wasl_...` and returns the owner. */
export async function authenticateApiKey(request: Request, scope: string): Promise<ApiKeyAuth> {
  const match = (request.headers.get('authorization') || '').match(/^Bearer (wasl_[a-f0-9]{64})$/);
  if (!match) throw new GatewayError(401, 'invalid_api_key', 'Provide a Wasl API key as "Authorization: Bearer wasl_..."');
  const now = Date.now();
  const hash = await sha256Hex(match[1]);
  const db = getDb();
  const [row] = await db
    .select({ id: apiKeys.id, userId: apiKeys.userId, scopes: apiKeys.scopes, rate: apiKeys.rateLimitPerMin, status: accounts.status })
    .from(apiKeys)
    .innerJoin(accounts, eq(accounts.userId, apiKeys.userId))
    .where(and(eq(apiKeys.hash, hash), isNull(apiKeys.revokedAt), or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now))))
    .limit(1);
  if (!row || row.status !== 'active') throw new GatewayError(401, 'invalid_api_key', 'Invalid, expired, or revoked API key');
  const scopes = row.scopes.split(',').map(s => s.trim());
  if (!scopes.includes(scope)) throw new GatewayError(403, 'insufficient_scope', `This key does not have the "${scope}" scope`);
  await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id));
  return { userId: row.userId, keyId: row.id, scopes, rateLimitPerMin: row.rate };
}

const contentPart = z.object({ type: z.string() }).passthrough();
const chatSchema = z
  .object({
    model: z.string().regex(/^[a-zA-Z0-9._:\/-]{3,150}$/),
    messages: z
      .array(z.object({ role: z.enum(['system', 'user', 'assistant', 'tool', 'developer']), content: z.union([z.string(), z.array(contentPart), z.null()]).optional() }).passthrough())
      .min(1)
      .max(200),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().min(1).max(16384).optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
    seed: z.number().int().optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    response_format: z.object({ type: z.string() }).passthrough().optional(),
    tools: z.array(z.unknown()).max(64).optional(),
    tool_choice: z.unknown().optional(),
  })
  .strip();

export type ChatRequest = z.infer<typeof chatSchema>;

export function parseChatRequest(raw: unknown): ChatRequest {
  const parsed = chatSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new GatewayError(400, 'invalid_request', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

type Usage = { prompt_tokens?: number; completion_tokens?: number; cost?: number };

type Billing = { inPrice: number; outPrice: number; markup: number };

/** Integer maths only (basis points): 50 micro at 10% is exactly 55, not 55.00000000000001 rounded up to 56. */
function chargeMicro(providerMicro: number, markup: number): number {
  if (providerMicro <= 0) return 0;
  const bp = Math.round(markup * 100);
  return Math.max(1, Math.floor((providerMicro * (10_000 + bp) + 9_999) / 10_000));
}

/** Where a customer adds credit. Used in the 402 message. */
function addCreditLink(): string {
  return `${(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/dashboard`;
}

function insufficientCreditsMessage(needMicro: number, availableMicro: number): string {
  const need = `$${(needMicro / 1e6).toFixed(4)}`;
  const have = `$${(Math.max(availableMicro, 0) / 1e6).toFixed(4)}`;
  const link = addCreditLink();
  return `Your balance is too low for this request (it can cost up to ${need}; available ${have}). | رصيدك غير كافٍ لهذا الطلب (قد تصل تكلفته إلى ${need}، والمتاح ${have}). Add credit / أضف رصيداً: ${link}`;
}

async function resolveBilling(modelId: string): Promise<Billing> {
  const model = await findModel(modelId);
  if (!model) throw new GatewayError(404, 'model_not_found', `Model "${modelId}" was not found in the catalog`);
  if (!model.outputModalities.includes('text') || model.outputModalities.length !== 1 || model.id.includes(':batch')) {
    throw new GatewayError(400, 'unsupported_model', 'Only text-output chat models are available through this endpoint');
  }
  if (model.input === null || model.output === null) throw new GatewayError(422, 'variable_price', 'This model has variable pricing and is not available for metered billing');
  const [cfg] = await getDb().select().from(modelConfigs).where(eq(modelConfigs.modelId, modelId)).limit(1);
  if (cfg && !cfg.enabled) throw new GatewayError(403, 'model_disabled', 'This model is currently unavailable');
  return { inPrice: model.input, outPrice: model.output, markup: cfg?.markupPercent ?? defaultMarkupPercent() };
}

export type ChatContext = {
  userId: string;
  keyId: string | null;
  source: 'api' | 'playground';
  requestId: string;
  startedAt: number;
};

/** `holdMicro` is the credit reserved for this request (null when none was needed). The charge never exceeds it, so the balance cannot go below zero. */
async function recordUsage(ctx: ChatContext, model: string, billing: Billing, usage: Usage | null, fallbackInTokens: number, fallbackOutChars: number, status: 'ok' | 'error' | 'aborted', holdMicro: number | null) {
  const inTokens = usage?.prompt_tokens ?? fallbackInTokens;
  const outTokens = usage?.completion_tokens ?? Math.ceil(fallbackOutChars / 3);
  const computed = Math.round(inTokens * billing.inPrice + outTokens * billing.outPrice);
  const providerMicro = status === 'error' ? 0 : typeof usage?.cost === 'number' && usage.cost >= 0 ? (usage.cost > 0 ? Math.max(1, Math.round(usage.cost * 1_000_000)) : 0) : computed;
  const wanted = status === 'error' ? 0 : chargeMicro(providerMicro, billing.markup);
  const charged = holdMicro === null ? wanted : Math.min(wanted, holdMicro);
  if (holdMicro !== null && wanted > holdMicro) console.error('charge capped at hold', ctx.requestId, `wanted=${wanted} hold=${holdMicro}`);
  const db = getDb();
  try {
    await db.batch([
      db.insert(usageEvents).values({
        id: crypto.randomUUID(),
        userId: ctx.userId,
        keyId: ctx.keyId,
        model,
        inputTokens: inTokens,
        outputTokens: outTokens,
        costMicroUsd: charged,
        providerCostMicroUsd: providerMicro,
        requestId: ctx.requestId,
        status,
        latencyMs: Date.now() - ctx.startedAt,
        source: ctx.source,
        createdAt: Date.now(),
      }).onConflictDoNothing(),
      ...(charged > 0
        ? [ledgerInsert({ userId: ctx.userId, deltaMicroUsd: -charged, type: 'usage', idempotencyKey: `usage:${ctx.requestId}`, refType: 'request', refId: ctx.requestId, note: model })]
        : []),
      closeHold(ctx.requestId, status === 'error' ? 'released' : 'settled'),
    ]);
  } catch (e) {
    console.error('usage metering failed', ctx.requestId, errText(e));
    if (holdMicro !== null) console.error('hold left open after failed settle; it expires on its own, reconcile if charged', ctx.requestId);
  }
  return { charged, inTokens, outTokens };
}

function sanitizeUsage(payload: Record<string, unknown>) {
  const u = payload.usage as Record<string, unknown> | undefined;
  if (u && typeof u === 'object') {
    delete u.cost;
    delete u.cost_details;
    delete u.is_byok;
  }
  delete payload.provider;
}

/** Runs one metered chat completion. Returns the HTTP response to send to the caller. */
export async function runChat(ctx: ChatContext, body: ChatRequest, signal?: AbortSignal): Promise<Response> {
  if (!features.inference() || !(await flagEnabled('inference'))) {
    throw new GatewayError(503, 'service_not_activated', 'Paid Wasl inference is not activated on this deployment.', { 'Retry-After': '3600' });
  }
  const billing = await resolveBilling(body.model);
  const inTokensEstimate = Math.ceil(JSON.stringify(body.messages).length / 3);
  const maxOut = body.max_tokens ?? 2048;
  const maxCost = chargeMicro(Math.round(inTokensEstimate * billing.inPrice + maxOut * billing.outPrice), billing.markup);
  // SEC-1: reserve the worst-case cost first. The check and the insert are one statement, so parallel calls cannot overspend.
  const holdMicro = maxCost > 0 ? maxCost : null;
  if (holdMicro !== null && !(await reserveCredit(ctx.userId, ctx.requestId, holdMicro))) {
    const available = await getAvailableMicroUsd(ctx.userId);
    throw new GatewayError(402, 'insufficient_credits', insufficientCreditsMessage(maxCost, available), {}, { need_micro_usd: maxCost, available_micro_usd: Math.max(available, 0) });
  }

  const upstreamBody: Record<string, unknown> = { ...body, max_tokens: maxOut, usage: { include: true } };
  if (body.stream) upstreamBody.stream_options = { include_usage: true };

  let upstream: Response;
  try {
    upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Wasl AI' },
      body: JSON.stringify(upstreamBody),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
    });
  } catch (e) {
    await recordUsage(ctx, body.model, billing, null, inTokensEstimate, 0, 'error', holdMicro);
    throw new GatewayError(e instanceof Error && e.name === 'TimeoutError' ? 504 : 502, 'upstream_unreachable', 'The model provider could not be reached');
  }

  const baseHeaders = { 'Cache-Control': 'no-store', 'X-Request-Id': ctx.requestId };

  if (!upstream.ok) {
    const payload = (await upstream.json().catch(() => ({}))) as { error?: { message?: string } };
    await recordUsage(ctx, body.model, billing, null, inTokensEstimate, 0, 'error', holdMicro);
    const status = upstream.status >= 500 ? 502 : upstream.status === 401 || upstream.status === 402 ? 502 : upstream.status;
    const message = upstream.status === 401 || upstream.status === 402 ? 'The upstream provider rejected the request. Please contact support.' : payload?.error?.message || `Provider returned ${upstream.status}`;
    throw new GatewayError(status, status === 429 ? 'provider_rate_limited' : 'upstream_error', message, baseHeaders);
  }

  if (!body.stream) {
    const payload = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
    if (!payload) {
      await recordUsage(ctx, body.model, billing, null, inTokensEstimate, 0, 'error', holdMicro);
      throw new GatewayError(502, 'upstream_error', 'Invalid response from the model provider');
    }
    const usage = (payload.usage as Usage | undefined) ?? null;
    const text = JSON.stringify(payload.choices ?? '').length;
    const { charged } = await recordUsage(ctx, body.model, billing, usage, inTokensEstimate, text, 'ok', holdMicro);
    sanitizeUsage(payload);
    payload.wasl = { request_id: ctx.requestId, charged_usd: +(charged / 1e6).toFixed(6) };
    return Response.json(payload, { headers: baseHeaders });
  }

  if (!upstream.body) {
    await recordUsage(ctx, body.model, billing, null, inTokensEstimate, 0, 'error', holdMicro);
    throw new GatewayError(502, 'upstream_error', 'Empty stream from the model provider');
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let usage: Usage | null = null;
  let outChars = 0;
  let recorded = false;
  const finish = async (status: 'ok' | 'aborted') => {
    if (recorded) return;
    recorded = true;
    await recordUsage(ctx, body.model, billing, usage, inTokensEstimate, outChars, status, holdMicro);
  };
  const processLine = (line: string): string => {
    if (!line.startsWith('data:')) return line;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return line;
    try {
      const chunk = JSON.parse(data) as Record<string, unknown>;
      if (chunk.usage && typeof chunk.usage === 'object') usage = { ...(chunk.usage as Usage) };
      const delta = (chunk.choices as Array<{ delta?: { content?: unknown } }> | undefined)?.[0]?.delta?.content;
      if (typeof delta === 'string') outChars += delta.length;
      sanitizeUsage(chunk);
      return `data: ${JSON.stringify(chunk)}`;
    } catch {
      return line;
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer) controller.enqueue(encoder.encode(processLine(buffer)));
          await finish('ok');
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        if (lines.length) controller.enqueue(encoder.encode(lines.map(processLine).join('\n') + '\n'));
      } catch (e) {
        await finish('aborted');
        controller.error(e);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      await finish('aborted');
    },
  });
  return new Response(stream, { headers: { ...baseHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' } });
}

export async function enforceGatewayRateLimit(auth: { userId: string; keyId: string | null; rateLimitPerMin: number }) {
  try {
    await rateLimit(auth.keyId ? `gw:key:${auth.keyId}` : `gw:user:${auth.userId}`, auth.rateLimitPerMin, 60, 'Rate limit exceeded for this key');
  } catch (e) {
    if (e instanceof HttpError) throw new GatewayError(e.status, 'rate_limit_exceeded', e.message, e.headers);
    throw e;
  }
}

export function newChatContext(userId: string, keyId: string | null, source: 'api' | 'playground'): ChatContext {
  return { userId, keyId, source, requestId: `req_${crypto.randomUUID().replace(/-/g, '')}`, startedAt: Date.now() };
}
