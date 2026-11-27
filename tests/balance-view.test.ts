import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../db';
import { creditHolds } from '../db/schema';
import { GET as v1Balance } from '../app/api/v1/balance/route';
import { GET as billingGet } from '../app/api/billing/route';
import { GET as accountGet } from '../app/api/account/route';
import { createApiKey } from '../lib/server/keys';
import { addLedgerEntry, getAvailableMicroUsd, getBalanceSummary } from '../lib/server/ledger';
import { makeUser, req, startDb } from './helpers/db';

// FU-5: balance views show the ledger balance, the open unexpired holds, and the available amount.
let h: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });

async function funded(micro: number) {
  const u = await makeUser();
  await addLedgerEntry({ userId: u.userId, deltaMicroUsd: micro, type: 'topup', idempotencyKey: `fund:${u.userId}` });
  return u;
}
let n = 0;
async function hold(userId: string, amount: number, status = 'open', expiresIn = 600_000) {
  const now = Date.now();
  await getDb().insert(creditHolds).values({ id: crypto.randomUUID(), userId, requestId: `r${++n}-${userId}`, amountMicroUsd: amount, status, createdAt: now, expiresAt: now + expiresIn });
}
const key = async (userId: string, scopes: string[]) => (await createApiKey(userId, { name: 'k', scopes, expiresAt: null, rateLimitPerMin: 60 })).secret;
const noCtx = { params: Promise.resolve({}) };
const bearer = (secret: string) => req('/api/v1/balance', { headers: { authorization: `Bearer ${secret}` } });

describe('getBalanceSummary', () => {
  it('no holds: available equals balance', async () => {
    const u = await funded(1_000_000);
    expect(await getBalanceSummary(u.userId)).toEqual({ balanceMicroUsd: 1_000_000, heldMicroUsd: 0, availableMicroUsd: 1_000_000 });
  });
  it('an open hold lowers available, not balance', async () => {
    const u = await funded(1_000_000);
    await hold(u.userId, 300_000);
    await hold(u.userId, 200_000);
    const s = await getBalanceSummary(u.userId);
    expect(s).toEqual({ balanceMicroUsd: 1_000_000, heldMicroUsd: 500_000, availableMicroUsd: 500_000 });
    expect(await getAvailableMicroUsd(u.userId)).toBe(s.availableMicroUsd);
  });
  it('an expired hold does not count', async () => {
    const u = await funded(1_000_000);
    await hold(u.userId, 400_000, 'open', -1000);
    expect(await getBalanceSummary(u.userId)).toMatchObject({ heldMicroUsd: 0, availableMicroUsd: 1_000_000 });
  });
  it('settled and released holds do not count', async () => {
    const u = await funded(1_000_000);
    await hold(u.userId, 400_000, 'settled');
    await hold(u.userId, 100_000, 'released');
    expect(await getBalanceSummary(u.userId)).toMatchObject({ heldMicroUsd: 0, availableMicroUsd: 1_000_000 });
  });
  it("another user's hold does not count", async () => {
    const u = await funded(1_000_000);
    const other = await funded(1_000_000);
    await hold(other.userId, 900_000);
    expect(await getBalanceSummary(u.userId)).toMatchObject({ heldMicroUsd: 0 });
  });
  it('an unknown user reads as zero', async () => {
    expect(await getBalanceSummary('nobody')).toEqual({ balanceMicroUsd: 0, heldMicroUsd: 0, availableMicroUsd: 0 });
  });
});

describe('GET /api/v1/balance', () => {
  it('keeps balance_usd and currency and adds the new fields', async () => {
    const u = await funded(2_500_000);
    await hold(u.userId, 500_000);
    const res = await v1Balance(bearer(await key(u.userId, ['usage'])));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ balance_usd: 2.5, available_usd: 2, available_micro_usd: 2_000_000, held_micro_usd: 500_000, currency: 'USD' });
  });
  it('scope rules are unchanged: chat-only key gets 403, no key gets 401', async () => {
    const u = await funded(1_000_000);
    const res = await v1Balance(bearer(await key(u.userId, ['chat'])));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('insufficient_scope');
    expect((await v1Balance(req('/api/v1/balance'))).status).toBe(401);
  });
});

describe('dashboard routes', () => {
  it('/api/billing returns balance, held and available', async () => {
    const u = await funded(1_000_000);
    await hold(u.userId, 250_000);
    const body = (await (await billingGet(req('/api/billing', { cookie: u.cookie }), noCtx)).json()) as Record<string, number>;
    expect(body).toMatchObject({ balanceMicroUsd: 1_000_000, heldMicroUsd: 250_000, availableMicroUsd: 750_000 });
  });
  it('/api/account returns balance, held and available', async () => {
    const u = await funded(1_000_000);
    await hold(u.userId, 250_000);
    const body = (await (await accountGet(req('/api/account', { cookie: u.cookie }), noCtx)).json()) as Record<string, number>;
    expect(body).toMatchObject({ balanceMicroUsd: 1_000_000, heldMicroUsd: 250_000, availableMicroUsd: 750_000 });
  });
});
