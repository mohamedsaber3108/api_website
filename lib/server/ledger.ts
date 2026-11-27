import { env } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db';
import { creditHolds, creditLedger } from '../../db/schema';

export type LedgerType = 'topup' | 'usage' | 'refund' | 'adjustment' | 'bonus';

export type LedgerEntry = {
  userId: string;
  deltaMicroUsd: number;
  type: LedgerType;
  idempotencyKey: string;
  refType?: string;
  refId?: string;
  note?: string;
  createdBy?: string;
};

export async function getBalanceMicroUsd(userId: string): Promise<number> {
  const [row] = await getDb()
    .select({ total: sql<number>`COALESCE(SUM(${creditLedger.deltaMicroUsd}), 0)` })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId));
  return Number(row?.total ?? 0);
}

/** Builds an insert statement for use inside `db.batch`. Duplicate idempotency keys are ignored. */
export function ledgerInsert(entry: LedgerEntry) {
  return getDb()
    .insert(creditLedger)
    .values({
      id: crypto.randomUUID(),
      userId: entry.userId,
      deltaMicroUsd: Math.trunc(entry.deltaMicroUsd),
      type: entry.type,
      refType: entry.refType ?? null,
      refId: entry.refId ?? null,
      idempotencyKey: entry.idempotencyKey,
      note: entry.note ?? null,
      createdBy: entry.createdBy ?? null,
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
}

export async function addLedgerEntry(entry: LedgerEntry): Promise<boolean> {
  const rows = await ledgerInsert(entry).returning({ id: creditLedger.id });
  return rows.length === 1;
}

/** A hold outlives the 300 s upstream timeout, so a live call never loses its hold; a crashed call frees its credit after this. */
export const HOLD_TTL_MS = 10 * 60 * 1000;

function d1() {
  if (!env.DB) throw new Error('Cloudflare D1 binding `DB` is unavailable.');
  return env.DB;
}

const OPEN_HOLDS = `COALESCE((SELECT SUM(amount_micro_usd) FROM credit_holds WHERE user_id = ?1 AND status = 'open' AND expires_at > ?2), 0)`;
const BALANCE = `COALESCE((SELECT SUM(delta_micro_usd) FROM credit_ledger WHERE user_id = ?1), 0)`;

/** Balance minus holds that are open and not expired. This is what a new call may spend. */
export async function getAvailableMicroUsd(userId: string): Promise<number> {
  const row = await d1().prepare(`SELECT ${BALANCE} - ${OPEN_HOLDS} AS available`).bind(userId, Date.now()).first<{ available: number }>();
  return Number(row?.available ?? 0);
}

/** Balance, open unexpired holds, and balance minus holds, read in one statement so the three numbers agree. */
export async function getBalanceSummary(userId: string): Promise<{ balanceMicroUsd: number; heldMicroUsd: number; availableMicroUsd: number }> {
  const row = await d1()
    .prepare(`SELECT ${BALANCE} AS balance, ${OPEN_HOLDS} AS held`)
    .bind(userId, Date.now())
    .first<{ balance: number; held: number }>();
  const balanceMicroUsd = Number(row?.balance ?? 0);
  const heldMicroUsd = Number(row?.held ?? 0);
  return { balanceMicroUsd, heldMicroUsd, availableMicroUsd: balanceMicroUsd - heldMicroUsd };
}

/**
 * Reserves `amount` for one request: a single conditional INSERT, run inside a D1 batch (D1 has no
 * interactive transaction; each statement is atomic and D1 runs one write at a time per database).
 * The row is inserted only if balance minus open holds covers `amount`. Returns false when it did not.
 * Calling again with the same request id is a no-op that returns true when the hold already exists.
 * Raw D1 is used because drizzle cannot put an INSERT ... SELECT with a bound WHERE into db.batch.
 */
export async function reserveCredit(userId: string, requestId: string, amount: number): Promise<boolean> {
  const now = Date.now();
  const [, found] = await d1().batch([
    d1().prepare(
      `INSERT INTO credit_holds (id, user_id, request_id, amount_micro_usd, status, created_at, expires_at)
       SELECT ?3, ?1, ?4, ?5, 'open', ?2, ?6
       WHERE ${BALANCE} - ${OPEN_HOLDS} >= ?5
       ON CONFLICT DO NOTHING`,
    ).bind(userId, now, crypto.randomUUID(), requestId, amount, now + HOLD_TTL_MS),
    d1().prepare('SELECT id FROM credit_holds WHERE request_id = ?1').bind(requestId),
  ]);
  return (found.results?.length ?? 0) > 0;
}

/** Statement for db.batch: close the hold together with the ledger charge, so the amount is never counted twice. */
export function closeHold(requestId: string, status: 'settled' | 'released') {
  return getDb().update(creditHolds).set({ status }).where(and(eq(creditHolds.requestId, requestId), eq(creditHolds.status, 'open')));
}
