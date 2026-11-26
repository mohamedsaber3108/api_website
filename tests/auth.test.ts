import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { accounts, sessions } from '../db/schema';
import { createSession, getPrincipal, requireRole, requireUser } from '../lib/server/auth';
import { hashPassword, safeEqual, sha256Hex, verifyPassword } from '../lib/server/crypto';
import { HttpError } from '../lib/server/http';
import { makeUser, req, startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });

describe('password hash', () => {
  it('hashes as pbkdf2$100000$salt$hash and verifies the right password', async () => {
    const stored = await hashPassword('correct-horse-battery');
    expect(stored).toMatch(/^pbkdf2\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
    expect(await verifyPassword('correct-horse-battery', stored)).toBe(true);
  });
  it('rejects a wrong password, and the stored value never contains the password', async () => {
    const stored = await hashPassword('correct-horse-battery');
    expect(await verifyPassword('correct-horse-batterX', stored)).toBe(false);
    expect(stored).not.toContain('correct-horse-battery');
  });
  it('uses a fresh salt each time', async () => {
    expect(await hashPassword('same-password-123')).not.toBe(await hashPassword('same-password-123'));
  });
  it('rejects null, empty and malformed stored values without throwing', async () => {
    for (const bad of [null, '', 'plaintext', 'bcrypt$1$aa$bb', 'pbkdf2$100000$aa']) expect(await verifyPassword('x'.repeat(12), bad)).toBe(false);
  });
  it('caps a stored iteration count at 100000 (no CPU-bomb hash)', async () => {
    const real = await hashPassword('correct-horse-battery');
    const [, , salt, hash] = real.split('$');
    expect(await verifyPassword('correct-horse-battery', `pbkdf2$999999999$${salt}$${hash}`)).toBe(true);
  });
  it('safeEqual compares by content and length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('sessions', () => {
  it('a valid cookie resolves to the user with role customer', async () => {
    const u = await makeUser();
    const p = await getPrincipal(req('/x', { cookie: u.cookie }));
    expect(p?.userId).toBe(u.userId);
    expect(p?.role).toBe('customer');
  });
  it('no cookie, unknown token and garbage cookie resolve to null', async () => {
    expect(await getPrincipal(req('/x'))).toBeNull();
    expect(await getPrincipal(req('/x', { cookie: 'wasl_session=deadbeef' }))).toBeNull();
    expect(await getPrincipal(req('/x', { cookie: 'other=1' }))).toBeNull();
  });
  it('an expired session is refused', async () => {
    const u = await makeUser({ expiresAt: Date.now() - 1000 });
    expect(await getPrincipal(req('/x', { cookie: u.cookie }))).toBeNull();
  });
  it('a session on a suspended account is refused', async () => {
    const u = await makeUser({ status: 'suspended' });
    expect(await getPrincipal(req('/x', { cookie: u.cookie }))).toBeNull();
  });
  it('a deleted session row stops working (logout)', async () => {
    const u = await makeUser();
    const token = u.cookie.split('=')[1];
    await getDb().delete(sessions).where(eq(sessions.id, await sha256Hex(token)));
    expect(await getPrincipal(req('/x', { cookie: u.cookie }))).toBeNull();
  });
  it('createSession stores only the SHA-256 of the token and sets an HttpOnly cookie', async () => {
    const u = await makeUser();
    const setCookie = await createSession(req('/x'), u.userId);
    expect(setCookie).toMatch(/^wasl_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    const token = setCookie.split(';')[0].split('=')[1];
    const rows = await getDb().select().from(sessions).where(eq(sessions.id, await sha256Hex(token)));
    expect(rows).toHaveLength(1);
    expect(rows[0].expiresAt - rows[0].createdAt).toBe(30 * 24 * 3600 * 1000);
    expect(await getDb().select().from(sessions).where(eq(sessions.id, token))).toHaveLength(0);
  });
  it('ADMIN_EMAILS grants admin only when the email is verified', async () => {
    env.ADMIN_EMAILS = 'boss@example.test';
    try {
      const verified = await makeUser({ email: 'boss@example.test', verified: true });
      expect((await getPrincipal(req('/x', { cookie: verified.cookie })))?.role).toBe('admin');
      const unverified = await makeUser({ email: 'boss2@example.test', verified: false });
      env.ADMIN_EMAILS = 'boss2@example.test';
      expect((await getPrincipal(req('/x', { cookie: unverified.cookie })))?.role).toBe('customer');
    } finally { delete env.ADMIN_EMAILS; }
  });
  it('identity headers are ignored unless TRUST_CHATGPT_HEADERS=true (no header spoofing)', async () => {
    const headers = { 'oai-authenticated-user-id': 'spoof', 'oai-authenticated-user-email': 'spoof@example.test' };
    expect(await getPrincipal(req('/x', { headers }))).toBeNull();
    expect(await getDb().select().from(accounts).where(eq(accounts.userId, 'spoof'))).toHaveLength(0);
  });
  it('requireUser throws 401 sign_in_required; requireRole throws 403 forbidden', async () => {
    await expect(requireUser(req('/x'))).rejects.toMatchObject({ status: 401, code: 'sign_in_required' });
    const u = await makeUser();
    const err = await requireRole(req('/x', { cookie: u.cookie }), 'admin').catch(e => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 403, code: 'forbidden' });
    const admin = await makeUser({ role: 'admin' });
    expect((await requireRole(req('/x', { cookie: admin.cookie }), 'admin')).role).toBe('admin');
  });
});
