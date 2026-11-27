// FEAT-1: one source of truth for the docs samples, the documented error codes and the onboarding steps.
// The docs page (components/docs-samples.tsx), the OpenAPI route and tests/docs-samples.test.ts all read this module.
// No imports on purpose: scripts/docs-samples-smoke.mjs loads it with node --experimental-strip-types.

export const KEY_PLACEHOLDER = 'wasl_xxx';
export const DEFAULT_MODEL = 'openai/gpt-4.1';

export type SampleLang = 'curl' | 'js' | 'python';
export const SAMPLE_LANGS: readonly SampleLang[] = ['curl', 'js', 'python'];

/** Endpoints that exist in the OpenAPI document. */
export type OpenApiEndpoint = 'chat' | 'balance' | 'usage' | 'models';
/** Samples: the stream sample is the same OpenAPI operation as chat, with stream=true. */
export type EndpointId = OpenApiEndpoint | 'chat-stream';
export const ENDPOINT_IDS: readonly EndpointId[] = ['chat', 'chat-stream', 'balance', 'usage', 'models'];

export type EndpointDoc = {
  method: 'GET' | 'POST';
  path: string;
  openapi: OpenApiEndpoint;
  auth: boolean;
  scope?: 'chat' | 'usage';
  query?: Record<string, string>;
  stream?: boolean;
  en: string;
  ar: string;
};

export const ENDPOINTS: Record<EndpointId, EndpointDoc> = {
  chat: { method: 'POST', path: '/chat/completions', openapi: 'chat', auth: true, scope: 'chat', en: 'Chat completion', ar: 'محادثة' },
  'chat-stream': { method: 'POST', path: '/chat/completions', openapi: 'chat', auth: true, scope: 'chat', stream: true, en: 'Chat completion (stream)', ar: 'محادثة بالبث' },
  balance: { method: 'GET', path: '/balance', openapi: 'balance', auth: true, scope: 'usage', en: 'Balance', ar: 'الرصيد' },
  usage: { method: 'GET', path: '/usage', openapi: 'usage', auth: true, scope: 'usage', query: { days: '30' }, en: 'Usage', ar: 'الاستخدام' },
  models: { method: 'GET', path: '/models', openapi: 'models', auth: false, query: { limit: '20' }, en: 'Models', ar: 'النماذج' },
};

export function requestBody(id: EndpointId, model: string = DEFAULT_MODEL): Record<string, unknown> | null {
  if (id !== 'chat' && id !== 'chat-stream') return null;
  return { model, messages: [{ role: 'user', content: 'Hello, world!' }], ...(id === 'chat-stream' ? { stream: true } : {}) };
}

export function sampleUrl(id: EndpointId, origin: string): string {
  const e = ENDPOINTS[id];
  const q = e.query ? `?${new URLSearchParams(e.query).toString()}` : '';
  return `${origin.replace(/\/+$/, '')}/api/v1${e.path}${q}`;
}

function py(v: unknown): string {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v === null) return 'None';
  if (typeof v === 'string' || typeof v === 'number') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(py).join(', ')}]`;
  return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${JSON.stringify(k)}: ${py(x)}`).join(', ')}}`;
}

const JS_STREAM_TAIL = [
  'const reader = res.body.getReader();',
  'const decoder = new TextDecoder();',
  'let buffer = "";',
  'for (;;) {',
  '  const { done, value } = await reader.read();',
  '  if (done) break;',
  '  buffer += decoder.decode(value, { stream: true });',
  '  const lines = buffer.split("\\n");',
  '  buffer = lines.pop();',
  '  for (const line of lines) {',
  '    if (!line.startsWith("data:")) continue;',
  '    const data = line.slice(5).trim();',
  '    if (!data || data === "[DONE]") continue;',
  '    const delta = JSON.parse(data).choices?.[0]?.delta?.content;',
  '    if (delta) process.stdout.write(delta);',
  '  }',
  '}',
];

const JS_TAIL: Record<EndpointId, string[]> = {
  chat: ['const data = await res.json();', 'console.log(data.choices[0].message.content);'],
  'chat-stream': JS_STREAM_TAIL,
  balance: ['console.log(await res.json());'],
  usage: ['console.log(await res.json());'],
  models: ['console.log(await res.json());'],
};

const PY_TAIL: Record<EndpointId, string[]> = {
  chat: ['print(res.json()["choices"][0]["message"]["content"])'],
  'chat-stream': [],
  balance: ['print(res.json())'],
  usage: ['print(res.json())'],
  models: ['print(res.json())'],
};

function curlSample(id: EndpointId, url: string, body: Record<string, unknown> | null): string {
  const e = ENDPOINTS[id];
  const parts = [`curl ${e.stream ? '-N ' : ''}"${url}"`];
  if (e.auth) parts.push(`-H "Authorization: Bearer ${KEY_PLACEHOLDER}"`);
  if (body) {
    parts.push('-H "Content-Type: application/json"');
    parts.push(`-d '${JSON.stringify(body, null, 2)}'`);
  }
  return parts.join(' \\\n  ');
}

function jsSample(id: EndpointId, url: string, body: Record<string, unknown> | null): string {
  const e = ENDPOINTS[id];
  const init = [`  method: "${e.method}",`];
  const headers: string[] = [];
  if (e.auth) headers.push(`    "Authorization": "Bearer ${KEY_PLACEHOLDER}",`);
  if (body) headers.push('    "Content-Type": "application/json",');
  if (headers.length) init.push('  headers: {', ...headers, '  },');
  if (body) init.push(`  body: JSON.stringify(${JSON.stringify(body)}),`);
  return [`const res = await fetch("${url}", {`, ...init, '});', 'if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);', ...JS_TAIL[id]].join('\n');
}

function pySample(id: EndpointId, url: string, body: Record<string, unknown> | null): string {
  const e = ENDPOINTS[id];
  const call = e.method === 'POST' ? 'requests.post' : 'requests.get';
  const args = [`    "${url}",`];
  if (e.auth) args.push(`    headers={"Authorization": "Bearer ${KEY_PLACEHOLDER}"},`);
  if (body) args.push(`    json=${py(body)},`);
  if (e.stream) args.push('    stream=True,');
  args.push('    timeout=60,');
  if (e.stream) {
    return [
      'import json',
      'import requests',
      '',
      `with ${call}(`,
      ...args,
      ') as res:',
      '    res.raise_for_status()',
      '    for line in res.iter_lines(decode_unicode=True):',
      '        if not line or not line.startswith("data:"):',
      '            continue',
      '        data = line[5:].strip()',
      '        if data == "[DONE]":',
      '            break',
      '        choices = json.loads(data).get("choices") or []',
      '        delta = choices[0]["delta"].get("content") if choices else None',
      '        if delta:',
      '            print(delta, end="", flush=True)',
    ].join('\n');
  }
  return ['import requests', '', `res = ${call}(`, ...args, ')', 'res.raise_for_status()', ...PY_TAIL[id]].join('\n');
}

/** One copy-paste sample. The key is always the placeholder wasl_xxx. */
export function sample(id: EndpointId, lang: SampleLang, origin: string, model: string = DEFAULT_MODEL): string {
  const url = sampleUrl(id, origin);
  const body = requestBody(id, model);
  if (lang === 'curl') return curlSample(id, url, body);
  if (lang === 'js') return jsSample(id, url, body);
  return pySample(id, url, body);
}

export type ErrorDoc = { status: number; code: string; endpoints: readonly OpenApiEndpoint[]; en: string; ar: string };

const KEYED: readonly OpenApiEndpoint[] = ['chat', 'balance', 'usage'];

/** Every error code the gateway can return. tests/docs-samples.test.ts scans lib/server/gateway.ts and the chat route so a new code cannot be forgotten. Arabic text has no Latin letters on purpose. */
export const ERROR_CODES: readonly ErrorDoc[] = [
  { status: 400, code: 'invalid_json', endpoints: ['chat'], en: 'The request body is not valid JSON.', ar: 'نص الطلب ليس بصيغة صالحة.' },
  { status: 400, code: 'invalid_request', endpoints: ['chat'], en: 'A field is missing or out of range. The message names the field.', ar: 'حقل ناقص أو خارج المدى. تذكر الرسالة اسم الحقل.' },
  { status: 400, code: 'unsupported_model', endpoints: ['chat'], en: 'Only text-output chat models work on this endpoint.', ar: 'تدعم هذه الواجهة نماذج المحادثة النصية فقط.' },
  { status: 401, code: 'invalid_api_key', endpoints: KEYED, en: 'The key is missing, wrong, expired or revoked.', ar: 'المفتاح مفقود أو خاطئ أو منتهٍ أو ملغى.' },
  { status: 402, code: 'insufficient_credits', endpoints: ['chat'], en: 'Available credit is below the most this call could cost. Add credit.', ar: 'الرصيد المتاح أقل من أقصى تكلفة محتملة للطلب. أضف رصيداً.' },
  { status: 402, code: 'spend_limit_reached', endpoints: ['chat'], en: 'The call would pass the spend limit of the account or the key. Raise or clear the limit.', ar: 'سيتجاوز الطلب حدّ الإنفاق للحساب أو للمفتاح. ارفع الحد أو أزله.' },
  { status: 403, code: 'insufficient_scope', endpoints: KEYED, en: 'The key lacks the scope this call needs (chat, or usage for balance and usage).', ar: 'ينقص المفتاح الصلاحية التي يتطلبها الطلب.' },
  { status: 403, code: 'model_disabled', endpoints: ['chat'], en: 'The model is switched off for now.', ar: 'النموذج موقوف مؤقتاً.' },
  { status: 404, code: 'model_not_found', endpoints: ['chat'], en: 'The model id is not in the catalog.', ar: 'معرّف النموذج غير موجود في الكتالوج.' },
  { status: 413, code: 'payload_too_large', endpoints: ['chat'], en: 'The request body is larger than 512,000 bytes.', ar: 'حجم الطلب أكبر من ٥١٢٬٠٠٠ بايت.' },
  { status: 422, code: 'variable_price', endpoints: ['chat'], en: 'The model has a variable price and cannot be metered.', ar: 'سعر النموذج متغيّر ولا يمكن احتسابه.' },
  { status: 429, code: 'rate_limit_exceeded', endpoints: ['chat'], en: 'Too many calls for this key in one minute. Wait for the Retry-After seconds.', ar: 'تجاوز المفتاح حدّ الطلبات في الدقيقة. انتظر المدة المذكورة في الترويسة.' },
  { status: 429, code: 'provider_rate_limited', endpoints: ['chat'], en: 'The model provider is limiting calls. Try again soon. You are not charged.', ar: 'مزوّد النموذج يحدّ الطلبات. أعد المحاولة بعد قليل. لا يُخصم منك شيء.' },
  { status: 429, code: 'rate_limited', endpoints: ['models'], en: 'Too many catalog calls from your address. The body has retry_after in seconds.', ar: 'طلبات كثيرة من عنوانك. انتظر ثم أعد المحاولة.' },
  { status: 500, code: 'internal_error', endpoints: KEYED, en: 'Unexpected server error. Try again later.', ar: 'خطأ غير متوقع في الخادم. أعد المحاولة لاحقاً.' },
  { status: 502, code: 'upstream_error', endpoints: ['chat'], en: 'The model provider returned an error. You are not charged.', ar: 'أعاد مزوّد النموذج خطأً. لا يُخصم منك شيء.' },
  { status: 502, code: 'upstream_unreachable', endpoints: ['chat'], en: 'The model provider could not be reached. You are not charged.', ar: 'تعذّر الوصول إلى مزوّد النموذج. لا يُخصم منك شيء.' },
  { status: 503, code: 'service_not_activated', endpoints: ['chat'], en: 'Paid inference is not switched on for this deployment. The Retry-After header says when to look again.', ar: 'الاستدلال المدفوع غير مفعّل في هذا النشر.' },
  { status: 504, code: 'upstream_unreachable', endpoints: ['chat'], en: 'The model provider timed out. You are not charged.', ar: 'انتهت مهلة مزوّد النموذج. لا يُخصم منك شيء.' },
];

export function statusesFor(endpoint: OpenApiEndpoint): number[] {
  return [...new Set(ERROR_CODES.filter(e => e.endpoints.includes(endpoint)).map(e => e.status))].sort((a, b) => a - b);
}

export function codesFor(endpoint: OpenApiEndpoint, status: number): string[] {
  return ERROR_CODES.filter(e => e.status === status && e.endpoints.includes(endpoint)).map(e => e.code);
}

export type OnboardingStep = { id: string; en: string; ar: string; codes?: readonly string[]; enTail?: string; arTail?: string };

/** Short Arabic and English steps. Inline code is passed separately so the page can isolate it from the RTL text. */
export const ONBOARDING: readonly OnboardingStep[] = [
  { id: 'account', en: 'Create an account.', ar: 'أنشئ حساباً.' },
  { id: 'verify', en: 'Open the email we send and confirm your address.', ar: 'افتح الرسالة التي وصلتك وأكّد بريدك.' },
  { id: 'key', en: 'In the dashboard, create a key with these scopes:', ar: 'من لوحة التحكم، أنشئ مفتاحاً بهاتين الصلاحيتين:', codes: ['chat', 'usage'] },
  { id: 'credit', en: 'Add credit. Calls are paid from your balance.', ar: 'أضف رصيداً. تُخصم الطلبات من رصيدك.' },
  { id: 'call', en: 'Make your first call with a sample below. Replace', ar: 'نفّذ أول طلب بأحد الأمثلة أدناه. استبدل', codes: [KEY_PLACEHOLDER], enTail: 'with your key.', arTail: 'بمفتاحك.' },
  { id: 'limit', en: 'Set a spend limit for the account or for one key.', ar: 'حدّد حدّ إنفاق للحساب أو لمفتاح واحد.' },
];
