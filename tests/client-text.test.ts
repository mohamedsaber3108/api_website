import { describe, expect, it } from 'vitest';
import { ApiError, errorMessage, rateLimitedText } from '../lib/client-api';
import { limitMessage } from '../lib/server/ratelimit';

const hasArabic = (s: string) => /[\u0600-\u06FF]/.test(s);
const hasLatin = (s: string) => /[A-Za-z]/.test(s);

describe('429 text shown to people: one language, seconds isolated', () => {
  it('Arabic page: Arabic only', () => {
    const t = rateLimitedText(12, 'ar');
    expect(t).toBe('طلبات كثيرة. انتظر \u206812\u2069 ثانية ثم حاول مرة أخرى.');
    expect(hasLatin(t)).toBe(false);
  });
  it('English page: English only', () => {
    const t = rateLimitedText(12, 'en');
    expect(t).toBe('Too many requests. Please wait \u206812\u2069 seconds and try again.');
    expect(hasArabic(t)).toBe(false);
  });
  it('errorMessage maps a rate_limited ApiError by page language, never the combined API text', () => {
    const e = new ApiError(limitMessage(7), 429, 'rate_limited', { retry_after: 7 });
    expect(hasLatin(errorMessage(e, 'ar'))).toBe(false);
    expect(hasArabic(errorMessage(e, 'en'))).toBe(false);
    expect(errorMessage(e, 'en')).toContain('\u20687\u2069');
  });
  it('other errors keep their own message; a bad wait falls back to 1 second', () => {
    expect(errorMessage(new ApiError('Nope', 400, 'bad'), 'ar')).toBe('Nope');
    expect(errorMessage(new ApiError('x', 429, 'rate_limited', {}), 'en')).toContain('\u20681\u2069');
  });
  it('the server text for API users still carries both languages', () => {
    const t = limitMessage(5);
    expect(hasArabic(t) && hasLatin(t)).toBe(true);
  });
});
