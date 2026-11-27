import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { accounts, auditLogs } from '../db/schema';
import * as accept from '../app/api/auth/accept-terms/route';
import * as session from '../app/api/auth/session/route';
import { LEGAL_VERSIONS, TERMS_VERSION, termsUpdateRequired } from '../lib/legal-versions';
import { makeUser, req, startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });

type Handler = (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
const ctx = { params: Promise.resolve({}) };
const getSession = async (cookie?: string) => (await (session.GET as Handler)(req('/api/auth/session', { cookie }), ctx)).json();
const post = (cookie?: string, origin = true, body: unknown = { version: TERMS_VERSION }) => (accept.POST as Handler)(req('/api/auth/accept-terms', { method: 'POST', cookie, body, origin }), ctx);
const setVersion = (userId: string, v: string | null) => getDb().update(accounts).set({ termsVersion: v }).where(eq(accounts.userId, userId));
const rowOf = async (userId: string) => (await getDb().select().from(accounts).where(eq(accounts.userId, userId)))[0];

describe('legal version module', () => {
  it('keeps the current terms version and gives every page a version and effective date', () => {
    expect(TERMS_VERSION).toBe('2026-10-01');
    for (const page of ['terms', 'privacy', 'refund', 'acceptable-use'] as const) {
      expect(LEGAL_VERSIONS[page].version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(LEGAL_VERSIONS[page].effective).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it('termsUpdateRequired: null or older is required, current is not', () => {
    expect(termsUpdateRequired(null)).toBe(true);
    expect(termsUpdateRequired('2026-01-01')).toBe(true);
    expect(termsUpdateRequired(TERMS_VERSION)).toBe(false);
  });
});

describe('GET /api/auth/session terms flag', () => {
  it('is true for an older accepted version and false for the current one', async () => {
    const u = await makeUser();
    await setVersion(u.userId, '2026-01-01');
    expect(await getSession(u.cookie)).toMatchObject({ termsUpdateRequired: true, currentTermsVersion: TERMS_VERSION });
    await setVersion(u.userId, TERMS_VERSION);
    expect(await getSession(u.cookie)).toMatchObject({ termsUpdateRequired: false, currentTermsVersion: TERMS_VERSION });
  });
  it('is absent for anonymous callers', async () => {
    const body = await getSession();
    expect(body.user).toBeNull();
    expect('termsUpdateRequired' in body).toBe(false);
  });
});

describe('POST /api/auth/accept-terms', () => {
  it('records the current version and time, audits it, and clears the flag', async () => {
    const u = await makeUser();
    await setVersion(u.userId, '2026-01-01');
    const res = await post(u.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, termsVersion: TERMS_VERSION, termsUpdateRequired: false });
    const row = await rowOf(u.userId);
    expect(row.termsVersion).toBe(TERMS_VERSION);
    expect(row.termsAcceptedAt).toBeGreaterThan(0);
    expect((await getSession(u.cookie)).termsUpdateRequired).toBe(false);
    const rows = (await getDb().select().from(auditLogs).where(eq(auditLogs.actorId, u.userId))).filter(r => r.action === 'auth.terms_accepted');
    expect(rows).toHaveLength(1);
  });
  it('returns 401 when not signed in', async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('sign_in_required');
  });
  it('refuses a request without a same-origin header', async () => {
    const u = await makeUser();
    await setVersion(u.userId, '2026-01-01');
    expect((await post(u.cookie, false)).status).toBe(403);
    expect((await rowOf(u.userId)).termsVersion).toBe('2026-01-01');
  });
  it('is idempotent: a second accept changes nothing and adds no audit row', async () => {
    const u = await makeUser();
    await setVersion(u.userId, '2026-01-01');
    await post(u.cookie);
    const first = await rowOf(u.userId);
    const res = await post(u.cookie);
    expect(res.status).toBe(200);
    const second = await rowOf(u.userId);
    expect(second.termsAcceptedAt).toBe(first.termsAcceptedAt);
    const rows = (await getDb().select().from(auditLogs).where(eq(auditLogs.actorId, u.userId))).filter(r => r.action === 'auth.terms_accepted');
    expect(rows).toHaveLength(1);
  });
});

describe('review round 1 fixes', () => {
  it('session marks a null version as never accepted, and an older one as not', async () => {
    const u = await makeUser();
    await setVersion(u.userId, null);
    expect(await getSession(u.cookie)).toMatchObject({ termsUpdateRequired: true, termsNeverAccepted: true });
    await setVersion(u.userId, '2026-01-01');
    expect(await getSession(u.cookie)).toMatchObject({ termsUpdateRequired: true, termsNeverAccepted: false });
  });
  it('accepting from a null version records the current one', async () => {
    const u = await makeUser();
    await setVersion(u.userId, null);
    expect((await post(u.cookie)).status).toBe(200);
    expect((await rowOf(u.userId)).termsVersion).toBe(TERMS_VERSION);
  });
  it('refuses a version the user was not shown with 409 and changes nothing', async () => {
    const u = await makeUser();
    await setVersion(u.userId, '2026-01-01');
    const res = await post(u.cookie, true, { version: '2025-01-01' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'terms_version_changed', currentTermsVersion: TERMS_VERSION });
    expect((await rowOf(u.userId)).termsVersion).toBe('2026-01-01');
  });
  it('rate limits at 20 calls an hour per user', async () => {
    const u = await makeUser();
    for (let i = 0; i < 20; i++) expect((await post(u.cookie)).status).toBe(200);
    expect((await post(u.cookie)).status).toBe(429);
  });
});
