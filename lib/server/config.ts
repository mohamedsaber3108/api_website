import { env } from 'cloudflare:workers';

export const TERMS_VERSION = '2026-10-01';
export const SESSION_COOKIE = 'wasl_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
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

export function adminEmails(): Set<string> {
  return new Set((env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

export function defaultMarkupPercent(): number {
  const n = Number(env.DEFAULT_MARKUP_PERCENT);
  return Number.isFinite(n) && n >= 0 && n <= 500 ? n : 20;
}

export function signupBonusMicroUsd(): number {
  const n = Number(env.SIGNUP_BONUS_USD);
  return Number.isFinite(n) && n > 0 && n <= 100 ? Math.round(n * MICRO) : 0;
}

export const features = {
  inference: () => env.INFERENCE_ENABLED === 'true' && !!env.OPENROUTER_API_KEY,
  billing: () => !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET,
  email: () => !!env.RESEND_API_KEY && !!env.EMAIL_FROM,
  /** Trust `oai-authenticated-*` identity headers. Only for the ChatGPT hosting platform. */
  chatgptIdentity: () => env.TRUST_CHATGPT_HEADERS === 'true',
};

export function baseUrl(request: Request): string {
  const configured = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return configured || new URL(request.url).origin;
}
