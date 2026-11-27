// End-to-end smoke test against a running LOCAL server started with APP_ENV=development.
// Usage: node scripts/smoke-test.mjs http://127.0.0.1:8799 [admin-email]
// The admin email AND `second.<admin-email>` must both be listed in ADMIN_EMAILS (comma separated): a credit
// adjustment needs a second admin to approve it (SEC-2), so the test uses two admins.
// Each run creates ~4 accounts; sign-up is limited to 10/hour per IP, so between repeated
// runs clear the local buckets (with the server stopped):
//   wrangler d1 execute DB --local ... --command "DELETE FROM rate_limit_buckets"
import { createHmac } from 'node:crypto';
const BASE = (process.argv[2] || 'http://127.0.0.1:8799').replace(/\/$/, '');
const ADMIN = process.argv[3] || 'admin@test.local';
const run = Date.now().toString(36);
let failures = 0;

function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${detail}`); }
}

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body, headers = {}, origin = true } = {}) => {
    const res = await fetch(BASE + path, {
      method,
      redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(origin ? { Origin: BASE } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).catch(e => { throw new Error(`${method} ${path}: ${e.message}`); });
    const set = res.headers.get('set-cookie');
    if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers };
  };
}

async function signUp(email, name) {
  const c = client();
  const r = await c('/api/auth/register', { method: 'POST', body: { email, password: 'correct-horse-battery', name, acceptTerms: true } });
  return { c, r };
}

console.log(`Smoke test against ${BASE}`);

console.log('public');
{
  const c = client();
  check('health 200', (await c('/api/v1/health')).status === 200);
  const s = await c('/api/v1/status');
  check('status has health + incidents', s.status === 200 && s.json.health && Array.isArray(s.json.incidents));
  const sess = await c('/api/auth/session');
  check('anonymous session is null', sess.status === 200 && sess.json.user === null);
  check('models list', (await c('/api/v1/models?limit=2')).json?.data?.length === 2);
  const spec = await c('/api/v1/openapi.json');
  check('openapi spec', spec.status === 200 && spec.json.openapi === '3.1.0' && !!spec.json.paths['/chat/completions']);
  for (const p of ['/terms', '/privacy', '/refund', '/acceptable-use']) check(`page ${p}`, (await c(p)).status === 200);
  check('account requires auth', (await c('/api/account')).status === 401);
  check('admin requires auth', (await c('/api/admin/overview')).status === 401);
}

console.log('auth');
const email = `user-${run}@test.local`;
const { c: u, r: reg } = await signUp(email, 'Smoke User');
check('register 201', reg.status === 201, JSON.stringify(reg.json));
check('dev verify token returned', typeof reg.json.dev_verify_token === 'string');
check('duplicate email 409', (await signUp(email, 'Again')).r.status === 409);
check('cross-origin register blocked', (await client()('/api/auth/register', { method: 'POST', origin: false, body: { email: `x${run}@t.local`, password: 'correct-horse-battery', name: 'X', acceptTerms: true } })).status === 403);
const weak = await client()('/api/auth/register', { method: 'POST', body: { email: `w${run}@t.local`, password: 'short', name: 'Weak', acceptTerms: true } });
check('weak password rejected', weak.status === 400, `${weak.status} ${JSON.stringify(weak.json)}`);
check('session after register', (await u('/api/auth/session')).json.user?.email === email);
check('verify email', (await u('/api/auth/verify-email', { method: 'POST', body: { token: reg.json.dev_verify_token } })).status === 200);
check('verify token single-use', (await u('/api/auth/verify-email', { method: 'POST', body: { token: reg.json.dev_verify_token } })).status === 400);
check('verified flag set', (await u('/api/auth/session')).json.user?.emailVerified === true);
check('logout', (await u('/api/auth/logout', { method: 'POST', body: {} })).status === 200);
check('signed out', (await u('/api/account')).status === 401);
check('bad password 401', (await u('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-password-123' } })).status === 401);
check('login 200', (await u('/api/auth/login', { method: 'POST', body: { email, password: 'correct-horse-battery' } })).status === 200);
const fp = await client()('/api/auth/forgot-password', { method: 'POST', body: { email } });
check('forgot-password 202 + token', fp.status === 202 && typeof fp.json.dev_reset_token === 'string');
check('forgot-password unknown email still 202', (await client()('/api/auth/forgot-password', { method: 'POST', body: { email: `nobody-${run}@test.local` } })).status === 202);

console.log('account');
const acct = await u('/api/account');
check('account loads', acct.status === 200 && acct.json.account.email === email);
check('signup bonus visible in balance (if configured)', typeof acct.json.balanceMicroUsd === 'number');
check('profile update', (await u('/api/account/profile', { method: 'PATCH', body: { name: 'Renamed', preferences: { lang: 'en' } } })).status === 200);
const created = await u('/api/account/keys', { method: 'POST', body: { name: 'smoke', scopes: ['chat', 'usage'], expiresInDays: 30 } });
check('create key 201', created.status === 201 && /^wasl_[a-f0-9]{64}$/.test(created.json.secret));
const secret = created.json.secret;
const rotated = await u('/api/account/keys/rotate', { method: 'POST', body: { id: created.json.key.id } });
check('rotate key', rotated.status === 201 && rotated.json.secret !== secret);
const newSecret = rotated.json.secret;
check('saved models sync', (await u('/api/account/saved', { method: 'PUT', body: { models: ['openai/gpt-4.1'] } })).json.models?.includes('openai/gpt-4.1'));
check('usage summary', (await u('/api/account/usage?days=7')).status === 200);
const csv = await u('/api/account/usage/export?days=7');
check('usage CSV', csv.status === 200 && String(csv.json).startsWith('timestamp,'));
check('billing summary', (await u('/api/billing')).status === 200);
check('sessions list', (await u('/api/auth/sessions')).json.sessions?.length >= 1);

console.log('gateway');
const gw = client();
check('no key 401', (await gw('/api/v1/chat/completions', { method: 'POST', origin: false, body: { model: 'openai/gpt-4.1', messages: [{ role: 'user', content: 'hi' }] } })).status === 401);
check('revoked (rotated) key 401', (await gw('/api/v1/balance', { origin: false, headers: { Authorization: `Bearer ${secret}` } })).status === 401);
const bal = await gw('/api/v1/balance', { origin: false, headers: { Authorization: `Bearer ${newSecret}` } });
check('balance via key', bal.status === 200 && typeof bal.json.balance_usd === 'number');
check('usage via key', (await gw('/api/v1/usage?days=7', { origin: false, headers: { Authorization: `Bearer ${newSecret}` } })).status === 200);
const chat = await gw('/api/v1/chat/completions', { method: 'POST', origin: false, headers: { Authorization: `Bearer ${newSecret}` }, body: { model: 'openai/gpt-4.1', messages: [{ role: 'user', content: 'hi' }] } });
check('chat returns 503 when inference disabled (or 402/200 when enabled)', [503, 402, 200].includes(chat.status), `${chat.status} ${JSON.stringify(chat.json)}`);
check('invalid body 400 or 503', [400, 503].includes((await gw('/api/v1/chat/completions', { method: 'POST', origin: false, headers: { Authorization: `Bearer ${newSecret}` }, body: { model: 'x' } })).status));

console.log('support');
const t = await u('/api/support', { method: 'POST', body: { subject: 'Smoke ticket', message: 'This is a smoke test ticket.' } });
check('create ticket', t.status === 201);
check('list own tickets', (await u('/api/support/tickets')).json.tickets?.some(x => x.id === t.json.id));
check('reply own ticket', (await u(`/api/support/tickets/${t.json.id}`, { method: 'POST', body: { body: 'Follow-up' } })).status === 201);
check('customer cannot use admin API', (await u('/api/admin/overview')).status === 403);

console.log('admin');
const adminEmail = ADMIN;
let { c: a, r: ar } = await signUp(adminEmail, 'Admin');
if (ar.status === 409) {
  a = client();
  ar = await a('/api/auth/login', { method: 'POST', body: { email: adminEmail, password: 'correct-horse-battery' } });
} else {
  await a('/api/auth/verify-email', { method: 'POST', body: { token: ar.json.dev_verify_token } });
}
check('admin signed in', ar.status === 200 || ar.status === 201, `${ar.status} ${JSON.stringify(ar.json)}`);
const who = await a('/api/auth/session');
check('admin role resolved from ADMIN_EMAILS', who.json.user?.role === 'admin', JSON.stringify(who.json.user));
if (who.json.user?.role === 'admin') {
  // Admin MFA (SEC-3a): admin routes are closed until the session passes MFA. Enrol with a TOTP computed here.
  const blocked = await a('/api/admin/overview');
  check('admin without MFA gets 403 mfa_required', blocked.status === 403 && blocked.json.code === 'mfa_required', `${blocked.status} ${JSON.stringify(blocked.json)}`);
  const begun = await a('/api/auth/mfa/begin', { method: 'POST', body: {} });
  check('admin MFA enrolment starts', begun.status === 200 && !!begun.json.secret, `${begun.status} ${JSON.stringify(begun.json)} (re-run with a fresh state dir)`);
  const totp = secretB32 => {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
    for (const ch of secretB32) bits += A.indexOf(ch).toString(2).padStart(5, '0');
    const key = Buffer.from(bits.match(/.{8}/g).map(x => parseInt(x, 2)));
    const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const h = createHmac('sha1', key).update(msg).digest(); const o = h[19] & 15;
    return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6).padStart(6, '0');
  };
  const confirmed = await a('/api/auth/mfa/confirm', { method: 'POST', body: { code: totp(begun.json.secret) } });
  check('admin MFA enrolled with 10 recovery codes', confirmed.status === 200 && confirmed.json.recoveryCodes?.length === 10, `${confirmed.status} ${JSON.stringify(confirmed.json)}`);
  check('admin overview', (await a('/api/admin/overview')).status === 200);
  const users = await a(`/api/admin/users?q=${encodeURIComponent(email)}`);
  const target = users.json.users?.[0];
  check('admin user search', target?.email === email);
  const before = target.balanceMicroUsd;
  // Second admin (SEC-2): signs up, verifies, enrols MFA, then approves what the first admin requests.
  const adminB = `second.${adminEmail}`;
  let { c: b2, r: br } = await signUp(adminB, 'Admin Two');
  if (br.status === 409) { b2 = client(); br = await b2('/api/auth/login', { method: 'POST', body: { email: adminB, password: 'correct-horse-battery' } }); }
  else await b2('/api/auth/verify-email', { method: 'POST', body: { token: br.json.dev_verify_token } });
  const begunB = await b2('/api/auth/mfa/begin', { method: 'POST', body: {} });
  const confirmedB = await b2('/api/auth/mfa/confirm', { method: 'POST', body: { code: totp(begunB.json.secret) } });
  check('second admin signed in and enrolled MFA', confirmedB.status === 200, `${br.status} ${begunB.status} ${confirmedB.status} ${JSON.stringify(confirmedB.json)}`);
  const key = `smoke-${run}`;
  const cr = await a(`/api/admin/users/${target.id}/credits`, { method: 'POST', body: { amountUsd: 5, note: 'smoke credit', requestKey: key } });
  check('credit adjustment becomes a pending request (202)', cr.status === 202 && cr.json.pending === true && !!cr.json.requestId, `${cr.status} ${JSON.stringify(cr.json)}`);
  check('nothing applied before approval', (await u('/api/account')).json.balanceMicroUsd === before);
  const dup = await a(`/api/admin/users/${target.id}/credits`, { method: 'POST', body: { amountUsd: 5, note: 'smoke credit', requestKey: key } });
  check('credit request idempotent', dup.status === 200 && dup.json.duplicate === true && dup.json.requestId === cr.json.requestId);
  const own = await a(`/api/admin/requests/${cr.json.requestId}`, { method: 'POST', body: { action: 'approve', reason: 'approving my own' } });
  check('requester cannot approve own request (403)', own.status === 403 && own.json.code === 'self_approval', `${own.status} ${JSON.stringify(own.json)}`);
  const listed = await b2('/api/admin/requests');
  check('second admin sees the pending request', listed.json.requests?.some(x => x.id === cr.json.requestId));
  const appr = await b2(`/api/admin/requests/${cr.json.requestId}`, { method: 'POST', body: { action: 'approve', reason: 'smoke approval' } });
  check('second admin approves; change applied', appr.status === 200 && appr.json.status === 'approved' && appr.json.duplicate === false, `${appr.status} ${JSON.stringify(appr.json)}`);
  const again = await b2(`/api/admin/requests/${cr.json.requestId}`, { method: 'POST', body: { action: 'approve', reason: 'smoke approval' } });
  check('approval replay is safe', again.status === 200 && again.json.duplicate === true);
  check('customer sees new balance (applied once)', (await u('/api/account')).json.balanceMicroUsd === before + 5_000_000);
  check('admin ticket inbox', (await a('/api/admin/tickets')).json.tickets?.some(x => x.id === t.json.id));
  check('staff reply', (await a(`/api/admin/tickets/${t.json.id}`, { method: 'POST', body: { body: 'Hello from support' } })).status === 201);
  const thread = await u(`/api/support/tickets/${t.json.id}`);
  check('customer sees staff reply', thread.json.messages?.some(m => m.authorRole === 'staff'));
  check('model config upsert', (await a('/api/admin/models', { method: 'PUT', body: { modelId: 'openai/gpt-4.1', enabled: true, markupPercent: 25, note: 'smoke' } })).status === 200);
  const inc = await a('/api/admin/incidents', { method: 'POST', body: { title: 'Smoke incident', body: 'Testing incidents', severity: 'minor' } });
  check('incident created', inc.status === 201);
  check('incident resolved', (await a('/api/admin/incidents', { method: 'PATCH', body: { id: inc.json.id, status: 'resolved' } })).status === 200);
  check('audit log', (await a('/api/admin/audit?limit=5')).json.events?.length > 0);
  check('admin cannot demote self', (await a(`/api/admin/users/${who.json.user.id}`, { method: 'PATCH', body: { role: 'customer' } })).status === 400);
  check('suspend user', (await a(`/api/admin/users/${target.id}`, { method: 'PATCH', body: { status: 'suspended' } })).status === 200);
  check('suspended user signed out', (await u('/api/account')).status === 401);
  check('suspended user key revoked', (await gw('/api/v1/balance', { origin: false, headers: { Authorization: `Bearer ${newSecret}` } })).status === 401);
  await a(`/api/admin/users/${target.id}`, { method: 'PATCH', body: { status: 'active' } });
}

console.log('billing webhook');
const wh = await client()('/api/billing/webhook', { method: 'POST', origin: false, headers: { 'Stripe-Signature': 't=1,v1=bad' }, body: { id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } } });
check('webhook rejects unsigned (400) or reports unconfigured (503)', [400, 503].includes(wh.status), String(wh.status));

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
