export type Currency = 'USD' | 'EGP' | 'SAR' | 'AED' | 'EUR';
export type Rates = Record<Currency, number>;
export const SYMBOLS: Record<Currency,string> = { USD:'$', EGP:'ج.م', SAR:'ر.س', AED:'د.إ', EUR:'€' };
export function formatMoney(value: number | null, currency: Currency, rates: Rates, lang: 'ar' | 'en' = 'en') {
  if (value === null || !Number.isFinite(value)) return lang === 'ar' ? 'متغيّر' : 'Variable';
  if (value === 0) return lang === 'ar' ? 'مجاني' : 'Free';
  const n = value * (rates[currency] || 1);
  const digits = n < .01 ? 6 : n < .1 ? 5 : n < 1 ? 4 : n < 10 ? 3 : n < 100 ? 2 : 1;
  return `${SYMBOLS[currency]}${new Intl.NumberFormat('en-US',{maximumFractionDigits:digits,minimumFractionDigits: n < 10 ? Math.min(2,digits) : 0}).format(n)}`;
}
export function contextLabel(n: number) { return !n ? '—' : n >= 1_000_000 ? `${+(n/1_000_000).toFixed(1)}M` : `${Math.round(n/1000)}K`; }
