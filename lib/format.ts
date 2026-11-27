export type Lang = 'ar' | 'en';

/** One digit rule: the page locale decides. Arabic pages use ar-EG, English pages use en-US. */
export const localeFor = (lang: Lang): string => (lang === 'ar' ? 'ar-EG' : 'en-US');

export function fmtNum(n: number, lang: Lang, opts?: Intl.NumberFormatOptions): string {
  return Number.isFinite(n) ? n.toLocaleString(localeFor(lang), opts) : '—';
}
