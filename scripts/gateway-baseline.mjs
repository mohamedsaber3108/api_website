// PERF-1: how much time does Wasl itself add to one chat completion call?
// The provider is a local stub, so no real provider and no money is used.
//
// Setup (once): start the LOCAL dev server the same way as for scripts/smoke-test.mjs, with these extra
// variables in the file the dev server reads (see docs/perf-baseline.md):
//   APP_ENV=development  INFERENCE_ENABLED=true  OPENROUTER_API_KEY=stub-key  SIGNUP_BONUS_USD=100
//   OPENROUTER_BASE_URL=http://127.0.0.1:8801/api/v1      (same port as --stub-port)
//
// Usage:
//   node scripts/gateway-baseline.mjs --base http://127.0.0.1:8799 [--n 200] [--c 1,10] [--delay 50]
//        [--stub-port 8801] [--model minimax/minimax-m3.1-flash] [--out perf.md]
//
// What it does: starts the stub (answers like OpenRouter, fixed JSON, also SSE), creates one account and API
// keys, then runs 4 scenarios at each concurrency:
//   health   GET /api/v1/health (HTTP floor, no key, no database work beyond SELECT 1)
//   invalid  chat with a bad body: key check + rate limit + body check, stops before any billing work (400)
//   chat     full call, stub delay subtracted
//   stream   full streaming call, stub delay subtracted; also first-byte time
// Output: a markdown table on stdout (and in --out). There is no target and no pass/fail: exit 0 unless the run
// itself breaks (cannot sign up, inference off, no credit).
// shortcut: client, stub and server share one machine and CPU; the stage split is a difference of medians, not a trace. Upgrade to server-side timing if a stage needs exact numbers.
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { overheads, percentile, summarize } from './perf-stats.mjs';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) opt[argv[i].slice(2)] = true;
  else { opt[argv[i].slice(2)] = next; i++; }
}
const BASE = String(opt.base || 'http://127.0.0.1:8799').replace(/\/$/, '');
const N = Math.max(1, parseInt(opt.n ?? '200', 10) || 200);
const CONC = String(opt.c ?? '1,10').split(',').map(x => Math.max(1, parseInt(x, 10) || 1));
const DELAY = Math.max(0, Number(opt.delay ?? 50));
const STUB_PORT = parseInt(opt['stub-port'] ?? '8801', 10);
const MODEL = String(opt.model || 'minimax/minimax-m3.1-flash');
const OUT = typeof opt.out === 'string' ? opt.out : null;
const KEY_WINDOW = 450; // calls per key per minute window (key limit is set to 600)

function fail(msg) { console.error(`PERF-1 run broke: ${msg}`); process.exit(1); }

// ---- stub provider ----
const modelEntry = id => ({ id, name: id, description: 'stub', context_length: 8192, pricing: { prompt: '0.00000015', completion: '0.0000006' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: [], created: 1 });
const catalog = () => Array.from({ length: 120 }, (_, i) => modelEntry(i === 0 ? MODEL : `stub/filler-${i}`)); // the app needs at least 100 models to accept a live catalog
const stubCounts = { chat: 0, stream: 0, models: 0 };

function startStub() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/api/v1/models')) {
      stubCounts.models++;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: catalog() }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
      const parts = [];
      req.on('data', c => parts.push(c));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(parts).toString()); } catch { /* stub: treat as empty */ }
        setTimeout(() => {
          const usage = { prompt_tokens: 12, completion_tokens: 4, cost: 0.00001 };
          if (body.stream) {
            stubCounts.stream++;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            for (const t of ['Hello', ' from', ' the', ' stub']) res.write(`data: ${JSON.stringify({ id: 'stub', choices: [{ delta: { content: t } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ id: 'stub', choices: [{ delta: {} }], usage })}\n\n`);
            res.end('data: [DONE]\n\n');
          } else {
            stubCounts.chat++;
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'stub', choices: [{ message: { role: 'assistant', content: 'Hello from the stub' } }], usage }));
          }
        }, DELAY);
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(STUB_PORT, '127.0.0.1', () => resolve(server)); });
}

// ---- account and keys (same cookie client idea as smoke-test.mjs) ----
function client() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(BASE + path, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const set = res.headers.get('set-cookie');
    if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  };
}

async function signUp() {
  const c = client();
  const reg = await c('/api/auth/register', { method: 'POST', body: { email: `perf-${Date.now().toString(36)}@test.local`, password: 'correct-horse-battery', name: 'Perf Baseline', acceptTerms: true } });
  if (reg.status !== 201) fail(`sign-up gave ${reg.status} ${JSON.stringify(reg.json)}. Sign-up is limited to 10 per hour per IP: use a fresh state dir or clear rate_limit_buckets.`);
  if (reg.json.dev_verify_token) await c('/api/auth/verify-email', { method: 'POST', body: { token: reg.json.dev_verify_token } });
  return c;
}

let keyCounter = 0;
async function newKeys(account, count) {
  const keys = [];
  for (let i = 0; i < count; i++) {
    const r = await account('/api/account/keys', { method: 'POST', body: { name: `perf-${Date.now().toString(36)}-${keyCounter++}`, scopes: ['chat', 'usage'], expiresInDays: 1, rateLimitPerMin: 600 } });
    if (r.status !== 201) fail(`key creation gave ${r.status} ${JSON.stringify(r.json)}`);
    keys.push(r.json.secret);
  }
  return keys;
}

// ---- measuring ----
async function timed(url, init, stream, expect) {
  const t0 = performance.now();
  let status = 0; let ttfb = null;
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    status = res.status;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (ttfb === null && value) ttfb = performance.now() - t0;
      if (done) break;
    }
  } catch { status = 0; }
  return { ms: performance.now() - t0, ttfb, status, ok: status === expect };
}

const chatBody = stream => JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }], max_tokens: 100, ...(stream ? { stream: true } : {}) });
const auth = key => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });

function scenarioDefs() {
  return [
    { name: 'health', needsKey: false, subtract: 0, stream: false, expect: 200, req: () => ({ url: `${BASE}/api/v1/health`, init: {} }) },
    { name: 'invalid', needsKey: true, subtract: 0, stream: false, expect: 400, req: (_, k) => ({ url: `${BASE}/api/v1/chat/completions`, init: { method: 'POST', headers: auth(k), body: JSON.stringify({ model: 'x' }) } }) },
    { name: 'chat', needsKey: true, subtract: DELAY, stream: false, expect: 200, req: (_, k) => ({ url: `${BASE}/api/v1/chat/completions`, init: { method: 'POST', headers: auth(k), body: chatBody(false) } }) },
    { name: 'stream', needsKey: true, subtract: DELAY, stream: true, expect: 200, req: (_, k) => ({ url: `${BASE}/api/v1/chat/completions`, init: { method: 'POST', headers: auth(k), body: chatBody(true) } }) },
  ];
}

async function runScenario(def, c, account) {
  const keys = def.needsKey ? await newKeys(account, Math.ceil(N / KEY_WINDOW)) : [];
  const totals = []; const firstBytes = []; const bad = {};
  let next = 0;
  const t0 = performance.now();
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= N) return;
      const { url, init } = def.req(i, keys[Math.floor(i / KEY_WINDOW)]);
      const r = await timed(url, init, def.stream, def.expect);
      if (r.ok) { totals.push(r.ms); if (r.ttfb !== null) firstBytes.push(r.ttfb); } else bad[r.status] = (bad[r.status] || 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(c, N) }, worker));
  const wall = (performance.now() - t0) / 1000;
  const errors = Object.values(bad).reduce((a, b) => a + b, 0);
  return { name: def.name, c, ok: totals.length, errors, bad, wall, over: summarize(overheads(totals, def.subtract)), ttfb: def.stream && firstBytes.length ? percentile(overheads(firstBytes, def.subtract), 50) : null };
}

const f = x => (Number.isFinite(x) ? x.toFixed(1) : '-');

async function main() {
  const stub = await startStub().catch(e => fail(`cannot start the stub on port ${STUB_PORT}: ${e.message}`));
  const account = await signUp();
  const [probeKey] = await newKeys(account, 1);

  const bal = await fetch(`${BASE}/api/v1/balance`, { headers: auth(probeKey) }).then(r => r.json()).catch(() => null);
  if (!bal || !(bal.balance_usd >= 1)) fail(`the test account needs credit (balance ${bal?.balance_usd}). Start the server with SIGNUP_BONUS_USD=100.`);

  // Warm up: first calls load the catalog and open connections. Not counted.
  let warm = 0;
  for (const stream of [false, false, false, true, true]) {
    const r = await timed(`${BASE}/api/v1/chat/completions`, { method: 'POST', headers: auth(probeKey), body: chatBody(stream) }, stream, 200);
    if (r.ok) warm++;
    else if (r.status === 503) fail('inference is off on the server. Set INFERENCE_ENABLED=true and OPENROUTER_API_KEY=stub-key.');
    else fail(`warm-up call gave ${r.status}. Check OPENROUTER_BASE_URL=http://127.0.0.1:${STUB_PORT}/api/v1 and APP_ENV=development.`);
  }

  const results = [];
  for (const c of CONC) for (const def of scenarioDefs()) results.push(await runScenario(def, c, account));
  stub.close();

  const lines = [];
  lines.push('# Gateway overhead baseline (PERF-1)', '');
  lines.push(`Date: ${new Date().toISOString()}. Server: ${BASE}. Node ${process.version}. Calls per row: ${N}. Stub delay: ${DELAY} ms.`);
  lines.push('Local run on one machine, dev server, stub provider. These are not production numbers. No target is set.', '');
  lines.push('Overhead = total latency minus the stub delay (milliseconds). `health` and `invalid` never reach the stub, so nothing is subtracted.', '');
  lines.push('| scenario | concurrency | ok | errors | p50 | p95 | p99 | max | first byte p50 | req/s |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const errs = r.errors ? `${r.errors} (${Object.entries(r.bad).map(([s, n]) => `${s}x${n}`).join(' ')})` : '0';
    lines.push(`| ${r.name} | ${r.c} | ${r.ok} | ${errs} | ${f(r.over.p50)} | ${f(r.over.p95)} | ${f(r.over.p99)} | ${f(r.over.max)} | ${f(r.ttfb)} | ${f(r.ok / r.wall)} |`);
  }
  lines.push('', 'Rough split of the median (ms). A difference of medians, not a trace.', '', '| concurrency | HTTP floor (health) | key check + rate limit + body check | catalog, credit hold, limits, provider call, settle (chat) |', '|---|---|---|---|');
  for (const c of CONC) {
    const p = n => results.find(r => r.c === c && r.name === n)?.over.p50;
    lines.push(`| ${c} | ${f(p('health'))} | ${f(p('invalid') - p('health'))} | ${f(p('chat') - p('invalid'))} |`);
  }
  const counted = results.filter(r => r.name === 'chat').reduce((a, r) => a + r.ok, 0);
  lines.push('', `Stub saw ${stubCounts.chat} non-stream and ${stubCounts.stream} stream calls, ${stubCounts.models} catalog reads (expected about ${counted + 3} and ${results.filter(r => r.name === 'stream').reduce((a, r) => a + r.ok, 0) + 2}, and 1 catalog read once cached).`);
  const text = lines.join('\n') + '\n';
  console.log(text);
  if (OUT) { writeFileSync(OUT, text); console.log(`Written to ${OUT}`); }
  process.exit(0);
}

main().catch(e => fail(e instanceof Error ? e.message : String(e)));
