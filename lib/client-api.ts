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

export type SessionUser = { id: string; email: string; name: string; role: 'customer' | 'support' | 'admin' | 'super_admin'; provider: 'password' | 'chatgpt'; emailVerified: boolean };
/** Staff only: epoch milliseconds when the idle and absolute limits end, and the server clock when this was sent. */
export type SessionLimits = { idleEndsAt: number; absoluteEndsAt: number; now: number };
export type SessionInfo = { user: SessionUser | null; features: { inference: boolean; billing: boolean; email: boolean; chatgpt?: boolean }; sessionLimits?: SessionLimits };

export function usd(micro: number, digits = 2): string {
  return `$${(micro / 1_000_000).toFixed(digits)}`;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
