/**
 * Security response headers, applied to every response in worker/index.ts.
 * Pure functions (no Workers imports) so they can be unit tested.
 */

/** Switch to 'Content-Security-Policy' once the report-only run shows no violations. */
export const CSP_HEADER_NAME = 'Content-Security-Policy-Report-Only';

/**
 * shortcut: 'unsafe-inline' for script-src is needed while the framework emits inline bootstrap
 * scripts without a nonce; upgrade to a per-request nonce, then drop it, before enforcing.
 * style-src keeps 'unsafe-inline' because the UI uses React style attributes.
 * No 'unsafe-eval'. OpenRouter catalog calls are made server side, so connect-src is 'self' only.
 */
export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
] as const;

export const CSP_VALUE = CSP_DIRECTIVES.join('; ');

/** 180 days. */
export const HSTS_VALUE = 'max-age=15552000';

export function isHttps(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === 'https';
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function securityHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {
    [CSP_HEADER_NAME]: CSP_VALUE,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
  if (isHttps(request)) headers['Strict-Transport-Security'] = HSTS_VALUE;
  return headers;
}

/** Adds the headers to a response. A header the route already set (e.g. the invoice page CSP) is kept. */
export function withSecurityHeaders(request: Request, response: Response): Response {
  const extra = securityHeaders(request);
  const hasCsp = response.headers.has('Content-Security-Policy') || response.headers.has(CSP_HEADER_NAME);
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(extra)) {
    if (name === CSP_HEADER_NAME && hasCsp) continue;
    if (!out.headers.has(name)) out.headers.set(name, value);
  }
  return out;
}
