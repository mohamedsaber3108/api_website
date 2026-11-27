import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../db';
import { creditLedger } from '../db/schema';
import { eq } from 'drizzle-orm';
import { addLedgerEntry, getBalanceMicroUsd } from '../lib/server/ledger';
import { makeUser, startDb } from './helpers/db';

let h: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => { h = await startDb(); });
afterAll(async () => { await h.dispose(); });

describe('ledger', () => {
  it('balance is the sum of entries, 0 for a new user', async () => {
    const u = await makeUser();
    expect(await getBalanceMicroUsd(u.userId)).toBe(0);
    await addLedgerEntry({ userId: u.userId, deltaMicroUsd: 5_000_000, type: 'topup', idempotencyKey: `t:${u.userId}:1` });
    await addLedgerEntry({ userId: u.userId, deltaMicroUsd: -1_250_000, type: 'usage', idempotencyKey: `t:${u.userId}:2` });
    expect(await getBalanceMicroUsd(u.userId)).toBe(3_750_000);
  });
  it('the same idempotency key is written once (second call returns false, balance unchanged)', async () => {
    const u = await makeUser();
    const e = { userId: u.userId, deltaMicroUsd: 1_000_000, type: 'topup' as const, idempotencyKey: `dup:${u.userId}` };
    expect(await addLedgerEntry(e)).toBe(true);
    expect(await addLedgerEntry(e)).toBe(false);
    expect(await addLedgerEntry({ ...e, deltaMicroUsd: 9_000_000 })).toBe(false);
    expect(await getBalanceMicroUsd(u.userId)).toBe(1_000_000);
    expect(await getDb().select().from(creditLedger).where(eq(creditLedger.userId, u.userId))).toHaveLength(1);
  });
  it('the key is global: another user cannot reuse it', async () => {
    const a = await makeUser();
    const b = await makeUser();
    expect(await addLedgerEntry({ userId: a.userId, deltaMicroUsd: 1, type: 'bonus', idempotencyKey: `g:${a.userId}` })).toBe(true);
    expect(await addLedgerEntry({ userId: b.userId, deltaMicroUsd: 1, type: 'bonus', idempotencyKey: `g:${a.userId}` })).toBe(false);
  });
  it('fractional micro amounts are truncated to integers', async () => {
    const u = await makeUser();
    await addLedgerEntry({ userId: u.userId, deltaMicroUsd: 10.9, type: 'adjustment', idempotencyKey: `f:${u.userId}` });
    expect(await getBalanceMicroUsd(u.userId)).toBe(10);
  });
  it('20 parallel writes with one key credit exactly once', async () => {
    const u = await makeUser();
    const results = await Promise.all(Array.from({ length: 20 }, () => addLedgerEntry({ userId: u.userId, deltaMicroUsd: 100, type: 'topup', idempotencyKey: `p:${u.userId}` })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await getBalanceMicroUsd(u.userId)).toBe(100);
  });
});
