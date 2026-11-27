import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CSP_HEADER_NAME, CSP_VALUE, HSTS_VALUE, securityHeaders, withSecurityHeaders } from '../lib/server/security-headers';

const root = join(__dirname, '..');
const css = readFileSync(join(root, 'app/globals.css'), 'utf8');
const licences = readFileSync(join(root, 'public/fonts/LICENSES.md'), 'utf8');

describe('self-hosted fonts', () => {
  it('the stylesheet makes no request to Google font hosts', () => {
    expect(css).not.toMatch(/googleapis|gstatic/i);
    expect(css).not.toMatch(/@import\s+url\(['"]?https?:/i);
  });
  it('every @font-face file exists under public/fonts, is listed in LICENSES.md, and uses font-display swap', () => {
    const faces = css.match(/@font-face\{[^}]*\}/g) ?? [];
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      const file = face.match(/url\(\/fonts\/([^)]+)\)/)?.[1];
      expect(file, face).toBeTruthy();
      expect(existsSync(join(root, 'public/fonts', file!)), file).toBe(true);
      expect(licences, file).toContain(file!);
      expect(face).toContain('font-display:swap');
      expect(face).toContain('unicode-range:');
    }
  });
});

describe('security headers', () => {
  const http = new Request('http://example.test/');
  const https = new Request('https://example.test/');

  it('sends the CSP with the required directives and no unsafe-eval', () => {
    const csp = securityHeaders(http)[CSP_HEADER_NAME];
    expect(csp).toBe(CSP_VALUE);
    for (const d of ["default-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "img-src 'self' data:", "font-src 'self'", "connect-src 'self'"]) {
      expect(csp).toContain(d);
    }
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/https?:/);
  });
  it('keeps nosniff and referrer policy', () => {
    const h = securityHeaders(http);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });
  it('sends HSTS only for https', () => {
    expect(securityHeaders(http)['Strict-Transport-Security']).toBeUndefined();
    expect(securityHeaders(https)['Strict-Transport-Security']).toBe(HSTS_VALUE);
    expect(HSTS_VALUE).toBe('max-age=15552000');
    const proxied = new Request('http://example.test/', { headers: { 'x-forwarded-proto': 'https' } });
    expect(securityHeaders(proxied)['Strict-Transport-Security']).toBe(HSTS_VALUE);
    const proxiedHttp = new Request('https://example.test/', { headers: { 'x-forwarded-proto': 'http' } });
    expect(securityHeaders(proxiedHttp)['Strict-Transport-Security']).toBeUndefined();
  });
  it('adds headers to a response and keeps a CSP the route already set', () => {
    const plain = withSecurityHeaders(http, new Response('x'));
    expect(plain.headers.get(CSP_HEADER_NAME)).toBe(CSP_VALUE);
    const own = withSecurityHeaders(http, new Response('x', { headers: { 'Content-Security-Policy': "default-src 'none'" } }));
    expect(own.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
    expect(own.headers.get(CSP_HEADER_NAME)).toBeNull();
  });
});
