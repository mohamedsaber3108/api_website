import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { accounts, auditLogs, mfaCredentials, mfaRecoveryCodes, sessions } from '../db/schema';
import * as audit from '../app/api/admin/audit/route';
import * as incidents from '../app/api/admin/incidents/route';
import * as models from '../app/api/admin/models/route';
import * as overview from '../app/api/admin/overview/route';
import * as ticketById from '../app/api/admin/tickets/[id]/route';
import * as tickets from '../app/api/admin/tickets/route';
import * as usage from '../app/api/admin/usage/route';
import * as credits from '../app/api/admin/users/[id]/credits/route';
import * as userById from '../app/api/admin/users/[id]/route';
import * as users from '../app/api/admin/users/route';
import * as login from '../app/api/auth/login/route';
import * as begin from '../app/api/auth/mfa/begin/route';
import * as confirm from '../app/api/auth/mfa/confirm/route';
import * as recovery from '../app/api/auth/mfa/recovery/route';
import * as status from '../app/api/auth/mfa/status/route';
import * as verify from '../app/api/auth/mfa/verify/route';
import { normaliseCodeInput } from '../lib/mfa-code';
import { hashPassword, hmacSha256Hex, sha256Hex } from '../lib/server/crypto';
import { base32Decode, base32Encode, currentStep, decryptSecret, encryptSecret, hotp } from '../lib/server/mfa';
import { makeUser, newSession, req, startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });

type Handler = (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
const ctx = { params: Promise.resolve({ id: 'u1' }) };
const post = (fn: unknown, path: string, cookie: string | undefined, body: unknown = {}) => (fn as Handler)(req(path, { method: 'POST', cookie, body }), ctx);
const get = (fn: unknown, path: string, cookie: string) => (fn as Handler)(req(path, { cookie }), ctx);
const doBegin = (cookie: string) => post(begin.POST, '/api/auth/mfa/begin', cookie);
const doConfirm = (cookie: string, code: string) => post(confirm.POST, '/api/auth/mfa/confirm', cookie, { code });
const doVerify = (cookie: string, code: string) => post(verify.POST, '/api/auth/mfa/verify', cookie, { code });
const codeAt = async (secretB32: string, stepOffset = 0) => hotp(base32Decode(secretB32), currentStep() + stepOffset);

/** An admin with a fresh (unverified) session who has finished enrolment. Returns the secret and recovery codes. */
async function enrolledAdmin() {
  const a = await makeUser({ role: 'admin', mfaVerifiedAt: null });
  const { secret } = await (await doBegin(a.cookie)).json();
  const res = await doConfirm(a.cookie, await codeAt(secret));
  expect(res.status).toBe(200);
  const { recoveryCodes } = await res.json();
  return { ...a, secret, recoveryCodes: recoveryCodes as string[] };
}

// [method, path, handler]: all 15 admin handlers, as in tests/admin.test.ts.
const ADMIN_ROUTES: Array<[string, string, unknown]> = [
  ['GET', '/api/admin/audit', audit.GET], ['GET', '/api/admin/incidents', incidents.GET], ['POST', '/api/admin/incidents', incidents.POST], ['PATCH', '/api/admin/incidents', incidents.PATCH],
  ['GET', '/api/admin/models', models.GET], ['PUT', '/api/admin/models', models.PUT], ['GET', '/api/admin/overview', overview.GET], ['GET', '/api/admin/tickets', tickets.GET],
  ['GET', '/api/admin/tickets/t1', ticketById.GET], ['PATCH', '/api/admin/tickets/t1', ticketById.PATCH], ['POST', '/api/admin/tickets/t1', ticketById.POST], ['GET', '/api/admin/usage', usage.GET],
  ['GET', '/api/admin/users', users.GET], ['PATCH', '/api/admin/users/u1', userById.PATCH], ['POST', '/api/admin/users/u1/credits', credits.POST],
];
const callAdmin = (method: string, path: string, fn: unknown, cookie: string) => (fn as Handler)(req(path, { method, cookie, body: method === 'GET' ? undefined : {} }), { params: Promise.resolve({ id: path.split('/')[4] ?? 'x' }) });

describe('TOTP primitives', () => {
  it('matches the RFC 4226 / 6238 test vectors (secret "12345678901234567890")', async () => {
    const secret = new TextEncoder().encode('12345678901234567890');
    expect(await hotp(secret, 1)).toBe('287082'); // RFC 4226 counter 1
    expect(await hotp(secret, 0)).toBe('755224'); // RFC 4226 counter 0
    expect(await hotp(secret, 37037036)).toBe('081804'); // RFC 6238, T = 1111111109, last 6 digits of 07081804
  });
  it('base32 round-trips', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
    expect(base32Encode(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI');
  });
  it('AES-GCM secret: round-trips, differs each time, hides the secret, and fails with another key', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(20));
    const a = await encryptSecret(secret, 'u_a');
    expect(a).toMatch(/^v2\./);
    expect(a).not.toBe(await encryptSecret(secret, 'u_a'));
    expect(a).not.toContain(base32Encode(secret));
    expect([...(await decryptSecret(a, 'u_a'))]).toEqual([...secret]);
    env.MFA_ENCRYPTION_KEY = 'a-different-key-0123456789-abcdefghijk';
    await expect(decryptSecret(a, 'u_a')).rejects.toMatchObject({ code: 'mfa_secret_unreadable' });
    env.MFA_ENCRYPTION_KEY = 'test-only-mfa-key-0123456789-abcdefghij';
  });
});

describe('A1: secret bound to the user id', () => {
  it('a secret copied to another user does not decrypt (primitive and through the API)', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(20));
    const enc = await encryptSecret(secret, 'u_a');
    await expect(decryptSecret(enc, 'u_b')).rejects.toMatchObject({ code: 'mfa_secret_unreadable' });
    const a = await enrolledAdmin();
    const b = await enrolledAdmin();
    const [credA] = await getDb().select().from(mfaCredentials).where(eq(mfaCredentials.userId, a.userId));
    await getDb().update(mfaCredentials).set({ secretEnc: credA.secretEnc }).where(eq(mfaCredentials.userId, b.userId));
    // B's row now holds A's secret: A's right code must not open a session for B.
    const res = await doVerify(await newSession(b.userId), await codeAt(a.secret, 1));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('mfa_secret_unreadable');
  });
});

describe('admin without MFA', () => {
  it('gets 403 mfa_required (enrolled:false) on each of the 15 admin handlers that allow admins', async () => {
    const a = await makeUser({ role: 'admin', mfaVerifiedAt: null });
    for (const [method, path, fn] of ADMIN_ROUTES) {
      const res = await callAdmin(method, path, fn, a.cookie);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json(), `${method} ${path}`).toMatchObject({ code: 'mfa_required', enrolled: false });
    }
  });
  it('can reach the enrolment routes and the status route', async () => {
    const a = await makeUser({ role: 'admin', mfaVerifiedAt: null });
    expect(await (await get(status.GET, '/api/auth/mfa/status', a.cookie)).json()).toMatchObject({ enrolled: false, verified: false });
    const res = await doBegin(a.cookie);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(j.otpauthUrl).toContain(`secret=${j.secret}`);
    expect(j.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Wasl:/);
  });
  it('an admin made by ADMIN_EMAILS is included', async () => {
    const u = await makeUser({ role: 'customer', email: 'boss@example.test', mfaVerifiedAt: null });
    env.ADMIN_EMAILS = 'boss@example.test';
    try {
      const res = await callAdmin('GET', '/api/admin/users', users.GET, u.cookie);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('mfa_required');
    } finally { delete env.ADMIN_EMAILS; }
  });
  it('a password sign-in creates a session that has not passed MFA', async () => {
    const a = await makeUser({ role: 'admin' });
    const passwordHash = await hashPassword('correct-horse-battery');
    await getDb().update(accounts).set({ passwordHash }).where(eq(accounts.userId, a.userId));
    const res = await post(login.POST, '/api/auth/login', undefined, { email: a.email, password: 'correct-horse-battery' });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    const [row] = await getDb().select().from(sessions).where(eq(sessions.id, await sha256Hex(cookie.split('=')[1])));
    expect(row.mfaVerifiedAt).toBeNull();
    expect((await callAdmin('GET', '/api/admin/users', users.GET, cookie)).status).toBe(403);
  });
  it('MFA routes refuse a foreign Origin and non-admins', async () => {
    const a = await makeUser({ role: 'admin', mfaVerifiedAt: null });
    const noOrigin = await begin.POST(req('/api/auth/mfa/begin', { method: 'POST', cookie: a.cookie, body: {}, origin: false }), ctx);
    expect(noOrigin.status).toBe(403);
    expect((await noOrigin.json()).code).toBe('invalid_origin');
    for (const role of ['customer', 'support']) {
      const u = await makeUser({ role });
      expect((await doBegin(u.cookie)).status).toBe(403);
    }
    expect((await post(begin.POST, '/api/auth/mfa/begin', undefined)).status).toBe(401);
  });
});

describe('enrolment', () => {
  it('a wrong code fails, the right code enrols, returns 10 recovery codes once, and opens the admin routes', async () => {
    const a = await makeUser({ role: 'admin', mfaVerifiedAt: null });
    const { secret } = await (await doBegin(a.cookie)).json();
    const bad = await doConfirm(a.cookie, '000000');
    expect(bad.status).toBe(401);
    expect((await bad.json()).code).toBe('invalid_mfa_code');
    expect((await callAdmin('GET', '/api/admin/users', users.GET, a.cookie)).status).toBe(403);

    const ok = await doConfirm(a.cookie, await codeAt(secret));
    expect(ok.status).toBe(200);
    const { recoveryCodes } = await ok.json();
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const c of recoveryCodes) expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    for (const [method, path, fn] of ADMIN_ROUTES) {
      expect((await callAdmin(method, path, fn, a.cookie)).status, `${method} ${path}`).not.toBe(403);
    }
  });
  it('stores the secret encrypted and the recovery codes only as keyed HMAC-SHA-256', async () => {
    const a = await enrolledAdmin();
    const [cred] = await getDb().select().from(mfaCredentials).where(eq(mfaCredentials.userId, a.userId));
    expect(cred.secretEnc).toMatch(/^v2\.[a-f0-9]{24}\./);
    expect(cred.secretEnc).not.toContain(a.secret);
    expect(cred.enrolledAt).not.toBeNull();
    const rows = await getDb().select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, a.userId));
    expect(rows).toHaveLength(10);
    expect(rows.map(r => r.hash).sort()).toEqual(await Promise.all(a.recoveryCodes.map(c => hmacSha256Hex(env.MFA_ENCRYPTION_KEY as string, `wasl-mfa-recovery-v1:${c.replace('-', '')}`))).then(x => x.sort()));
  });
  it('cannot begin or confirm again once enrolled (409)', async () => {
    const a = await enrolledAdmin();
    expect((await doBegin(a.cookie)).status).toBe(409);
    expect((await doConfirm(a.cookie, await codeAt(a.secret, 1))).status).toBe(409);
  });
  it('writes audit rows for enrolment, a failed verify and a recovery code', async () => {
    const a = await enrolledAdmin();
    await doVerify(await newSession(a.userId), '111111');
    await doVerify(await newSession(a.userId), a.recoveryCodes[0]);
    const actions = (await getDb().select().from(auditLogs).where(eq(auditLogs.actorId, a.userId))).map(r => r.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.mfa_enrol_started', 'auth.mfa_enrolled', 'auth.mfa_verify_failed', 'auth.mfa_recovery_used']));
  });
});

describe('verify (step-up)', () => {
  it('a new session is refused until a right code is entered; then admin routes open', async () => {
    const a = await enrolledAdmin();
    const cookie = await newSession(a.userId);
    const blocked = await callAdmin('GET', '/api/admin/users', users.GET, cookie);
    expect(await blocked.json()).toMatchObject({ code: 'mfa_required', enrolled: true });
    expect((await doVerify(cookie, '123456')).status).toBe(401);
    expect((await callAdmin('GET', '/api/admin/users', users.GET, cookie)).status).toBe(403);
    // Enrolment used the current step, so the next step is the first fresh code.
    const ok = await doVerify(cookie, await codeAt(a.secret, 1));
    expect(ok.status).toBe(200);
    expect((await callAdmin('GET', '/api/admin/users', users.GET, cookie)).status).toBe(200);
  });
  it('rejects a code that was already used (replay), and an older step', async () => {
    const a = await enrolledAdmin();
    const used = await codeAt(a.secret, 1);
    expect((await doVerify(await newSession(a.userId), used)).status).toBe(200);
    const replay = await doVerify(await newSession(a.userId), used);
    expect(replay.status).toBe(401);
    expect((await replay.json()).code).toBe('invalid_mfa_code');
    expect((await doVerify(await newSession(a.userId), await codeAt(a.secret, 0))).status).toBe(401);
  });
  it('rejects a code from outside the previous/next window', async () => {
    const a = await enrolledAdmin();
    expect((await doVerify(await newSession(a.userId), await codeAt(a.secret, 3))).status).toBe(401);
  });
  it('accepts Arabic-Indic and Persian digits and spaces (Arabic keyboard); the same code in 0-9 passes too', async () => {
    const arabic = (s: string) => s.replace(/\d/g, d => String.fromCharCode(0x0660 + Number(d)));
    const persian = (s: string) => s.replace(/\d/g, d => String.fromCharCode(0x06f0 + Number(d)));
    expect(normaliseCodeInput('٣٤٥٦٧٨')).toBe('345678');
    expect(normaliseCodeInput(' ۳۴۵ ۶۷۸ ')).toBe('345678');
    const a = await enrolledAdmin();
    const c1 = await codeAt(a.secret, 1);
    expect((await doVerify(await newSession(a.userId), ` ${arabic(c1.slice(0, 3))} ${arabic(c1.slice(3))} `)).status).toBe(200);
    const b = await enrolledAdmin();
    expect((await doVerify(await newSession(b.userId), persian(await codeAt(b.secret, 1)))).status).toBe(200);
    const c = await enrolledAdmin();
    expect((await doVerify(await newSession(c.userId), await codeAt(c.secret, 1))).status).toBe(200);
  });
  it('confirms enrolment with an Arabic-digit code', async () => {
    const a = await makeUser({ role: 'admin', mfaVerifiedAt: null });
    const { secret } = await (await doBegin(a.cookie)).json();
    const code = (await codeAt(secret)).replace(/\d/g, d => String.fromCharCode(0x0660 + Number(d)));
    expect((await doConfirm(a.cookie, code)).status).toBe(200);
  });
  it('5 wrong codes lock the account for 15 minutes, even for the right code', async () => {
    const a = await enrolledAdmin();
    const cookie = await newSession(a.userId);
    for (let i = 0; i < 5; i++) expect((await doVerify(cookie, '000000')).status, `try ${i + 1}`).toBe(401);
    const locked = await doVerify(cookie, await codeAt(a.secret, 1));
    expect(locked.status).toBe(429);
    expect((await locked.json()).code).toBe('mfa_locked');
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    // Locked for recovery codes and enrolment-style routes too.
    expect((await doVerify(cookie, a.recoveryCodes[0])).status).toBe(429);
    // Another admin is not affected.
    const other = await enrolledAdmin();
    expect((await doVerify(await newSession(other.userId), await codeAt(other.secret, 1))).status).toBe(200);
  });
  it('R3: parallel wrong codes cannot exceed 5 tries', async () => {
    const a = await enrolledAdmin();
    const cookie = await newSession(a.userId);
    const results = await Promise.all(Array.from({ length: 30 }, () => doVerify(cookie, '000000')));
    const codes = results.map(r => r.status);
    expect(codes.filter(c => c === 401)).toHaveLength(5);
    expect(codes.filter(c => c === 429)).toHaveLength(25);
    expect((await doVerify(cookie, await codeAt(a.secret, 1))).status).toBe(429);
  });
  it('A4: a lock window writes one auth.mfa_locked audit row, however many blocked tries follow', async () => {
    const a = await enrolledAdmin();
    const cookie = await newSession(a.userId);
    for (let i = 0; i < 12; i++) await doVerify(cookie, '000000');
    const rows = (await getDb().select().from(auditLogs).where(eq(auditLogs.actorId, a.userId))).filter(r => r.action === 'auth.mfa_locked');
    expect(rows).toHaveLength(1);
  });
  it('a right code clears the failure count', async () => {
    const a = await enrolledAdmin();
    const cookie = await newSession(a.userId);
    for (let i = 0; i < 4; i++) await doVerify(cookie, '000000');
    expect((await doVerify(cookie, await codeAt(a.secret, 1))).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await doVerify(cookie, '000000')).status).toBe(401);
  });
  it('a recovery code works once', async () => {
    const a = await enrolledAdmin();
    const first = await newSession(a.userId);
    expect((await doVerify(first, a.recoveryCodes[0].toLowerCase())).status).toBe(200); // case and hyphen are forgiving
    expect((await callAdmin('GET', '/api/admin/users', users.GET, first)).status).toBe(200);
    const again = await doVerify(await newSession(a.userId), a.recoveryCodes[0]);
    expect(again.status).toBe(401);
    expect((await doVerify(await newSession(a.userId), a.recoveryCodes[1])).status).toBe(200);
  });
  it('verify before enrolment is 409 mfa_not_enrolled', async () => {
    const a = await makeUser({ role: 'admin', mfaVerifiedAt: null });
    expect((await doVerify(a.cookie, '123456')).status).toBe(409);
    expect((await doVerify(a.cookie, 'AAAAA-BBBBB')).status).toBe(409);
  });
});

describe('recovery code regeneration', () => {
  it('needs a valid TOTP code (a recovery code does not count) and replaces the old codes', async () => {
    const a = await enrolledAdmin();
    const cookie = await newSession(a.userId, Date.now());
    const asRecovery = await post(recovery.POST, '/api/auth/mfa/recovery', cookie, { code: 'AAAAAA' });
    expect(asRecovery.status).toBe(401);
    const ok = await post(recovery.POST, '/api/auth/mfa/recovery', cookie, { code: await codeAt(a.secret, 1) });
    expect(ok.status).toBe(200);
    const { recoveryCodes } = await ok.json();
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes.filter((c: string) => a.recoveryCodes.includes(c))).toHaveLength(0);
    expect((await doVerify(await newSession(a.userId), a.recoveryCodes[0])).status).toBe(401); // old code is dead
    expect((await doVerify(await newSession(a.userId), recoveryCodes[0])).status).toBe(200);
  });
});

describe('credit adjustment needs MFA verified in the last 15 minutes', () => {
  const adjust = (cookie: string, targetId: string) => credits.POST(req(`/api/admin/users/${targetId}/credits`, { method: 'POST', cookie, body: { amountUsd: 2, note: 'mfa test credit', requestKey: crypto.randomUUID() } }), { params: Promise.resolve({ id: targetId }) });
  it('403 mfa_recent_required when the verification is older than 15 minutes, 201 when recent', async () => {
    const target = await makeUser();
    const stale = await makeUser({ role: 'admin', mfaVerifiedAt: Date.now() - 16 * 60_000 });
    const res = await adjust(stale.cookie, target.userId);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('mfa_recent_required');
    const fresh = await makeUser({ role: 'admin', mfaVerifiedAt: Date.now() - 14 * 60_000 });
    expect((await adjust(fresh.cookie, target.userId)).status).toBe(201);
  });
  it('an enrolled admin can step up again to adjust credit', async () => {
    const a = await enrolledAdmin();
    const target = await makeUser();
    await getDb().update(sessions).set({ mfaVerifiedAt: Date.now() - 3600_000 }).where(eq(sessions.userId, a.userId));
    expect((await adjust(a.cookie, target.userId)).status).toBe(403);
    expect((await doVerify(a.cookie, await codeAt(a.secret, 1))).status).toBe(200);
    expect((await adjust(a.cookie, target.userId)).status).toBe(201);
  });
});

describe('A5: a role change ends MFA verification', () => {
  it('clears mfa_verified_at on the target user\'s sessions', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'admin' });
    const other = await makeUser({ role: 'admin' });
    const patch = (id: string, role: string) => userById.PATCH(req(`/api/admin/users/${id}`, { method: 'PATCH', cookie: admin.cookie, body: { role } }), { params: Promise.resolve({ id }) });
    expect((await patch(target.userId, 'customer')).status).toBe(200);
    const [t] = await getDb().select().from(sessions).where(eq(sessions.userId, target.userId));
    expect(t.mfaVerifiedAt).toBeNull();
    const [o] = await getDb().select().from(sessions).where(eq(sessions.userId, other.userId));
    expect(o.mfaVerifiedAt).not.toBeNull();
    expect((await patch(target.userId, 'admin')).status).toBe(200);
    expect((await callAdmin('GET', '/api/admin/users', users.GET, target.cookie)).status).toBe(403); // must verify again
  });
});

describe('support and customer are unaffected', () => {
  it('support still reaches staff routes without MFA, and is still refused admin-only routes with forbidden', async () => {
    const s = await makeUser({ role: 'support' });
    expect((await callAdmin('GET', '/api/admin/tickets', tickets.GET, s.cookie)).status).toBe(200);
    expect((await callAdmin('GET', '/api/admin/overview', overview.GET, s.cookie)).status).toBe(200);
    const res = await callAdmin('GET', '/api/admin/users', users.GET, s.cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('forbidden');
  });
  it('a customer gets forbidden (not mfa_required) on admin routes', async () => {
    const c = await makeUser();
    const res = await callAdmin('GET', '/api/admin/users', users.GET, c.cookie);
    expect((await res.json()).code).toBe('forbidden');
  });
});

describe('fail closed without MFA_ENCRYPTION_KEY', () => {
  it('in production mode admin routes and MFA routes return 503 mfa_not_configured, even for a verified session', async () => {
    const a = await makeUser({ role: 'admin' });
    delete env.MFA_ENCRYPTION_KEY;
    try {
      const res = await callAdmin('GET', '/api/admin/users', users.GET, a.cookie);
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('mfa_not_configured');
      expect((await doBegin(a.cookie)).status).toBe(503);
      // Support staff and customers are not affected by the missing key.
      const s = await makeUser({ role: 'support' });
      expect((await callAdmin('GET', '/api/admin/tickets', tickets.GET, s.cookie)).status).toBe(200);
    } finally { env.MFA_ENCRYPTION_KEY = 'test-only-mfa-key-0123456789-abcdefghij'; }
  });
  it('R4: in production a key shorter than 32 characters is refused with 503; 32 characters work', async () => {
    const a = await makeUser({ role: 'admin' });
    try {
      for (const short of ['a', 'short-key-1234567890', 'x'.repeat(31), ' '.repeat(10) + 'y'.repeat(20)]) {
        env.MFA_ENCRYPTION_KEY = short;
        const res = await callAdmin('GET', '/api/admin/users', users.GET, a.cookie);
        expect(res.status, short).toBe(503);
        expect((await res.json()).code).toBe('mfa_not_configured');
      }
      env.MFA_ENCRYPTION_KEY = 'x'.repeat(32);
      expect((await callAdmin('GET', '/api/admin/users', users.GET, a.cookie)).status).toBe(200);
    } finally { env.MFA_ENCRYPTION_KEY = 'test-only-mfa-key-0123456789-abcdefghij'; }
  });
  it('in development mode a missing key falls back to a local key (so local runs work)', async () => {
    const a = await makeUser({ role: 'admin', mfaVerifiedAt: null });
    delete env.MFA_ENCRYPTION_KEY;
    env.APP_ENV = 'development';
    try {
      expect((await doBegin(a.cookie)).status).toBe(200);
    } finally { env.MFA_ENCRYPTION_KEY = 'test-only-mfa-key-0123456789-abcdefghij'; delete env.APP_ENV; }
  });
});
