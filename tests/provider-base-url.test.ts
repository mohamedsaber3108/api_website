import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { providerBaseUrl } from '../lib/server/config';

const OPENROUTER = 'https://openrouter.ai/api/v1';
const bag = env as Record<string, unknown>;

afterEach(() => {
  delete bag.APP_ENV;
  delete bag.OPENROUTER_BASE_URL;
});

function use(appEnv: string | undefined, url: string | undefined) {
  if (appEnv === undefined) delete bag.APP_ENV; else bag.APP_ENV = appEnv;
  if (url === undefined) delete bag.OPENROUTER_BASE_URL; else bag.OPENROUTER_BASE_URL = url;
  return providerBaseUrl();
}

describe('FU-22 providerBaseUrl', () => {
  it('development + loopback host: the override is used (trailing slash removed)', () => {
    expect(use('development', 'http://127.0.0.1:8801/api/v1')).toBe('http://127.0.0.1:8801/api/v1');
    expect(use('development', 'http://localhost:8801/api/v1/')).toBe('http://localhost:8801/api/v1');
    expect(use('development', 'http://[::1]:8801/api/v1')).toBe('http://[::1]:8801/api/v1');
  });
  it('development + any other host: ignored', () => {
    expect(use('development', 'http://example.com/api/v1')).toBe(OPENROUTER);
    expect(use('development', 'http://127.0.0.1.evil.com/api/v1')).toBe(OPENROUTER);
    expect(use('development', 'http://localhost@evil.com/api/v1')).toBe(OPENROUTER);
    expect(use('development', 'http://10.0.0.5:8801/api/v1')).toBe(OPENROUTER);
  });
  it('production, unset or other APP_ENV: always OpenRouter', () => {
    expect(use('production', 'http://127.0.0.1:8801/api/v1')).toBe(OPENROUTER);
    expect(use(undefined, 'http://127.0.0.1:8801/api/v1')).toBe(OPENROUTER);
    expect(use('staging', 'http://127.0.0.1:8801/api/v1')).toBe(OPENROUTER);
  });
  it('non-http scheme or a value that is not a URL: ignored', () => {
    expect(use('development', 'ftp://127.0.0.1/api/v1')).toBe(OPENROUTER);
    expect(use('development', 'file://localhost/etc/passwd')).toBe(OPENROUTER);
    expect(use('development', 'not a url')).toBe(OPENROUTER);
  });
  it('development without an override: OpenRouter', () => {
    expect(use('development', undefined)).toBe(OPENROUTER);
  });
});
