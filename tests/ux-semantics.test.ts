import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { langCookie, langDir, langFromCookieHeader, parseLang } from '../lib/lang';
import { nextTabIndex } from '../lib/tabs';

const read = (p: string) => readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('page language cookie (UX-A4)', () => {
  it('accepts ar or en only', () => {
    expect(parseLang('en')).toBe('en');
    expect(parseLang('ar')).toBe('ar');
    for (const bad of ['EN', 'fr', '', ' en', 'en;x', '<script>', '__proto__', null, undefined]) expect(parseLang(bad as string | null | undefined)).toBe('ar');
  });
  it('reads wasl_lang from a cookie header', () => {
    expect(langFromCookieHeader('a=1; wasl_lang=en; b=2')).toBe('en');
    expect(langFromCookieHeader('wasl_lang=ar')).toBe('ar');
    expect(langFromCookieHeader('wasl_lang=de')).toBeNull();
    expect(langFromCookieHeader('xwasl_lang=en')).toBeNull();
    expect(langFromCookieHeader('')).toBeNull();
    expect(langFromCookieHeader(null)).toBeNull();
  });
  it('maps language to direction and builds the cookie', () => {
    expect(langDir('ar')).toBe('rtl');
    expect(langDir('en')).toBe('ltr');
    expect(langCookie('en', false)).toBe('wasl_lang=en; Path=/; Max-Age=31536000; SameSite=Lax');
    expect(langCookie('ar', true)).toMatch(/; Secure$/);
  });
  it('the layout renders lang and dir from the cookie and the language effect writes it', () => {
    const layout = read('app/layout.tsx');
    expect(layout).toContain('serverLang()');
    expect(layout).toContain('<html lang={lang} dir={langDir(lang)}>');
    expect(layout).not.toContain('<script');
    expect(read('app/wasl-app.tsx')).toContain('document.cookie = langCookie(');
  });
});

describe('tab keys (UX-A5)', () => {
  it('moves with arrows, wraps, and flips in RTL', () => {
    expect(nextTabIndex('ArrowRight', 0, 3, { rtl: false })).toBe(1);
    expect(nextTabIndex('ArrowRight', 0, 3, { rtl: true })).toBe(2);
    expect(nextTabIndex('ArrowLeft', 0, 3, { rtl: false })).toBe(2);
    expect(nextTabIndex('ArrowLeft', 0, 3, { rtl: true })).toBe(1);
    expect(nextTabIndex('Home', 2, 3, { rtl: false })).toBe(0);
    expect(nextTabIndex('End', 0, 3, { rtl: false })).toBe(2);
  });
  it('Up and Down only work in a vertical list; other keys are ignored', () => {
    expect(nextTabIndex('ArrowDown', 0, 3, { rtl: false })).toBeNull();
    expect(nextTabIndex('ArrowDown', 0, 3, { rtl: false, vertical: true })).toBe(1);
    expect(nextTabIndex('ArrowUp', 0, 3, { rtl: true, vertical: true })).toBe(2);
    expect(nextTabIndex('Enter', 0, 3, { rtl: false })).toBeNull();
    expect(nextTabIndex('ArrowRight', 0, 0, { rtl: false })).toBeNull();
  });
});

describe('semantics in the source (UX-A5)', () => {
  const explorer = read('components/catalog-explorer.tsx');
  it('model cards are not role=button and the modals use the shared Dialog', () => {
    expect(explorer).not.toContain('role="button"');
    expect(explorer).not.toContain('role="dialog"');
    expect(explorer).toContain('className="catalog-card-open"');
    expect(explorer).toContain("import Dialog from './dialog'");
    expect(explorer).not.toContain('aria-label="Close"');
  });
  it('filter toggles and tabs report their state', () => {
    expect(explorer).toContain('aria-pressed={free}');
    expect(explorer).toContain('aria-pressed={tools}');
    expect(explorer).toContain('aria-pressed={savedOnly}');
    expect(explorer).toContain('role="tablist"');
    expect(read('components/discovery.tsx')).toContain('role="tab"');
    for (const f of ['components/dashboard.tsx', 'components/admin.tsx']) {
      const src = read(f);
      expect(src, f).toContain('role="tablist"');
      expect(src, f).toContain('aria-selected=');
      expect(src, f).toContain('role="tabpanel"');
    }
  });
  it('no browser confirm() is left and the docs fake link is a button', () => {
    for (const f of ['components/dashboard.tsx', 'components/admin.tsx']) expect(read(f), f).not.toMatch(/(^|[^\w.])confirm\(/m);
    expect(read('app/wasl-app.tsx')).not.toContain('<a href="#"');
  });
  it('the demo chat has a live region and a key hint', () => {
    const app = read('app/wasl-app.tsx');
    expect(app).toContain('role="status"');
    expect(app).toContain('id="chat-hint"');
  });
});
