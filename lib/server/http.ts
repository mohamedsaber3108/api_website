import { z } from 'zod';
import { env } from 'cloudflare:workers';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { ...NO_STORE, ...headers } });
}

export function fail(status: number, message: string, code?: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return json({ error: message, code: code ?? `http_${status}`, ...extra }, status, headers);
}

/** Thrown inside route handlers and converted to a JSON error by `handle`. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public extra: Record<string, unknown> = {}, public headers: Record<string, string> = {}) {
    super(message);
  }
}

type Ctx<P> = { params: Promise<P> };

/** Wraps a route handler so thrown errors become consistent JSON responses. */
export function handle<P = Record<string, string>>(fn: (request: Request, ctx: Ctx<P>) => Promise<Response>) {
  return async (request: Request, ctx: Ctx<P>) => {
    try {
      return await fn(request, ctx);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message, e.code, e.extra, e.headers);
      console.error('Unhandled route error', e instanceof Error ? `${e.name}: ${e.message}` : e);
      return fail(500, 'Internal server error', 'internal_error');
    } finally {
      await discardBody(request);
    }
  };
}

/** Responding without consuming a request body can break keep-alive connections in workerd. */
export async function discardBody(request: Request) {
  if (!request.body || request.bodyUsed) return;
  const length = Number(request.headers.get('content-length') || 0);
  // Draining is what actually frees the connection; cancel() alone does not in workerd.
  if (length > 0 && length <= 1_000_000) await request.arrayBuffer().catch(() => {});
  else await request.body.cancel().catch(() => {});
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/** Cookie-authenticated mutations must come from our own origin. */
export function requireSameOrigin(request: Request) {
  if (!sameOrigin(request)) throw new HttpError(403, 'Invalid origin', 'invalid_origin');
}

export async function parseBody<S extends z.ZodTypeAny>(request: Request, schema: S, maxBytes = 32_000): Promise<z.infer<S>> {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > maxBytes) throw new HttpError(413, 'Request too large', 'payload_too_large');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Request too large', 'payload_too_large');
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON', 'invalid_json');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request', 'invalid_request');
  }
  return parsed.data;
}

export function parseQuery<S extends z.ZodTypeAny>(request: Request, schema: S): z.infer<S> {
  const raw = Object.fromEntries(new URL(request.url).searchParams.entries());
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, issue ? `${issue.path.join('.') || 'query'}: ${issue.message}` : 'Invalid query', 'invalid_request');
  }
  return parsed.data;
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function cookieHeader(request: Request, name: string, value: string, maxAgeSeconds: number): string {
  const secure = new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export function db1() {
  const d1 = env.DB;
  if (!d1) throw new HttpError(503, 'Database unavailable', 'db_unavailable');
  return d1;
}

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(10, 'must be at least 10 characters').max(200);
