import { env } from 'cloudflare:workers';

export const TERMS_VERSION = '2026-10-01';
export const SESSION_COOKIE = 'wasl_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** Staff sessions (support, admin, super_admin): end after 30 minutes without activity, or 8 hours after sign-in. */
export const STAFF_IDLE_MS = 30 * 60 * 1000;
export const STAFF_ABSOLUTE_MS = 8 * 3600 * 1000;
/** A staff session's last-seen time is written at most once per 60 seconds. */
export const STAFF_TOUCH_MS = 60 * 1000;
export const MICRO = 1_000_000;

/** Top-up packages offered at checkout (USD). */
export const CREDIT_PACKAGES = [5, 10, 25, 50, 100] as const;

/**
 * Fail safe: anything other than an explicit APP_ENV=development is treated as production,
 * so dev helpers (auth tokens echoed in responses) can never leak from a misconfigured deploy.
 */
export function isProduction() {
  return env.APP_ENV !== 'development';
}

/** Hosts the development override may point at (FU-22). `new URL('http://[::1]').hostname` is `[::1]`. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/** Provider API base. OPENROUTER_BASE_URL is honoured ONLY when APP_ENV=development AND it is an http(s) URL on a loopback host (PERF-1 stub provider). Anything else, and production always, uses OpenRouter. */
export function providerBaseUrl(): string {
  const override = (env as unknown as Record<string, string | undefined>).OPENROUTER_BASE_URL;
  if (!isProduction() && override) {
    try {
      const u = new URL(override);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname)) return override.replace(/\/+$/, '');
    } catch { /* not a URL: use OpenRouter */ }
  }
  return 'https://openrouter.ai/api/v1';
}

export function adminEmails(): Set<string> {
  return new Set((env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

/** Off unless exactly "true". Lets ADMIN_EMAILS grant `admin` (never super_admin) even after a super_admin exists. Every use is audited and needs MFA. */
export function adminEmailsBreakGlass(): boolean {
  return env.ADMIN_EMAILS_BREAKGLASS === 'true';
}

export function defaultMarkupPercent(): number {
  const n = Number(env.DEFAULT_MARKUP_PERCENT);
  return Number.isFinite(n) && n >= 0 && n <= 500 ? n : 20;
}

export function signupBonusMicroUsd(): number {
  const n = Number(env.SIGNUP_BONUS_USD);
  return Number.isFinite(n) && n > 0 && n <= 100 ? Math.round(n * MICRO) : 0;
}

/**
 * Which payment provider is active, or null (billing off). PAYMENT_PROVIDER unset or "stripe": Stripe when both keys are set.
 * "stub": local stub, only when APP_ENV=development (never in production). Any other value: off.
 */
export function paymentProvider(): 'stripe' | 'stub' | null {
  const wanted = (env.PAYMENT_PROVIDER || '').trim().toLowerCase();
  if (wanted === 'stub') return isProduction() ? null : 'stub';
  if (wanted !== '' && wanted !== 'stripe') return null;
  return env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET ? 'stripe' : null;
}

export const features = {
  inference: () => env.INFERENCE_ENABLED === 'true' && !!env.OPENROUTER_API_KEY,
  billing: () => paymentProvider() !== null,
  email: () => !!env.RESEND_API_KEY && !!env.EMAIL_FROM,
  /** Trust `oai-authenticated-*` identity headers. Only for the ChatGPT hosting platform. */
  chatgptIdentity: () => env.TRUST_CHATGPT_HEADERS === 'true',
};

export function baseUrl(request: Request): string {
  const configured = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return configured || new URL(request.url).origin;
}
