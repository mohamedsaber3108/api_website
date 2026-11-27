import { describe, expect, it } from 'vitest';
import { parseLimitUsd } from '../components/spend-limits';
import { creditShortfallFromError } from '../lib/credit-error';

describe('FEAT-2 client text (UX judge b26)', () => {
  it('parses Arabic-Indic and Persian digits and the Arabic decimal mark', () => {
    expect(parseLimitUsd('٢٥')).toBe(25);
    expect(parseLimitUsd('۱۰')).toBe(10);
    expect(parseLimitUsd('١٫٥')).toBe(1.5);
    expect(parseLimitUsd(' 50 ')).toBe(50);
  });

  it('refuses 0, negatives, over 100000, commas and text, so Save stays off and the hint shows', () => {
    for (const bad of ['0', '-5', '100001', '1,5', 'abc', '']) expect(parseLimitUsd(bad)).toBeNull();
    expect(parseLimitUsd('100000')).toBe(100000);
  });

  it('maps spend_limit_reached to one language, with the amounts as separate pieces', () => {
    const err = { code: 'spend_limit_reached', limit_micro_usd: 5_000_000, used_micro_usd: 4_990_000, limit_is_key: 1 };
    const ar = creditShortfallFromError('ar', err)!;
    const en = creditShortfallFromError('en', err)!;
    expect(ar.lead).toContain('المفتاح');
    expect(ar.lead).not.toMatch(/[A-Za-z]/);
    expect(en.lead).toContain('API key');
    expect(en.lead).not.toMatch(/[\u0600-\u06ff]/);
    expect([ar.need, ar.have]).toEqual(['$5.0000', '$4.9900']);
    expect(creditShortfallFromError('en', { ...err, limit_is_key: 0 })!.lead).toContain('account');
  });

  it('falls back to the message when the numbers are missing', () => {
    expect(creditShortfallFromError('en', { code: 'spend_limit_reached' })).toBeNull();
  });
});
