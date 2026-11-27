import { describe, expect, it } from 'vitest';
import { openIncidentsHeadline } from '../lib/status-headline';

describe('openIncidentsHeadline', () => {
  it('English: none, one, many', () => {
    expect(openIncidentsHeadline(0, 'en')).toBe('All systems operational');
    expect(openIncidentsHeadline(1, 'en')).toBe('Systems working, one incident is open');
    expect(openIncidentsHeadline(3, 'en')).toBe('Systems working, 3 incidents are open');
  });
  it('Arabic: none, one, two, 3 to 10, 11 and more', () => {
    expect(openIncidentsHeadline(0, 'ar')).toBe('كل الأنظمة تعمل');
    expect(openIncidentsHeadline(1, 'ar')).toContain('حادث مفتوح');
    expect(openIncidentsHeadline(2, 'ar')).toContain('حادثان مفتوحان');
    expect(openIncidentsHeadline(5, 'ar')).toContain('5 حوادث مفتوحة');
    expect(openIncidentsHeadline(12, 'ar')).toContain('12 حادثًا مفتوحًا');
  });
});
