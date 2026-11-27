import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GET as openapiGet } from '../app/api/v1/openapi.json/route';
import { ENDPOINT_IDS, ENDPOINTS, ERROR_CODES, KEY_PLACEHOLDER, ONBOARDING, SAMPLE_LANGS, requestBody, sample } from '../lib/docs-samples';

type Op = { security?: unknown[]; description?: string; parameters?: { name: string; in: string }[]; responses: Record<string, Record<string, unknown>> };
type Spec = { paths: Record<string, Record<string, Op>>; components: { schemas: { ChatRequest: { required: string[]; properties: Record<string, unknown> } } } };

const root = path.resolve(__dirname, '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
const ORIGIN = 'http://localhost:8799';
let spec: Spec;

beforeAll(async () => {
  spec = (await openapiGet(new Request(`${ORIGIN}/api/v1/openapi.json`)).json()) as Spec;
});

describe('FEAT-1 docs samples match the OpenAPI document', () => {
  for (const id of ENDPOINT_IDS) {
    for (const lang of SAMPLE_LANGS) {
      it(`${id} / ${lang}: method, path, key, query and body fields`, () => {
        const e = ENDPOINTS[id];
        const op = spec.paths[e.path]?.[e.method.toLowerCase()];
        expect(op, `${e.method} ${e.path} is in OpenAPI`).toBeDefined();
        const text = sample(id, lang, ORIGIN);
        expect(text).toContain(`${ORIGIN}/api/v1${e.path}`);
        if (lang === 'curl') expect(text.includes(" -d '")).toBe(e.method === 'POST');
        if (lang === 'js') expect(text).toContain(`method: "${e.method}"`);
        if (lang === 'python') expect(text).toContain(e.method === 'POST' ? 'requests.post(' : 'requests.get(');
        // key: placeholder only, and only where OpenAPI says the call is secured
        expect(Boolean(op.security?.length)).toBe(e.auth);
        expect(text.includes(`Bearer ${KEY_PLACEHOLDER}`)).toBe(e.auth);
        if (e.scope) expect(op.description).toContain(`"${e.scope}" scope`);
        for (const k of Object.keys(e.query ?? {})) {
          expect(op.parameters?.some(p => p.name === k && p.in === 'query'), `query ${k} in OpenAPI`).toBe(true);
          expect(text).toContain(`${k}=`);
        }
        const body = requestBody(id);
        if (body) {
          const schema = spec.components.schemas.ChatRequest;
          for (const f of schema.required) expect(text, `required field ${f}`).toContain(`"${f}"`);
          for (const k of Object.keys(body)) expect(Object.keys(schema.properties), `body field ${k}`).toContain(k);
          if (e.stream) expect(text).toMatch(/"stream":\s*(true|True)/);
          else expect(text).not.toContain('stream');
        }
      });
    }
  }

  it('never contains a real-looking key', () => {
    for (const id of ENDPOINT_IDS) for (const lang of SAMPLE_LANGS) {
      const text = sample(id, lang, ORIGIN);
      expect(text).not.toMatch(/wasl_[a-f0-9]{16,}/);
      expect(text).not.toContain('sk-or');
    }
  });

  it('JavaScript samples are valid syntax', () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (code: string) => unknown;
    for (const id of ENDPOINT_IDS) expect(() => new AsyncFunction(sample(id, 'js', ORIGIN)), id).not.toThrow();
  });
});

describe('FEAT-1 error codes', () => {
  it('every documented status and code is in OpenAPI for its endpoint', () => {
    const op = { chat: spec.paths['/chat/completions'].post, balance: spec.paths['/balance'].get, usage: spec.paths['/usage'].get, models: spec.paths['/models'].get };
    for (const c of ERROR_CODES) for (const ep of c.endpoints) {
      const r = op[ep].responses[String(c.status)];
      expect(r, `${ep} ${c.status}`).toBeDefined();
      expect(r['x-error-codes'], `${ep} ${c.status} codes`).toContain(c.code);
    }
  });

  it('every GatewayError code in the source is documented', () => {
    const documented = new Set(ERROR_CODES.map(c => c.code));
    const sources = [read('lib/server/gateway.ts'), read('app/api/v1/chat/completions/route.ts')].join('\n');
    const found = new Set<string>();
    for (const m of sources.matchAll(/new GatewayError\(([^;]*);/g)) for (const lit of m[1].matchAll(/'([a-z]+(?:_[a-z]+)+)'/g)) found.add(lit[1]);
    expect(found.size).toBeGreaterThan(10);
    for (const code of found) expect(documented, `undocumented code ${code}`).toContain(code);
  });

  it('every documented code exists in the source', () => {
    const sources = [read('lib/server/gateway.ts'), read('app/api/v1/chat/completions/route.ts'), read('lib/server/ratelimit.ts')].join('\n');
    for (const c of ERROR_CODES) expect(sources, c.code).toContain(`'${c.code}'`);
  });

  it('Arabic texts have no Latin letters (so no bidi mixing)', () => {
    for (const c of ERROR_CODES) expect(c.ar, c.code).not.toMatch(/[A-Za-z]/);
    for (const s of ONBOARDING) expect([s.ar, s.arTail ?? ''].join(' '), s.id).not.toMatch(/[A-Za-z]/);
  });
});

describe('FEAT-1 docs page wiring', () => {
  it('the page renders the shared lists and the old key placeholder is gone', () => {
    const page = read('app/wasl-app.tsx');
    for (const tag of ['<OnboardingChecklist', '<DocsSamples', '<ErrorCodes']) expect(page).toContain(tag);
    expect(page).not.toContain('YOUR_WASL_API_KEY');
    const comp = read('components/docs-samples.tsx');
    for (const part of ['ERROR_CODES.map', 'ONBOARDING.map', 'ENDPOINT_IDS.map', 'SAMPLE_LANGS.map']) expect(comp).toContain(part);
  });

  it('the checklist has the six steps in order, in both languages', () => {
    expect(ONBOARDING.map(s => s.id)).toEqual(['account', 'verify', 'key', 'credit', 'call', 'limit']);
    for (const s of ONBOARDING) { expect(s.ar.length).toBeGreaterThan(3); expect(s.en.length).toBeGreaterThan(3); }
  });
});
