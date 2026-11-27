import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GET as openapiGet } from '../app/api/v1/openapi.json/route';
import { ENDPOINT_IDS, ENDPOINTS, ERROR_CODES, ERROR_NOTES, KEY_PLACEHOLDER, ONBOARDING, SAMPLE_LANGS, requestBody, sample } from '../lib/docs-samples';

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

  it('every literal status and code pair in the gateway matches the documented status (PR 33 review)', () => {
    const sources = [read('lib/server/gateway.ts'), read('app/api/v1/chat/completions/route.ts')].join('\n');
    const pairs = [...sources.matchAll(/new GatewayError\((\d{3}), '([a-z_]+)'/g)].map(m => [Number(m[1]), m[2]] as const);
    expect(pairs.length).toBeGreaterThan(10);
    for (const [status, code] of pairs) {
      const docs = ERROR_CODES.filter(c => c.code === code).map(c => c.status);
      expect(docs, code + ' documented with status ' + status).toContain(status);
    }
    // The upstream_unreachable status is chosen at run time (504 on timeout, else 502): both must be documented.
    const unreachable = ERROR_CODES.filter(c => c.code === 'upstream_unreachable').map(c => c.status);
    expect(unreachable).toEqual(expect.arrayContaining([502, 504]));
  });

  it('the /models 429 has the flat public body and a Retry-After header', () => {
    const r = spec.paths['/models'].get.responses['429'] as { headers?: Record<string, unknown>; content?: Record<string, { schema: { properties: Record<string, unknown> } }> };
    expect(r.headers).toHaveProperty('Retry-After');
    expect(Object.keys(r.content!['application/json'].schema.properties).sort()).toEqual(['code', 'error', 'retry_after']);
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

describe('FU-23 provider passthrough, fallback code and 402 fields', () => {
  it('upstream_error is documented for the passed-through 4xx statuses and for 502, in OpenAPI too', () => {
    const statuses = ERROR_CODES.filter(c => c.code === 'upstream_error').map(c => c.status);
    expect(statuses).toEqual(expect.arrayContaining([400, 403, 404, 413, 422, 502]));
    const chat = spec.paths['/chat/completions'].post.responses;
    for (const s of [400, 403, 404, 413, 422, 502]) expect(chat[String(s)]['x-error-codes'], String(s)).toContain('upstream_error');
  });
  it('the gateway really passes the provider status through and has the fallback code', () => {
    const gw = read('lib/server/gateway.ts');
    expect(gw).toContain("status === 429 ? 'provider_rate_limited' : 'upstream_error'");
    expect(gw).toContain("e.code ?? 'error'");
  });
  it('the notes name upstream_error and the fallback code error, and their Arabic has no Latin letters', () => {
    const codes = ERROR_NOTES.flatMap(n => n.codes ?? []);
    expect(codes).toEqual(expect.arrayContaining(['upstream_error', 'error']));
    for (const n of ERROR_NOTES) expect(n.ar, n.id).not.toMatch(/[A-Za-z]/);
  });
  it('the 402 extra fields are documented, sent by the gateway, and in the OpenAPI Error schema', () => {
    const gw = read('lib/server/gateway.ts');
    const fields = (code: string) => ERROR_CODES.find(c => c.code === code)?.extra ?? [];
    expect(fields('insufficient_credits')).toEqual(['need_micro_usd', 'available_micro_usd']);
    expect(fields('spend_limit_reached')).toEqual(['limit_micro_usd', 'used_micro_usd', 'limit_is_key']);
    const all = [...fields('insufficient_credits'), ...fields('spend_limit_reached')];
    const schema = (spec.components.schemas as unknown as { Error: { properties: { error: { properties: Record<string, unknown> } } } }).Error.properties.error.properties;
    for (const f of all) { expect(gw, f).toContain(f); expect(Object.keys(schema), f).toContain(f); }
    expect(ERROR_NOTES.find(n => n.id === 'fields-402')?.codes).toEqual(all);
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
