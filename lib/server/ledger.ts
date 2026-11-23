import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../db';
import { creditLedger } from '../../db/schema';

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
