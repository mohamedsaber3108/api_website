import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as audit from '../app/api/admin/audit/route';
import * as incidents from '../app/api/admin/incidents/route';
import * as models from '../app/api/admin/models/route';
import * as requestById from '../app/api/admin/requests/[id]/route';
import * as credits from '../app/api/admin/users/[id]/credits/route';
import * as userById from '../app/api/admin/users/[id]/route';
import * as begin from '../app/api/auth/mfa/begin/route';
import * as confirm from '../app/api/auth/mfa/confirm/route';
import * as verify from '../app/api/auth/mfa/verify/route';
import * as register from '../app/api/auth/register/route';
import { getDb } from '../db';
import { accounts, adminRequests, auditLogs, modelConfigs } from '../db/schema';
import { chainHash, GENESIS, redact, verifyChain } from '../lib/audit-chain.mjs';
import { audit as writeAudit } from '../lib/server/audit';
import { base32Decode, currentStep, hotp } from '../lib/server/mfa';
import { getBalanceMicroUsd } from '../lib/server/ledger';
import { makeUser, newSession, req, startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });

type Handler = (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
const idp = (id: string) => ({ params: Promise.resolve({ id }) });
const call = (fn: unknown, r: Request, id = 'x') => (fn as Handler)(r, idp(id));
const rows = () => getDb().select().from(auditLogs).where(isNotNull(auditLogs.seq)).orderBy(asc(auditLogs.seq));
const byAction = async (action: string) => (await getDb().select().from(auditLogs).where(eq(auditLogs.action, action))).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
const chainOk = async () => verifyChain(await getDb().select().from(auditLogs));
const feed = async (cookie: string, qs = '') => (await (await call(audit.GET, req(`/api/admin/audit${qs}`, { cookie }))).json()).events as Array<{ id: string; action: string; actorEmail: string | null }>;
const patch = (cookie: string, id: string, body: object) => call(userById.PATCH, req(`/api/admin/users/${id}`, { method: 'PATCH', cookie, body }), id);
const putModel = (cookie: string, body: object) => call(models.PUT, req('/api/admin/models', { method: 'PUT', cookie, body }));
const flag = (on: boolean) => (env.DB as D1Database).prepare('UPDATE test_audit_flag SET on_ = ?1').bind(on ? 1 : 0).run();

describe('hash chain', () => {
  it('20 parallel audit writes give one unbroken chain with no repeated previous hash', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeAudit(null, null, 'test.parallel', { type: 'test', id: String(i) }, { i })));
    const all = (await rows()).filter(r => r.action === 'test.parallel');
    expect(all).toHaveLength(20);
    const chained = await rows();
    expect(chained.map(r => r.seq)).toEqual(chained.map((_, i) => i + 1)); // 1..N, no gap, no repeat
    expect(new Set(chained.map(r => r.prevHash)).size).toBe(chained.length); // nobody shares a previous hash: no fork
    const v = await chainOk();
    expect(v).toMatchObject({ ok: true, firstBroken: null });
    expect(v.checked).toBe(chained.length);
  });

  it('the first hashed row starts at GENESIS and old rows without a hash are counted, not checked', async () => {
    const legacy = { id: 'legacy-1', actorId: null, action: 'old.row', targetType: null, targetId: null, meta: null, ip: null, createdAt: 1000 };
    await getDb().insert(auditLogs).values(legacy);
    const [first] = (await rows()).filter(r => r.seq !== null);
    expect(first.prevHash).toBe(GENESIS);
    const v = await chainOk();
    expect(v.ok).toBe(true);
    expect(v.unhashedBeforeChain).toBe(1);
  });

  it('editing, deleting or re-pointing a row in a scratch copy is flagged at the right row', async () => {
    for (let i = 0; i < 5; i++) await writeAudit(null, 'a1', 'test.tamper', { type: 'test', id: String(i) }, { n: i });
    const base = (await getDb().select().from(auditLogs).where(isNotNull(auditLogs.seq))).sort((a, b) => a.seq! - b.seq!);
    const mid = base[Math.floor(base.length / 2)];
    // edited content
    const edited = base.map(r => (r.seq === mid.seq ? { ...r, action: 'test.changed' } : r));
    expect(await verifyChain(edited)).toMatchObject({ ok: false, firstBroken: { seq: mid.seq, reason: 'row_content_does_not_match_its_hash' } });
    // deleted row
    const deleted = base.filter(r => r.seq !== mid.seq);
    expect(await verifyChain(deleted)).toMatchObject({ ok: false, firstBroken: { seq: mid.seq! + 1, reason: 'missing_rows_before_this_seq' } });
    // deleted first rows
    expect(await verifyChain(base.slice(1))).toMatchObject({ ok: false, firstBroken: { seq: 2 } });
    // row edited AND its hash recomputed: the next row's link breaks
    const forged = await chainHash({ ...mid, seq: mid.seq!, prevHash: mid.prevHash!, meta: '{"n":99}' });
    const rehashed = base.map(r => (r.seq === mid.seq ? { ...r, meta: '{"n":99}', hash: forged } : r));
    expect(await verifyChain(rehashed)).toMatchObject({ ok: false, firstBroken: { seq: mid.seq! + 1, reason: 'prev_hash_does_not_match_previous_row' } });
  });

  it('scripts/verify-audit.mjs reads a SQLite file and names the first broken row (exit 1); intact file exits 0', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'audit-verify-'));
    const file = path.join(dir, 'scratch.sqlite');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE audit_logs (id text primary key, actor_id text, action text not null, target_type text, target_id text, meta text, ip text, created_at integer not null, seq integer, prev_hash text, hash text, actor_role text, `before` text, `after` text, reason text, result text)');
    const ins = db.prepare('INSERT INTO audit_logs (id, actor_id, action, created_at, seq, prev_hash, hash, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    let prev = GENESIS;
    for (let seq = 1; seq <= 4; seq++) {
      const f = { seq, id: `r${seq}`, actorId: 'u1', actorRole: null, action: 'x.y', targetType: null, targetId: null, meta: null, before: null, after: null, reason: null, result: 'success', ip: null, createdAt: 2000 + seq, prevHash: prev };
      const hash = await chainHash(f);
      ins.run(f.id, 'u1', 'x.y', f.createdAt, seq, prev, hash, 'success');
      prev = hash;
    }
    db.close();
    const script = path.resolve(__dirname, '../scripts/verify-audit.mjs');
    const okRun = spawnSync('node', ['--no-warnings', script, file], { encoding: 'utf8' });
    expect(okRun.status).toBe(0);
    expect(okRun.stdout).toContain('OK: 4 chained rows intact');
    const w = new DatabaseSync(file);
    w.exec("UPDATE audit_logs SET action = 'x.edited' WHERE seq = 3");
    w.close();
    const bad = spawnSync('node', ['--no-warnings', script, file], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('BROKEN at seq 3');
    expect(spawnSync('node', ['--no-warnings', script, path.join(dir, 'missing.sqlite')], { encoding: 'utf8' }).status).toBe(2);
    // export hook: off without --out, writes rows and a tail line with --out
    const exporter = path.resolve(__dirname, '../scripts/export-audit.mjs');
    expect(execFileSync('node', ['--no-warnings', exporter, file], { encoding: 'utf8' })).toContain('OFF');
    const out = path.join(dir, 'out.jsonl');
    execFileSync('node', ['--no-warnings', exporter, file, '--out', out, '--after', '2'], { encoding: 'utf8' });
    const lines = readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => l.seq)).toEqual([3, 4, undefined]);
    expect(lines[2].tail.seq).toBe(4);
    writeFileSync(path.join(dir, 'done'), '1');
  });
});

describe('denied attempts are written', () => {
  it('support, customer and an admin without MFA are refused on admin routes and each leaves a denied row', async () => {
    const support = await makeUser({ role: 'support' });
    const customer = await makeUser();
    const noMfa = await makeUser({ role: 'admin', mfaVerifiedAt: null });
    for (const u of [support, customer]) expect((await call(models.PUT, req('/api/admin/models', { method: 'PUT', cookie: u.cookie, body: { modelId: 'x/y', enabled: true, markupPercent: 5 } }))).status).toBe(403);
    expect((await call(audit.GET, req('/api/admin/audit', { cookie: noMfa.cookie }))).status).toBe(403);
    const denied = await byAction('auth.admin_denied');
    const mine = (id: string) => denied.filter(r => r.actorId === id);
    expect(mine(support.userId)).toEqual([expect.objectContaining({ result: 'denied', reason: 'role_not_allowed', actorRole: 'support', targetId: '/api/admin/models' })]);
    expect(mine(customer.userId)).toHaveLength(1);
    expect(mine(noMfa.userId)).toEqual([expect.objectContaining({ result: 'denied', reason: 'mfa_required' })]);
    expect((await chainOk()).ok).toBe(true);
  });

  it('a wrong MFA code writes a denied row', async () => {
    const a = await makeUser({ role: 'admin', mfaVerifiedAt: null });
    const { secret } = await (await call(begin.POST, req('/api/auth/mfa/begin', { method: 'POST', cookie: a.cookie, body: {} }))).json();
    const ok = await call(confirm.POST, req('/api/auth/mfa/confirm', { method: 'POST', cookie: a.cookie, body: { code: await hotp(base32Decode(secret), currentStep()) } }));
    expect(ok.status).toBe(200);
    const bad = await call(verify.POST, req('/api/auth/mfa/verify', { method: 'POST', cookie: await newSession(a.userId), body: { code: '000000' } }));
    expect(bad.status).toBe(401);
    expect((await byAction('auth.mfa_verify_failed')).filter(r => r.actorId === a.userId)).toEqual([expect.objectContaining({ result: 'denied', reason: 'wrong_code' })]);
  });

  it('self-approval, an admin changing an admin, changing yourself, and a stale request each leave a denied row', async () => {
    const s1 = await makeUser({ role: 'super_admin' });
    const s2 = await makeUser({ role: 'super_admin' });
    const admin = await makeUser({ role: 'admin' });
    const t = await makeUser();
    const made = await call(userById.PATCH, req(`/api/admin/users/${t.userId}`, { method: 'PATCH', cookie: s1.cookie, body: { role: 'admin', reason: 'needs the console' } }), t.userId);
    expect(made.status).toBe(202);
    const { requestId } = await made.json();
    const decide = (cookie: string) => call(requestById.POST, req(`/api/admin/requests/${requestId}`, { method: 'POST', cookie, body: { action: 'approve', reason: 'checked it' } }), requestId);
    expect((await decide(s1.cookie)).status).toBe(403);
    expect((await patch(admin.cookie, s1.userId, { status: 'suspended' })).status).toBe(403);
    expect((await patch(admin.cookie, admin.userId, { status: 'suspended' })).status).toBe(400);
    await getDb().update(accounts).set({ role: 'support' }).where(eq(accounts.userId, t.userId)); // the world changed after the request
    expect((await decide(s2.cookie)).status).toBe(409);
    const mine = (action: string, id: string) => byAction(action).then(r => r.filter(x => x.actorId === id));
    expect(await mine('admin.request_denied', s1.userId)).toEqual([expect.objectContaining({ result: 'denied', reason: 'self_approval' })]);
    expect(await mine('admin.user_update_denied', admin.userId)).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'super_admin_required', result: 'denied' }), expect.objectContaining({ reason: 'self_change' })]));
    expect(await mine('admin.request_rejected', s2.userId)).toEqual([expect.objectContaining({ result: 'denied', reason: 'stale' })]);
  });
});

describe('a sensitive action fails when its audit row cannot be written', () => {
  beforeAll(async () => {
    const d = env.DB as D1Database;
    await d.prepare('CREATE TABLE test_audit_flag (on_ integer)').run();
    await d.prepare('INSERT INTO test_audit_flag VALUES (0)').run();
    await d.prepare("CREATE TRIGGER test_audit_fail BEFORE INSERT ON audit_logs WHEN (SELECT on_ FROM test_audit_flag) = 1 BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END").run();
  });

  it('role change, suspension, model markup and credit approval give 503 and change nothing; non-sensitive actions still work', async () => {
    const s = await makeUser({ role: 'super_admin' });
    const s2 = await makeUser({ role: 'super_admin' });
    const t = await makeUser();
    const t2 = await makeUser();
    // a credit request made while the log works
    const made = await call(credits.POST, req(`/api/admin/users/${t2.userId}/credits`, { method: 'POST', cookie: s.cookie, body: { amountUsd: 5, note: 'goodwill credit' } }), t2.userId);
    expect(made.status).toBe(202);
    const { requestId } = await made.json();
    await flag(true);
    try {
      const before = (await getDb().select().from(auditLogs)).length;
      const r1 = await patch(s.cookie, t.userId, { role: 'support' });
      expect(r1.status).toBe(503);
      expect((await r1.json()).code).toBe('audit_unavailable');
      expect((await getDb().select().from(accounts).where(eq(accounts.userId, t.userId)))[0].role).toBe('customer');
      expect((await patch(s.cookie, t.userId, { status: 'suspended' })).status).toBe(503);
      expect((await getDb().select().from(accounts).where(eq(accounts.userId, t.userId)))[0].status).toBe('active');
      expect((await putModel(s.cookie, { modelId: 'x/audit-model', enabled: true, markupPercent: 9 })).status).toBe(503);
      expect(await getDb().select().from(modelConfigs).where(eq(modelConfigs.modelId, 'x/audit-model'))).toHaveLength(0);
      const approve = await call(requestById.POST, req(`/api/admin/requests/${requestId}`, { method: 'POST', cookie: s2.cookie, body: { action: 'approve', reason: 'checked it' } }), requestId);
      expect(approve.status).toBe(503);
      expect((await getDb().select().from(adminRequests).where(eq(adminRequests.id, requestId)))[0].status).toBe('pending');
      expect(await getBalanceMicroUsd(t2.userId)).toBe(0);
      // a request cannot be created without its audit row either; it is closed, not left pending
      const r2 = await call(userById.PATCH, req(`/api/admin/users/${t.userId}`, { method: 'PATCH', cookie: s.cookie, body: { role: 'admin', reason: 'needs the console' } }), t.userId);
      expect(r2.status).toBe(503);
      expect((await getDb().select().from(adminRequests).where(and(eq(adminRequests.targetUserId, t.userId), eq(adminRequests.status, 'pending')))).length).toBe(0);
      // non-sensitive path: today's behaviour, the action works and the failure is only logged
      const inc = await call(incidents.POST, req('/api/admin/incidents', { method: 'POST', cookie: s.cookie, body: { title: 'Slow replies', body: 'We are looking at it.', severity: 'minor' } }));
      expect(inc.status).toBeLessThan(300);
      expect((await getDb().select().from(auditLogs)).length).toBe(before);
    } finally {
      await flag(false);
    }
    // log back: the same actions now work and are written
    expect((await patch(s.cookie, t.userId, { role: 'support' })).status).toBe(200);
    const row = (await byAction('admin.user_updated')).find(r => r.targetId === t.userId)!;
    expect(row).toMatchObject({ result: 'success', actorRole: 'super_admin' });
    expect(JSON.parse(row.before!)).toMatchObject({ role: 'customer' });
    expect(JSON.parse(row.after!)).toMatchObject({ role: 'support' });
    expect((await call(requestById.POST, req(`/api/admin/requests/${requestId}`, { method: 'POST', cookie: s2.cookie, body: { action: 'approve', reason: 'checked it' } }), requestId)).status).toBe(200);
    expect(await getBalanceMicroUsd(t2.userId)).toBe(5_000_000);
    expect((await chainOk()).ok).toBe(true);
  });
});

describe('viewer filters', () => {
  it('filters by actor (id and e-mail), action, target, result and date; shows actor e-mail; old rows still load', async () => {
    const admin = await makeUser({ role: 'admin' });
    const other = await makeUser({ role: 'support' });
    await writeAudit(null, other.userId, 'filter.alpha', { type: 'widget', id: 'w-1' }, undefined, { result: 'denied', reason: 'because' });
    await writeAudit(null, other.userId, 'filter.beta', { type: 'gadget', id: 'g-9' });
    const a = await feed(admin.cookie, `?actor=${other.userId}`);
    expect(a.map(e => e.action).sort()).toEqual(['filter.alpha', 'filter.beta']);
    expect(a[0].actorEmail).toBe(`${other.userId}@example.test`);
    expect((await feed(admin.cookie, `?actor=${encodeURIComponent(other.email)}`)).length).toBe(2);
    expect((await feed(admin.cookie, '?action=ALPHA')).map(e => e.id)).toEqual([a.find(e => e.action === 'filter.alpha')!.id]);
    expect((await feed(admin.cookie, '?target=g-9')).map(e => e.action)).toEqual(['filter.beta']);
    expect((await feed(admin.cookie, '?target=widget')).map(e => e.action)).toEqual(['filter.alpha']);
    expect((await feed(admin.cookie, `?actor=${other.userId}&result=denied`)).map(e => e.action)).toEqual(['filter.alpha']);
    const now = Date.now();
    expect((await feed(admin.cookie, `?actor=${other.userId}&from=${now + 60_000}`)).length).toBe(0);
    expect((await feed(admin.cookie, `?actor=${other.userId}&to=${now - 60_000}`)).length).toBe(0);
    expect((await feed(admin.cookie, `?actor=${other.userId}&from=${now - 60_000}&to=${now + 60_000}`)).length).toBe(2);
    expect((await feed(admin.cookie, '?action=old.row')).map(e => e.id)).toEqual(['legacy-1']); // a row from before the chain still loads
  });
});

describe('no secret reaches the audit log', () => {
  it('redacts secret keys and secret-shaped values', () => {
    const out = redact({ ok: 'fine', password: 'FAKE-PW-1', nested: { apiKey: 'FAKE-KEY', mfaCode: '123456', note: 'sk-FAKESECRET1234567890' }, list: ['Bearer FAKEBEARERTOKEN12345'], requestKey: 'req-1' });
    expect(JSON.stringify(out)).not.toMatch(/FAKE/);
    expect(out.ok).toBe('fine');
    expect(out.requestKey).toBe('req-1');
  });

  it('a sign-up with a fake password and a direct write with fake secrets leave none of them in any audit column', async () => {
    const PASSWORD = 'Fake-Pa55word-NOT-REAL-1';
    const res = await call(register.POST, req('/api/auth/register', { method: 'POST', body: { email: 'audit-secret@example.test', password: PASSWORD, name: 'Audit Secret', acceptTerms: true } }));
    expect(res.status).toBeLessThan(300);
    await writeAudit(null, null, 'test.secret', { type: 'test', id: '1' }, { password: PASSWORD, token: 'FAKE-TOKEN-ABC', detail: 'Bearer FAKEBEARERTOKEN12345' }, { before: { secret: 'FAKE-SECRET' }, after: { recoveryCode: 'FAKE-RC' }, reason: 'wasl_session=FAKESESSIONVALUE' });
    const dump = JSON.stringify(await getDb().select().from(auditLogs));
    for (const bad of [PASSWORD, 'FAKE-TOKEN-ABC', 'FAKEBEARERTOKEN12345', 'FAKE-SECRET', 'FAKE-RC', 'FAKESESSIONVALUE']) expect(dump).not.toContain(bad);
    expect(dump).toContain('[redacted]');
  });
});
