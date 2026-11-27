/** Why the sign-in page is shown. Only keys listed here are accepted from the URL (?reason=...); raw input is never shown. */
export const SESSION_REASONS = {
  session_ended: {
    ar: 'انتهت جلستك. سجّل الدخول من جديد للمتابعة.',
    en: 'Your session has ended. Sign in again to continue.',
  },
} as const;

export type SessionReason = keyof typeof SESSION_REASONS;

/** Reads `?reason=` from a query string. Returns a known key or null. */
export function sessionReasonFrom(search: string): SessionReason | null {
  const v = new URLSearchParams(search).get('reason');
  return v !== null && Object.prototype.hasOwnProperty.call(SESSION_REASONS, v) ? (v as SessionReason) : null;
}

export const loginUrl = (reason?: SessionReason) => (reason ? `/login?reason=${reason}` : '/login');
