import { describe, expect, it } from 'vitest';
import { creditShortfall, creditShortfallFromError } from '../lib/credit-error';

describe('402 insufficient_credits mapper', () => {
  it('Arabic: one language only, amounts in dollars, one link to /dashboard', () => {
    const s = creditShortfall('ar', 1_234_000, 500_000);
    expect(s.lead).toBe('رصيدك غير كافٍ لهذا الطلب. قد تصل تكلفته إلى ');
    expect(s.need).toBe('$1.2340');
    expect(s.mid).toBe(' والمتاح ');
    expect(s.have).toBe('$0.5000');
    expect(s.linkLabel).toBe('أضف رصيداً');
    expect(s.href).toBe('/dashboard');
    expect(`${s.lead}${s.mid}${s.tail}${s.linkLabel}`).not.toMatch(/[A-Za-z]/);
  });
  it('English: one language only', () => {
    const s = creditShortfall('en', 1_234_000, 500_000);
    expect(s.lead).toBe('Your balance is too low for this request. It can cost up to ');
    expect(s.mid).toBe('; available ');
    expect(s.linkLabel).toBe('Add credit');
    expect(`${s.lead}${s.mid}${s.tail}${s.linkLabel}`).not.toMatch(/[\u0600-\u06FF]/);
  });
  it('reads the error body and falls back (null) when numbers or code are missing', () => {
    expect(creditShortfallFromError('en', { code: 'insufficient_credits', need_micro_usd: 10, available_micro_usd: 0 })?.need).toBe('$0.0000');
    expect(creditShortfallFromError('en', { code: 'insufficient_credits' })).toBeNull();
    expect(creditShortfallFromError('en', { code: 'other', need_micro_usd: 1, available_micro_usd: 1 })).toBeNull();
    expect(creditShortfallFromError('en', undefined)).toBeNull();
  });
});
