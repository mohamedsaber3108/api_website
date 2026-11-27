/**
 * Page language cookie (UX-A4). The client writes `wasl_lang` when the language changes;
 * the server reads it to render <html lang dir> on first paint. Only "ar" or "en" is accepted.
 * Pure functions, no framework imports, so they can be unit tested.
 */
export type Lang = 'ar' | 'en';

export const LANG_COOKIE = 'wasl_lang';
export const DEFAULT_LANG: Lang = 'ar';

export const isLang = (v: unknown): v is Lang => v === 'ar' || v === 'en';

/** A bare value (for example a cookie value) to a language. Anything else is Arabic. */
export const parseLang = (v: string | null | undefined): Lang => (isLang(v) ? v : DEFAULT_LANG);

/** Reads `wasl_lang` out of a Cookie header or document.cookie. Null when absent or not ar/en. */
export function langFromCookieHeader(header: string | null | undefined): Lang | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== LANG_COOKIE) continue;
    const value = part.slice(i + 1).trim();
    return isLang(value) ? value : null;
  }
  return null;
}

export const langDir = (lang: Lang): 'rtl' | 'ltr' => (lang === 'ar' ? 'rtl' : 'ltr');

/** Cookie string for document.cookie. One year, not HttpOnly (the client sets it), Secure on https. */
export function langCookie(lang: Lang, secure: boolean): string {
  return `${LANG_COOKIE}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`;
}
