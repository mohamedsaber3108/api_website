import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { accounts, auditLogs } from '../db/schema';
import { POST as register } from '../app/api/auth/register/route';
import { POST as verifyEmail } from '../app/api/auth/verify-email/route';
import { POST as resetPassword } from '../app/api/auth/reset-password/route';
import { createAuthToken } from '../lib/server/auth';
import { normalizeEmail } from '../lib/server/bonus';
import { addLedgerEntry, getBalanceMicroUsd } from '../lib/server/ledger';
import { req, startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });
beforeEach(() => { env.APP_ENV = 'development'; env.SIGNUP_BONUS_USD = '5'; });
afterEach(() => { delete env.APP_ENV; delete env.SIGNUP_BONUS_USD; });

let n = 0;
const nextIp = () => ({ 'cf-connecting-ip': `198.51.100.${++n}` });
const ctx = { params: Promise.resolve({}) };

async function signUp(email: string) {
  const res = await register(req('/api/auth/register', { method: 'POST', headers: nextIp(), body: { email, password: 'correct-horse-battery', name: 'Test User', acceptTerms: true } }), ctx);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { user: { id: string }; dev_verify_token: string };
  return { userId: body.user.id, token: body.dev_verify_token };
}
const verify = (token: string) => verifyEmail(req('/api/auth/verify-email', { method: 'POST', headers: nextIp(), body: { token } }), ctx);

describe('normalizeEmail', () => {
  it('folds case, +tags and Gmail dots; leaves other domains\' dots alone', () => {
    expect(normalizeEmail('Jo.Hn+promo@Gmail.com')).toBe('john@gmail.com');
    expect(normalizeEmail('john@googlemail.com')).toBe('john@gmail.com');
    expect(normalizeEmail('jo.hn+x@example.org')).toBe('jo.hn@example.org');
  });
});

describe('sign-up bonus: once per verified e-mail, no schema change', () => {
  it('is not granted at registration, only after the e-mail is verified, and only once', async () => {
    const { userId, token } = await signUp('first@example.test');
    expect(await getBalanceMicroUsd(userId)).toBe(0);
    expect((await verify(token)).status).toBe(200);
    expect(await getBalanceMicroUsd(userId)).toBe(5_000_000);
    expect((await verify(token)).status).toBe(400); // the token is single use
    expect(await getBalanceMicroUsd(userId)).toBe(5_000_000);
  });

  it('registering the same e-mail twice gives 409 and no second bonus', async () => {
    const a = await signUp('twice@example.test');
    await verify(a.token);
    const again = await register(req('/api/auth/register', { method: 'POST', headers: nextIp(), body: { email: 'TWICE@example.test', password: 'correct-horse-battery', name: 'Test User', acceptTerms: true } }), ctx);
    expect(again.status).toBe(409);
    expect(await getBalanceMicroUsd(a.userId)).toBe(5_000_000);
  });

  it('Gmail aliases of one mailbox get one bonus in total', async () => {
    const a = await signUp('alias.person@gmail.com');
    const b = await signUp('aliasperson+second@gmail.com');
    const c = await signUp('alias.person+third@googlemail.com');
    for (const u of [a, b, c]) await verify(u.token);
    const balances = await Promise.all([a, b, c].map(u => getBalanceMicroUsd(u.userId)));
    expect(balances.reduce((x, y) => x + y, 0)).toBe(5_000_000);
    expect(balances[0]).toBe(5_000_000); // the first to verify gets it
  });

  it('an unverified account never gets the bonus', async () => {
    const { userId } = await signUp('never@example.test');
    expect(await getBalanceMicroUsd(userId)).toBe(0);
  });

  it('a password reset also proves the mailbox, and the bonus is still granted once', async () => {
    const { userId, token } = await signUp('viareset@example.test');
    const reset = await createAuthToken(userId, 'reset_password', 3600_000);
    const res = await resetPassword(req('/api/auth/reset-password', { method: 'POST', headers: nextIp(), body: { token: reset, password: 'another-long-password' } }), ctx);
    expect(res.status).toBe(200);
    expect(await getBalanceMicroUsd(userId)).toBe(5_000_000);
    await verify(token);
    expect(await getBalanceMicroUsd(userId)).toBe(5_000_000);
  });

  it('an account already paid under the old registration key gets no second credit', async () => {
    const { userId, token } = await signUp('legacy@example.test');
    await addLedgerEntry({ userId, deltaMicroUsd: 5_000_000, type: 'bonus', idempotencyKey: `bonus:signup:${userId}`, note: 'Sign-up credit' });
    expect((await verify(token)).status).toBe(200);
    expect(await getBalanceMicroUsd(userId)).toBe(5_000_000);
  });

  it('a bonus failure after verification still answers 200 and keeps the account verified', async () => {
    const { userId, token } = await signUp('hiccup@example.test');
    const ledger = await import('../lib/server/ledger');
    const spy = vi.spyOn(ledger, 'addLedgerEntry').mockRejectedValueOnce(new Error('D1 hiccup for hiccup@example.test'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await verify(token)).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1); // the failure really happened
      expect(log).toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain('hiccup@example.test');
    } finally { spy.mockRestore(); log.mockRestore(); }
    const [row] = await getDb().select().from(accounts).where(eq(accounts.userId, userId));
    expect(row!.emailVerifiedAt).not.toBeNull();
  });

  it('the reset path writes the domain-only metric row too', async () => {
    const { userId } = await signUp('resetmetric@disposable.example');
    const reset = await createAuthToken(userId, 'reset_password', 3600_000);
    await resetPassword(req('/api/auth/reset-password', { method: 'POST', headers: nextIp(), body: { token: reset, password: 'another-long-password' } }), ctx);
    const rows = await getDb().select().from(auditLogs).where(eq(auditLogs.actorId, userId));
    expect(rows.filter(r => r.action === 'auth.signup_bonus').map(r => r.meta)).toEqual(['{"domain":"disposable.example"}']);
  });

  it('records one metric row per grant with the domain only, never the address', async () => {
    const { userId, token } = await signUp('metric@disposable.example');
    await verify(token);
    await verify(token);
    const rows = await getDb().select().from(auditLogs).where(eq(auditLogs.actorId, userId));
    const bonus = rows.filter(r => r.action === 'auth.signup_bonus');
    expect(bonus).toHaveLength(1);
    expect(bonus[0]!.meta).toBe('{"domain":"disposable.example"}');
  });

  it('SIGNUP_BONUS_USD unset grants nothing', async () => {
    delete env.SIGNUP_BONUS_USD;
    const { userId, token } = await signUp('nobonus@example.test');
    await verify(token);
    expect(await getBalanceMicroUsd(userId)).toBe(0);
    const [row] = await getDb().select().from(accounts).where(eq(accounts.userId, userId));
    expect(row!.emailVerifiedAt).not.toBeNull();
  });
});
