import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { auditLogs, sessions } from '../db/schema';
import * as tickets from '../app/api/admin/tickets/route';
import * as begin from '../app/api/auth/mfa/begin/route';
import * as session from '../app/api/auth/session/route';
import { STAFF_TOUCH_MS } from '../lib/server/config';
import { sha256Hex } from '../lib/server/crypto';
import { makeUser, req, startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });

type Handler = (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
const ctx = { params: Promise.resolve({}) };
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 27, 8, 0, 0);

// Only Date is faked, so the database and crypto keep working.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0); });
afterEach(() => { vi.useRealTimers(); });

const at = (ms: number) => vi.setSystemTime(T0 + ms);
const getSession = async (cookie: string, peek = false) => (await (session.GET as Handler)(req(`/api/auth/session${peek ? '?peek=1' : ''}`, { cookie }), ctx)).json();
const extend = (cookie: string) => (session.POST as Handler)(req('/api/auth/session', { method: 'POST', cookie, body: {} }), ctx);
const staffCall = (cookie: string) => (tickets.GET as Handler)(req('/api/admin/tickets', { cookie }), ctx);
const user = (role: string) => makeUser({ role, expiresAt: T0 + 30 * DAY });
const expiryLimits = async (userId: string) => (await getDb().select().from(auditLogs).where(eq(auditLogs.actorId, userId))).filter(r => r.action === 'auth.session_expired').map(r => JSON.parse(r.meta ?? '{}').limit);

describe('idle limit (30 minutes)', () => {
  it.each(['support', 'admin', 'super_admin'])('%s: 30 min minus 1 ms is ok, 30 min ends the session', async role => {
    const u = await user(role);
    at(30 * MIN - 1);
    expect((await getSession(u.cookie, true)).user).not.toBeNull();
    at(30 * MIN);
    expect((await getSession(u.cookie, true)).user).toBeNull();
  });
  it('an expired session is deleted, audited once, and the next call is 401 sign_in_required', async () => {
    const u = await user('admin');
    at(30 * MIN);
    const res = await staffCall(u.cookie);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('sign_in_required');
    expect(await getDb().select().from(sessions).where(eq(sessions.id, await sha256Hex(u.cookie.split('=')[1])))).toHaveLength(0);
    expect((await staffCall(u.cookie)).status).toBe(401);
    expect(await expiryLimits(u.userId)).toEqual(['idle']);
  });
  it('activity moves the idle limit', async () => {
    const u = await user('admin');
    at(20 * MIN);
    expect((await staffCall(u.cookie)).status).toBe(200);
    at(49 * MIN);
    expect((await getSession(u.cookie, true)).user).not.toBeNull();
    at(50 * MIN);
    expect((await getSession(u.cookie, true)).user).toBeNull();
  });
  it('?peek=1 does not count as activity', async () => {
    const u = await user('admin');
    at(10 * MIN);
    expect((await getSession(u.cookie, true)).user).not.toBeNull();
    at(30 * MIN);
    expect((await getSession(u.cookie, true)).user).toBeNull();
  });
  it('extend at 29 minutes moves the idle limit to 59 minutes', async () => {
    const u = await user('admin');
    at(29 * MIN);
    const res = await extend(u.cookie);
    expect(res.status).toBe(200);
    expect((await res.json()).sessionLimits.idleEndsAt).toBe(T0 + 59 * MIN);
    at(58 * MIN);
    expect((await getSession(u.cookie, true)).user).not.toBeNull();
    at(59 * MIN);
    expect((await getSession(u.cookie, true)).user).toBeNull();
  });
  it('extend needs a signed-in session and a same-origin request', async () => {
    expect((await extend('wasl_session=nope')).status).toBe(401);
    const u = await user('admin');
    const noOrigin = await (session.POST as Handler)(req('/api/auth/session', { method: 'POST', cookie: u.cookie, body: {}, origin: false }), ctx);
    expect(noOrigin.status).toBe(403);
  });
});

describe('activity touch throttle (STAFF_TOUCH_MS)', () => {
  const seenOf = async (cookie: string) => (await getDb().select().from(sessions).where(eq(sessions.id, await sha256Hex(cookie.split('=')[1]))))[0].lastSeenAt;
  it('lastSeenAt moves at most once per STAFF_TOUCH_MS, so the session ends up to that long EARLIER than 30 min after the last request', async () => {
    const u = await user('admin');
    at(STAFF_TOUCH_MS - 1);
    expect((await staffCall(u.cookie)).status).toBe(200);
    expect(await seenOf(u.cookie)).toBe(T0); // inside the window: no write
    at(STAFF_TOUCH_MS);
    expect((await staffCall(u.cookie)).status).toBe(200);
    expect(await seenOf(u.cookie)).toBe(T0 + STAFF_TOUCH_MS); // window over: one write
    at(STAFF_TOUCH_MS + 30_000);
    expect((await staffCall(u.cookie)).status).toBe(200);
    expect(await seenOf(u.cookie)).toBe(T0 + STAFF_TOUCH_MS); // last request was 30 s ago in the window: not written
    at(STAFF_TOUCH_MS + 30 * MIN - 1);
    expect((await getSession(u.cookie, true)).user).not.toBeNull();
    at(STAFF_TOUCH_MS + 30 * MIN); // 30 s before 30 min after the last request
    expect((await getSession(u.cookie, true)).user).toBeNull();
  });
});

describe('absolute limit (8 hours)', () => {
  it('8 h minus 1 ms is ok, 8 h ends the session, even after active use and an extend', async () => {
    const u = await user('admin');
    for (let t = 20 * MIN; t <= 7 * HOUR + 40 * MIN; t += 20 * MIN) {
      at(t);
      expect((await staffCall(u.cookie)).status, `at ${t / MIN} min`).toBe(200);
    }
    at(7 * HOUR + 59 * MIN);
    expect((await extend(u.cookie)).status).toBe(200);
    at(8 * HOUR - 1);
    const ok = await getSession(u.cookie, true);
    expect(ok.user).not.toBeNull();
    expect(ok.sessionLimits.absoluteEndsAt).toBe(T0 + 8 * HOUR);
    at(8 * HOUR);
    expect((await getSession(u.cookie, true)).user).toBeNull();
    expect(await expiryLimits(u.userId)).toEqual(['absolute']);
  });
});

describe('session limits in GET /api/auth/session', () => {
  it('staff get sessionLimits with the server clock; customers do not', async () => {
    const a = await user('admin');
    const body = await getSession(a.cookie, true);
    expect(body.sessionLimits).toEqual({ idleEndsAt: T0 + 30 * MIN, absoluteEndsAt: T0 + 8 * HOUR, now: T0 });
    const c = await user('customer');
    const cb = await getSession(c.cookie, true);
    expect(cb.user).not.toBeNull();
    expect('sessionLimits' in cb).toBe(false);
  });
});

describe('customers are unaffected', () => {
  it('a customer session stays valid after 9 hours', async () => {
    const c = await user('customer');
    at(9 * HOUR);
    expect((await getSession(c.cookie)).user).not.toBeNull();
    expect(await expiryLimits(c.userId)).toEqual([]);
  });
});

describe('support role needs MFA (D-10)', () => {
  it('an unverified support session gets 403 mfa_required; a verified one passes; the MFA routes are open to support', async () => {
    const s = await makeUser({ role: 'support', mfaVerifiedAt: null, expiresAt: T0 + 30 * DAY });
    const res = await staffCall(s.cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'mfa_required', enrolled: false });
    expect((await (begin.POST as Handler)(req('/api/auth/mfa/begin', { method: 'POST', cookie: s.cookie, body: {} }), ctx)).status).toBe(200);
    const v = await makeUser({ role: 'support', expiresAt: T0 + 30 * DAY });
    expect((await staffCall(v.cookie)).status).toBe(200);
  });
});
