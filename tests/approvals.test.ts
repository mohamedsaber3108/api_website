import { and, eq, inArray } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as requestById from '../app/api/admin/requests/[id]/route';
import * as requests from '../app/api/admin/requests/route';
import * as credits from '../app/api/admin/users/[id]/credits/route';
import * as userById from '../app/api/admin/users/[id]/route';
import * as users from '../app/api/admin/users/route';
import { getDb } from '../db';
import { accounts, adminRequests, auditLogs, sessions } from '../db/schema';
import { getPrincipal } from '../lib/server/auth';
import { getBalanceMicroUsd } from '../lib/server/ledger';
import { makeUser, req, startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });
// Each test starts with no admin-level account, so "how many admins exist" is under the test's control.
beforeEach(async () => { await getDb().update(accounts).set({ role: 'customer' }).where(inArray(accounts.role, ['admin', 'super_admin'])); });

const idp = (id: string) => ({ params: Promise.resolve({ id }) });
const askCredit = (cookie: string, targetId: string, amountUsd = 5, requestKey?: string) => credits.POST(req(`/api/admin/users/${targetId}/credits`, { method: 'POST', cookie, body: { amountUsd, note: 'goodwill credit', requestKey } }), idp(targetId));
const decide = (cookie: string, id: string, action: 'approve' | 'reject' = 'approve', reason = 'checked the ticket') => requestById.POST(req(`/api/admin/requests/${id}`, { method: 'POST', cookie, body: { action, reason } }), idp(id));
const patch = (cookie: string, id: string, body: object) => userById.PATCH(req(`/api/admin/users/${id}`, { method: 'PATCH', cookie, body }), idp(id));
const audits = (action: string) => getDb().select().from(auditLogs).where(eq(auditLogs.action, action));
const rowOf = async (id: string) => (await getDb().select().from(adminRequests).where(eq(adminRequests.id, id)))[0];
const admin = () => makeUser({ role: 'admin' });
const superAdmin = () => makeUser({ role: 'super_admin' });

describe('credit adjustment: a second admin approves', () => {
  it('requester cannot approve own request (403); admin B approves; the change applies once; audit rows exist', async () => {
    const a = await admin();
    const b = await admin();
    const t = await makeUser();
    const res = await askCredit(a.cookie, t.userId, 7);
    expect(res.status).toBe(202);
    const { requestId } = await res.json();
    expect(await getBalanceMicroUsd(t.userId)).toBe(0);

    const own = await decide(a.cookie, requestId);
    expect(own.status).toBe(403);
    expect((await own.json()).code).toBe('self_approval');
    expect(await getBalanceMicroUsd(t.userId)).toBe(0);

    const ok = await decide(b.cookie, requestId);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'approved', duplicate: false });
    expect(await getBalanceMicroUsd(t.userId)).toBe(7_000_000);
    expect((await rowOf(requestId)).decidedBy).toBe(b.userId);
    expect(await audits('admin.request_created')).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: a.userId, targetId: t.userId })]));
    expect(await audits('admin.request_approved')).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: b.userId, targetId: t.userId })]));
    expect(await audits('admin.credit_adjustment')).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: b.userId, targetId: t.userId })]));
  });

  it('replaying the approval is safe: same or other approver, even in parallel, applies once', async () => {
    const a = await admin();
    const b = await admin();
    const c = await admin();
    const t = await makeUser();
    const { requestId } = await (await askCredit(a.cookie, t.userId, 3)).json();
    const results = await Promise.all([decide(b.cookie, requestId), decide(b.cookie, requestId), decide(c.cookie, requestId), decide(b.cookie, requestId)]);
    expect(results.map(r => r.status)).toEqual([200, 200, 200, 200]);
    expect(await getBalanceMicroUsd(t.userId)).toBe(3_000_000);
    const again = await (await decide(b.cookie, requestId)).json();
    expect(again).toMatchObject({ status: 'approved', duplicate: true });
    expect(await getBalanceMicroUsd(t.userId)).toBe(3_000_000);
  });

  it('approver must be MFA verified, and verified in the last 15 minutes for credit', async () => {
    const a = await admin();
    await admin(); // a second admin exists, so the request can be made
    const t = await makeUser();
    const { requestId } = await (await askCredit(a.cookie, t.userId)).json();
    const noMfa = await makeUser({ role: 'admin', mfaVerifiedAt: null });
    const r1 = await decide(noMfa.cookie, requestId);
    expect(r1.status).toBe(403);
    expect((await r1.json()).code).toBe('mfa_required');
    const stale = await makeUser({ role: 'admin', mfaVerifiedAt: Date.now() - 16 * 60_000 });
    const r2 = await decide(stale.cookie, requestId);
    expect(r2.status).toBe(403);
    expect((await r2.json()).code).toBe('mfa_recent_required');
    expect((await rowOf(requestId)).status).toBe('pending');
    const fresh = await makeUser({ role: 'admin', mfaVerifiedAt: Date.now() - 14 * 60_000 });
    expect((await decide(fresh.cookie, requestId)).status).toBe(200);
  });

  it('the person the credit is for cannot approve it', async () => {
    const a = await admin();
    const b = await admin();
    await admin();
    const { requestId } = await (await askCredit(a.cookie, b.userId)).json();
    const res = await decide(b.cookie, requestId);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('self_target');
  });

  it('support and customer cannot create, list or approve', async () => {
    const a = await admin();
    await admin();
    const t = await makeUser();
    const { requestId } = await (await askCredit(a.cookie, t.userId)).json();
    for (const who of [await makeUser({ role: 'support' }), await makeUser()]) {
      expect((await askCredit(who.cookie, t.userId)).status).toBe(403);
      expect((await decide(who.cookie, requestId)).status).toBe(403);
      expect((await requests.GET(req('/api/admin/requests', { cookie: who.cookie }), idp('x'))).status).toBe(403);
    }
    expect((await rowOf(requestId)).status).toBe('pending');
  });

  it('reject closes the request; a later approval is 409; the requester may cancel their own', async () => {
    const a = await admin();
    const b = await admin();
    const t = await makeUser();
    const r1 = (await (await askCredit(a.cookie, t.userId)).json()).requestId;
    expect((await decide(b.cookie, r1, 'reject', 'not justified')).status).toBe(200);
    const late = await decide(b.cookie, r1);
    expect(late.status).toBe(409);
    expect((await late.json()).code).toBe('request_closed');
    expect(await getBalanceMicroUsd(t.userId)).toBe(0);
    expect(await audits('admin.request_rejected')).toHaveLength(1);
    const r2 = (await (await askCredit(a.cookie, t.userId, 2)).json()).requestId;
    expect((await decide(a.cookie, r2, 'reject', 'mistake')).status).toBe(200);
    expect((await rowOf(r2)).status).toBe('rejected');
  });

  it('a pending request expires after 24 hours: approval gives 410, status expired, audit row written', async () => {
    const a = await admin();
    const b = await admin();
    const t = await makeUser();
    const { requestId, expiresAt } = await (await askCredit(a.cookie, t.userId)).json();
    const row = await rowOf(requestId);
    expect(expiresAt - row.createdAt).toBe(24 * 3600 * 1000);
    await getDb().update(adminRequests).set({ expiresAt: Date.now() - 1000 }).where(eq(adminRequests.id, requestId));
    const res = await decide(b.cookie, requestId);
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe('request_expired');
    expect((await rowOf(requestId)).status).toBe('expired');
    expect(await getBalanceMicroUsd(t.userId)).toBe(0);
    expect(await audits('admin.request_expired')).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: t.userId })]));
    const list = await (await requests.GET(req('/api/admin/requests', { cookie: b.cookie }), idp('x'))).json();
    expect(list.requests.find((r: { id: string }) => r.id === requestId)).toBeUndefined();
  });

  it('with only one admin every adjustment is blocked, with a code and English and Arabic text', async () => {
    const only = await admin();
    const t = await makeUser();
    const res = await askCredit(only.cookie, t.userId);
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.code).toBe('no_second_approver');
    expect(j.message_en).toMatch(/No second admin/);
    expect(j.message_ar).toMatch(/[\u0600-\u06FF]/);
    expect(await getDb().select().from(adminRequests).where(eq(adminRequests.requestedBy, only.userId))).toHaveLength(0);
  });

  it('an admin who is the target does not count as the second approver', async () => {
    const a = await admin();
    const b = await admin();
    const res = await askCredit(a.cookie, b.userId);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no_second_approver');
  });
});

describe('super_admin: only a super_admin changes admins', () => {
  it('an admin cannot promote, demote or suspend an admin (403 super_admin_required)', async () => {
    const a = await admin();
    const other = await admin();
    const t = await makeUser();
    for (const [id, body] of [[t.userId, { role: 'admin', reason: 'needs access' }], [t.userId, { role: 'super_admin', reason: 'needs access' }], [other.userId, { role: 'customer' }], [other.userId, { status: 'suspended' }]] as const) {
      const res = await patch(a.cookie, id, body);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('super_admin_required');
    }
    expect((await getDb().select().from(adminRequests)).filter(r => r.requestedBy === a.userId)).toHaveLength(0);
    expect((await patch(a.cookie, t.userId, { role: 'support' })).status).toBe(200); // support and customer changes stay with admins
  });

  it('a super_admin promotes through a request; another super_admin approves; the role applies', async () => {
    const s1 = await superAdmin();
    const s2 = await superAdmin();
    const t = await makeUser();
    const noReason = await patch(s1.cookie, t.userId, { role: 'admin' });
    expect(noReason.status).toBe(400);
    const res = await patch(s1.cookie, t.userId, { role: 'admin', reason: 'new on-call admin' });
    expect(res.status).toBe(202);
    const { requestId } = await res.json();
    const [still] = await getDb().select().from(accounts).where(eq(accounts.userId, t.userId));
    expect(still.role).toBe('customer');
    expect((await decide(s1.cookie, requestId)).status).toBe(403); // not their own
    const ok = await decide(s2.cookie, requestId);
    expect(ok.status).toBe(200);
    const [now] = await getDb().select().from(accounts).where(eq(accounts.userId, t.userId));
    expect(now.role).toBe('admin');
    expect((await decide(s2.cookie, requestId)).status).toBe(200); // replay changes nothing
    expect(await audits('admin.request_approved')).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: s2.userId, targetId: t.userId })]));
  });

  it('a plain admin cannot approve a role request; a super_admin can promote to super_admin', async () => {
    const s1 = await superAdmin();
    const s2 = await superAdmin();
    const a = await admin();
    const t = await makeUser();
    const { requestId } = await (await patch(s1.cookie, t.userId, { role: 'super_admin', reason: 'second owner' })).json();
    const res = await decide(a.cookie, requestId);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('super_admin_required');
    expect((await decide(s2.cookie, requestId)).status).toBe(200);
    const [now] = await getDb().select().from(accounts).where(eq(accounts.userId, t.userId));
    expect(now.role).toBe('super_admin');
  });

  it('with only one super_admin a promotion is blocked (409 no_second_approver)', async () => {
    const s1 = await superAdmin();
    await admin(); // an admin cannot approve a role change
    const t = await makeUser();
    const res = await patch(s1.cookie, t.userId, { role: 'admin', reason: 'new admin' });
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.code).toBe('no_second_approver');
    expect(j.message_ar).toMatch(/[\u0600-\u06FF]/);
  });

  it('a super_admin can use the admin routes (passes the admin check, MFA still applies)', async () => {
    const s = await superAdmin();
    expect((await users.GET(req('/api/admin/users', { cookie: s.cookie }), idp('x'))).status).toBe(200);
    const noMfa = await makeUser({ role: 'super_admin', mfaVerifiedAt: null });
    const res = await users.GET(req('/api/admin/users', { cookie: noMfa.cookie }), idp('x'));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('mfa_required');
  });
});

describe('role change timing and suspension', () => {
  it('a role change applies on the target\'s next request, with the same cookie', async () => {
    const s = await superAdmin();
    const a = await admin();
    expect((await users.GET(req('/api/admin/users', { cookie: a.cookie }), idp('x'))).status).toBe(200);
    expect((await patch(s.cookie, a.userId, { role: 'customer' })).status).toBe(200);
    const res = await users.GET(req('/api/admin/users', { cookie: a.cookie }), idp('x'));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('forbidden');
    // And a promotion shows on the very next request too (MFA is asked again, which proves the new role is read).
    await getDb().update(accounts).set({ role: 'admin' }).where(eq(accounts.userId, a.userId));
    expect((await (await users.GET(req('/api/admin/users', { cookie: a.cookie }), idp('x'))).json()).code).toBe('mfa_required');
  });

  it('suspension still ends the target\'s sessions', async () => {
    const s = await superAdmin();
    const a = await admin();
    expect((await patch(s.cookie, a.userId, { status: 'suspended' })).status).toBe(200);
    expect(await getDb().select().from(sessions).where(eq(sessions.userId, a.userId))).toHaveLength(0);
    expect((await users.GET(req('/api/admin/users', { cookie: a.cookie }), idp('x'))).status).toBe(401);
  });

  it('a promotion that is approved clears the target\'s MFA verification', async () => {
    const s1 = await superAdmin();
    const s2 = await superAdmin();
    const t = await makeUser({ mfaVerifiedAt: Date.now() });
    const { requestId } = await (await patch(s1.cookie, t.userId, { role: 'admin', reason: 'new admin' })).json();
    await decide(s2.cookie, requestId);
    const res = await users.GET(req('/api/admin/users', { cookie: t.cookie }), idp('x'));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('mfa_required');
  });
});

describe('ADMIN_EMAILS grant', () => {
  const BOSS = 'boss@example.test';
  const withEmails = async (fn: () => Promise<void>, breakGlass?: string) => {
    env.ADMIN_EMAILS = BOSS;
    if (breakGlass) env.ADMIN_EMAILS_BREAKGLASS = breakGlass;
    try { await fn(); } finally { delete env.ADMIN_EMAILS; delete env.ADMIN_EMAILS_BREAKGLASS; }
  };
  const boss = () => makeUser({ role: 'customer', email: `${crypto.randomUUID().slice(0, 8)}-${BOSS}`, mfaVerifiedAt: Date.now() });
  const bossEmail = async (u: { email: string }) => { env.ADMIN_EMAILS = u.email; };

  it('no super_admin yet: the email grants admin (standing grant, no audit row)', async () => {
    const u = await boss();
    await withEmails(async () => {
      await bossEmail(u);
      const p = await getPrincipal(req('/x', { cookie: u.cookie }));
      expect(p).toMatchObject({ role: 'admin', breakGlass: false });
    });
  });

  it('a super_admin exists, break-glass off (default): the email grants nothing', async () => {
    await superAdmin();
    const u = await boss();
    await withEmails(async () => {
      await bossEmail(u);
      expect((await getPrincipal(req('/x', { cookie: u.cookie })))?.role).toBe('customer');
      const res = await users.GET(req('/api/admin/users', { cookie: u.cookie }), idp('x'));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('forbidden');
    });
  });

  it('break-glass off for any value except "true"', async () => {
    await superAdmin();
    const u = await boss();
    await withEmails(async () => {
      await bossEmail(u);
      env.ADMIN_EMAILS_BREAKGLASS = '1';
      expect((await getPrincipal(req('/x', { cookie: u.cookie })))?.role).toBe('customer');
    });
  });

  it('a super_admin exists, break-glass on: admin (never super_admin), MFA required, every use audited', async () => {
    await superAdmin();
    const u = await boss();
    const noMfa = await makeUser({ role: 'customer', email: `nomfa-${crypto.randomUUID().slice(0, 8)}@example.test`, mfaVerifiedAt: null });
    await withEmails(async () => {
      env.ADMIN_EMAILS = `${u.email},${noMfa.email}`;
      const p = await getPrincipal(req('/x', { cookie: u.cookie }));
      expect(p).toMatchObject({ role: 'admin', breakGlass: true });
      const denied = await users.GET(req('/api/admin/users', { cookie: noMfa.cookie }), idp('x'));
      expect(denied.status).toBe(403);
      expect((await denied.json()).code).toBe('mfa_required');
      const before = (await audits('auth.break_glass_used')).filter(r => r.actorId === u.userId).length;
      expect((await users.GET(req('/api/admin/users', { cookie: u.cookie }), idp('x'))).status).toBe(200);
      expect((await users.GET(req('/api/admin/users', { cookie: u.cookie }), idp('x'))).status).toBe(200);
      expect((await audits('auth.break_glass_used')).filter(r => r.actorId === u.userId).length).toBe(before + 2);
      expect((await audits('auth.break_glass_used')).filter(r => r.actorId === noMfa.userId)).toHaveLength(0); // refused before use
      // It does not reach super_admin powers.
      const target = await makeUser();
      const res = await patch(u.cookie, target.userId, { role: 'admin', reason: 'try it' });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('super_admin_required');
    }, 'true');
  });

  it('a stored super_admin listed in ADMIN_EMAILS stays super_admin', async () => {
    const s = await makeUser({ role: 'super_admin', email: `sa-${crypto.randomUUID().slice(0, 8)}@example.test` });
    await withEmails(async () => {
      env.ADMIN_EMAILS = s.email;
      expect((await getPrincipal(req('/x', { cookie: s.cookie })))?.role).toBe('super_admin');
    });
  });

  it('a suspended super_admin does not count as existing', async () => {
    const s = await superAdmin();
    await getDb().update(accounts).set({ status: 'suspended' }).where(and(eq(accounts.userId, s.userId)));
    const u = await boss();
    await withEmails(async () => {
      await bossEmail(u);
      expect((await getPrincipal(req('/x', { cookie: u.cookie })))?.role).toBe('admin');
    });
  });
});
