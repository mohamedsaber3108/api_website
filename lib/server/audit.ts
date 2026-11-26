import { desc, isNotNull } from 'drizzle-orm';
import { getDb } from '../../db';
import { auditLogs } from '../../db/schema';
import { chainHash, GENESIS, redact } from '../audit-chain.mjs';
import { clientIp, HttpError } from './http';

export type AuditResult = 'success' | 'denied' | 'failed';
export type AuditExtra = {
  before?: unknown;
  after?: unknown;
  reason?: string;
  /** Defaults to `success`. */
  result?: AuditResult;
  actorRole?: string | null;
  /**
   * Sensitive actions (role change, credit adjustment, approval, suspension, model markup) must not happen without an audit row:
   * if the row cannot be written this throws 503 `audit_unavailable`. Other rows keep the old behaviour (log the failure, go on).
   */
  sensitive?: boolean;
};

const MAX_ATTEMPTS = 60;

/** Drizzle puts the bound values (the row) into its error text. Log the database's own message only, cut short. */
const errorText = (e: unknown) => String((e as { cause?: { message?: string } })?.cause?.message ?? (e instanceof Error ? e.message.split('\n')[0] : e)).slice(0, 200);

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(redact(v)));
const isUniqueConflict = (e: unknown) => /UNIQUE constraint failed/i.test(errorText(e));

/**
 * Appends one row to the hash chain. Two writers can read the same last row, but `audit_seq_uq` (unique index on seq) lets only
 * one insert seq N+1; the loser re-reads the new last row and tries again. So the chain cannot fork. Needs no lock and no transaction.
 */
async function appendChained(row: { id: string; actorId: string | null; actorRole: string | null; action: string; targetType: string | null; targetId: string | null; meta: string | null; before: string | null; after: string | null; reason: string | null; result: string; ip: string | null; createdAt: number }) {
  const db = getDb();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const [tail] = await db.select({ seq: auditLogs.seq, hash: auditLogs.hash }).from(auditLogs).where(isNotNull(auditLogs.seq)).orderBy(desc(auditLogs.seq)).limit(1);
    const seq = (tail?.seq ?? 0) + 1;
    const prevHash = tail?.hash ?? GENESIS;
    const hash = await chainHash({ ...row, seq, prevHash });
    try {
      await db.insert(auditLogs).values({ ...row, seq, prevHash, hash });
      return;
    } catch (e) {
      if (!isUniqueConflict(e)) throw e;
    }
  }
  throw new Error('audit chain busy: too many parallel writers');
}

export async function audit(request: Request | null, actorId: string | null, action: string, target?: { type?: string; id?: string }, meta?: Record<string, unknown>, extra: AuditExtra = {}) {
  try {
    await appendChained({
      id: crypto.randomUUID(),
      actorId,
      actorRole: extra.actorRole ?? null,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      meta: json(meta),
      before: json(extra.before),
      after: json(extra.after),
      reason: extra.reason ? String(redact(extra.reason)).slice(0, 500) : null,
      result: extra.result ?? 'success',
      ip: request ? clientIp(request) : null,
      createdAt: Date.now(),
    });
  } catch (e) {
    // Never log the row itself: only the action and the error text.
    console.error('audit write failed', action, errorText(e));
    if (extra.sensitive) throw new HttpError(503, 'The audit log is unavailable, so this action was not done. Try again later.', 'audit_unavailable', { message_ar: 'سجل التدقيق غير متاح، لذلك لم يُنفَّذ الإجراء. حاول لاحقًا.' });
  }
}

/** Writes a `denied` row for a refused attempt. Never throws. */
export function auditDenied(request: Request | null, actorId: string | null, action: string, target?: { type?: string; id?: string }, reason?: string, extra: Omit<AuditExtra, 'result' | 'sensitive' | 'reason'> = {}) {
  return audit(request, actorId, action, target, undefined, { ...extra, reason, result: 'denied' });
}
