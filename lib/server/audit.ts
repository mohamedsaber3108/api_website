import { getDb } from '../../db';
import { auditLogs } from '../../db/schema';
import { clientIp } from './http';
import { errText } from './redact';

export async function audit(request: Request | null, actorId: string | null, action: string, target?: { type?: string; id?: string }, meta?: Record<string, unknown>) {
  try {
    await getDb().insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorId,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      meta: meta ? JSON.stringify(meta) : null,
      ip: request ? clientIp(request) : null,
      createdAt: Date.now(),
    });
  } catch (e) {
    // Auditing must never break the primary action, but failures must be visible.
    console.error('audit write failed', action, errText(e));
  }
}
