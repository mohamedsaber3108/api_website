export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public data?: unknown) {
    super(message);
  }
}

type Options = { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown };

/** Same-origin JSON call. Throws ApiError with the server's message. */
export async function api<T = unknown>(path: string, { method = 'GET', body }: Options = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string | { message?: string }; code?: string }) | null;
  if (!res.ok) {
    const message = typeof data?.error === 'string' ? data.error : data?.error?.message || `HTTP ${res.status}`;
    throw new ApiError(message, res.status, data?.code, data);
  }
  return data as T;
}

export type SessionUser = { id: string; email: string; name: string; role: 'customer' | 'support' | 'admin'; provider: 'password' | 'chatgpt'; emailVerified: boolean };
export type SessionInfo = { user: SessionUser | null; features: { inference: boolean; billing: boolean; email: boolean; chatgpt?: boolean } };

export function usd(micro: number, digits = 2): string {
  return `$${(micro / 1_000_000).toFixed(digits)}`;
}

/**
 * One-language 429 text. The server sends "English | Arabic" for API users; people see only the page language.
 * The seconds sit inside U+2068 ... U+2069 (an isolate, the plain-text form of <bdi>) so the number keeps its place in Arabic text.
 */
export function rateLimitedText(seconds: number, lang: 'ar' | 'en'): string {
  const s = Math.max(1, Math.ceil(Number(seconds) || 1));
  return lang === 'ar' ? `طلبات كثيرة. انتظر \u2068${s}\u2069 ثانية ثم حاول مرة أخرى.` : `Too many requests. Please wait \u2068${s}\u2069 seconds and try again.`;
}

function pageLang(): 'ar' | 'en' {
  return typeof document !== 'undefined' && document.documentElement.lang === 'en' ? 'en' : 'ar';
}

export function errorMessage(e: unknown, lang: 'ar' | 'en' = pageLang()): string {
  if (e instanceof ApiError && e.code === 'rate_limited') return rateLimitedText((e.data as { retry_after?: number } | null)?.retry_after ?? 1, lang);
  return e instanceof Error ? e.message : String(e);
}
