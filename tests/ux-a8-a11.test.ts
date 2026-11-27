import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fmtNum, localeFor } from '../lib/format';
import { RECOVERY_FILE_NAME, recoveryCodesText } from '../lib/recovery-codes';

const read = (p: string) => readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('digit rule (UX-A10)', () => {
  it('maps the page language to a locale', () => {
    expect(localeFor('ar')).toBe('ar-EG');
    expect(localeFor('en')).toBe('en-US');
  });
  it('formats counts by page locale', () => {
    expect(fmtNum(1234, 'en')).toBe('1,234');
    expect(fmtNum(1234, 'ar')).toMatch(/^[٠-٩٬٫]+$/);
    expect(fmtNum(Number.NaN, 'en')).toBe('—');
  });
});

describe('recovery codes file (UX-A8)', () => {
  it('writes one code per line and drops blanks', () => {
    expect(recoveryCodesText(['aaaa-1111', ' bbbb-2222 ', ''])).toBe('aaaa-1111\nbbbb-2222\n');
    expect(RECOVERY_FILE_NAME).toMatch(/\.txt$/);
  });
});

describe('source checks', () => {
  const app = read('app/wasl-app.tsx');
  it('the provider strip heading has no endorsement wording (UX-A11)', () => {
    expect(app).not.toMatch(/t\.trusted/);
    const heads = [...app.matchAll(/\bsources(?:Note)?: "([^"]*)"/g)].map(m => m[1]);
    expect(heads.length).toBe(4);
    for (const h of heads) expect(h).not.toMatch(/trusted|designed for|مصمم|موثوق|يثق/i);
  });
  it('the fake slider counter is hidden from assistive tech (UX-A11)', () => {
    expect(app).toMatch(/<span aria-hidden="true">01 \/ 04<\/span>/);
    expect(app).toMatch(/aria-hidden="true" lang="en">SCROLL TO EXPLORE/);
  });
  it('admin lists are real tables with captions (UX-A8)', () => {
    const admin = read('components/admin.tsx');
    expect((admin.match(/<DataTable /g) ?? []).length).toBe(3);
    expect(read('components/data-table.tsx')).toMatch(/<caption/);
    expect(read('components/data-table.tsx')).toMatch(/scope="col"/);
  });
  it('MFA enrol does not autofocus the code field and has copy and download (UX-A8)', () => {
    const mfa = read('components/mfa.tsx');
    expect(mfa).toMatch(/autoFocus=\{status\.enrolled\}/);
    expect(mfa).toMatch(/navigator\.clipboard/);
    expect(mfa).toMatch(/RECOVERY_FILE_NAME/);
  });
  it('dashboard model ids are isolated (UX-A9)', () => {
    const dash = read('components/dashboard.tsx');
    expect(dash).toMatch(/<bdi dir="ltr">\{u\.model\}<\/bdi>/);
    expect(dash).toMatch(/<bdi dir="ltr">\{m\.model\}<\/bdi>/);
    expect(dash).not.toMatch(/\.toLocaleString\(\)/);
  });
});

describe('admin digits and env name (PR 26 review)', () => {
  it('revenue and audit count use fmtNum, the env name sits in code dir=ltr', () => {
    const src = read('components/admin.tsx');
    expect(src).toContain('fmtNum(o.revenueLast30DaysMinor / 100, lang');
    expect(src).toContain("fmtNum(events.length, 'ar')");
    expect(src).toContain('<code dir="ltr">DEFAULT_MARKUP_PERCENT</code>');
  });
});
