// FEAT-1 (optional): runs the JavaScript doc samples against a LOCAL dev server and a LOCAL stub provider.
// Never a real provider: --base must be 127.0.0.1 or localhost, and the run fails if the stub saw no call.
//
// Server setup is the same as scripts/gateway-baseline.mjs: APP_ENV=development INFERENCE_ENABLED=true
// OPENROUTER_API_KEY=stub-key SIGNUP_BONUS_USD=100 OPENROUTER_BASE_URL=http://127.0.0.1:8801/api/v1
//
// Usage (Node 22.6 or newer, the sample module is TypeScript):
//   node --experimental-strip-types scripts/docs-samples-smoke.mjs --base http://127.0.0.1:8799 [--stub-port 8801]
// Python and cURL samples are not run here (no interpreter is assumed); they are checked against OpenAPI by tests/docs-samples.test.ts.
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fail(msg) { console.error(`docs-samples smoke broke: ${msg}`); process.exit(1); }

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) opt[argv[i].slice(2)] = true;
  else { opt[argv[i].slice(2)] = next; i++; }
}
const BASE = String(opt.base || 'http://127.0.0.1:8799').replace(/\/$/, '');
const STUB_PORT = parseInt(opt['stub-port'] ?? '8801', 10);
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) fail(`--base must be a local address, got ${BASE}`);

let docs;
try { docs = await import('../lib/docs-samples.ts'); } catch (e) { fail(`cannot load lib/docs-samples.ts (${e.message}). Run: node --experimental-strip-types scripts/docs-samples-smoke.mjs`); }

// ---- stub provider (answers like OpenRouter) ----
const modelEntry = id => ({ id, name: id, description: 'stub', context_length: 8192, pricing: { prompt: '0.00000015', completion: '0.0000006' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: [], created: 1 });
const catalog = () => Array.from({ length: 120 }, (_, i) => modelEntry(i === 0 ? docs.DEFAULT_MODEL : `stub/filler-${i}`)); // the app needs at least 100 models
const stubCounts = { chat: 0, stream: 0 };
const stub = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/api/v1/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: catalog() })); return; }
  if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(parts).toString()); } catch { /* treat as empty */ }
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
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve, reject) => { stub.once('error', reject); stub.listen(STUB_PORT, '127.0.0.1', resolve); }).catch(e => fail(`cannot start the stub on port ${STUB_PORT}: ${e.message}`));

// ---- account and key (same cookie idea as gateway-baseline.mjs) ----
let cookie = '';
async function call(p, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + p, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const set = res.headers.get('set-cookie');
  if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const reg = await call('/api/auth/register', { method: 'POST', body: { email: `docs-${Date.now().toString(36)}@test.local`, password: 'correct-horse-battery', name: 'Docs Smoke', acceptTerms: true } });
if (reg.status !== 201) fail(`sign-up gave ${reg.status} ${JSON.stringify(reg.json)}. Use a fresh state dir if the sign-up limit was hit.`);
if (reg.json.dev_verify_token) await call('/api/auth/verify-email', { method: 'POST', body: { token: reg.json.dev_verify_token } });
const made = await call('/api/account/keys', { method: 'POST', body: { name: `docs-smoke-${Date.now().toString(36)}`, scopes: ['chat', 'usage'], expiresInDays: 1, rateLimitPerMin: 600 } });
if (made.status !== 201) fail(`key creation gave ${made.status} ${JSON.stringify(made.json)}`);
const key = made.json.secret;
const bal = await fetch(`${BASE}/api/v1/balance`, { headers: { Authorization: `Bearer ${key}` } }).then(r => r.json()).catch(() => null);
if (!bal || !(bal.balance_usd >= 1)) fail(`the test account needs credit (balance ${bal?.balance_usd}). Start the server with SIGNUP_BONUS_USD=100.`);

// ---- run each JavaScript sample as a real script ----
const expectIn = { chat: 'Hello from the stub', 'chat-stream': 'Hello from the stub', balance: 'balance_usd', usage: 'totals', models: 'data' };
const dir = mkdtempSync(path.join(os.tmpdir(), 'wasl-docs-smoke-'));
let bad = 0;
const rows = ['| sample | result |', '|---|---|'];
for (const id of docs.ENDPOINT_IDS) {
  const file = path.join(dir, `${id}.mjs`);
  writeFileSync(file, docs.sample(id, 'js', BASE).split(docs.KEY_PLACEHOLDER).join(key));
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 60_000 });
  const ok = r.status === 0 && r.stdout.includes(expectIn[id]);
  if (!ok) { bad++; console.error(`--- ${id} failed (exit ${r.status})\n${r.stdout}\n${r.stderr}`); }
  rows.push(`| ${id} | ${ok ? 'ok' : 'FAILED'} |`);
}
stub.close();
console.log(rows.join('\n'));
if (stubCounts.chat < 1 || stubCounts.stream < 1) fail(`the stub saw ${stubCounts.chat} chat and ${stubCounts.stream} stream calls. The server is not using OPENROUTER_BASE_URL=http://127.0.0.1:${STUB_PORT}/api/v1.`);
process.exit(bad ? 1 : 0);
