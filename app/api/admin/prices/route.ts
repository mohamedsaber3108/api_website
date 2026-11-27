import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { pricePoints } from '../../../../db/schema';
import { audit } from '../../../../lib/server/audit';
import { requireRole } from '../../../../lib/server/auth';
import { fail, handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';
import { assertRecentMfa } from '../../../../lib/server/mfa';
import { ALLOWED_CURRENCIES, MAX_AMOUNT_MINOR, MAX_CREDITS, PACKAGE_ID_RE } from '../../../../lib/server/prices';

export const dynamic = 'force-dynamic';

/** All price points, active or not. super_admin only (the price is the owner's decision). */
export const GET = handle(async request => {
  await requireRole(request, 'super_admin');
  const rows = await getDb().select().from(pricePoints);
  return json({ allowedCurrencies: ALLOWED_CURRENCIES, prices: rows.map(r => ({ ...r, active: r.active === 1 })) });
});

/** A change of more than 50% in amount or credits needs `confirm: true` in the body. */
const BIG_CHANGE = 0.5;
const moved = (from: number, to: number) => from > 0 && Math.abs(to - from) / from > BIG_CHANGE;

/**
 * Adds or changes one price for one (package, currency). Nothing is converted: the amount is exactly what the admin types.
 * The change needs a super_admin whose MFA was verified in the last 15 minutes (same check as credit adjustment).
 * Sanity checks: amountMinor must be at least 1, and a change of more than 50% in amount or credits needs confirm: true.
 * Audit (sensitive: no row, no change): the change is written first, then its audit row. If the audit row cannot be written
 * the old row is put back and the error is thrown, so a success row never exists without the change and the change never
 * stays without a row. If the write itself fails, a `failed` row is written and the error is thrown.
 * shortcut: the put-back is not atomic with the audit write; fine while price changes are rare and by one admin.
 * Default taken, owner may change: no second-person approval for price changes (lib/server/approvals.ts is not used).
 */
export const PUT = handle(async request => {
  requireSameOrigin(request);
  const admin = await requireRole(request, 'super_admin');
  assertRecentMfa(admin);
  const body = await parseBody(request, z.object({
    packageId: z.string().regex(PACKAGE_ID_RE),
    currency: z.enum(ALLOWED_CURRENCIES),
    amountMinor: z.number().int().max(MAX_AMOUNT_MINOR),
    credits: z.number().int().min(1).max(MAX_CREDITS),
    active: z.boolean(),
    reason: z.string().trim().min(3).max(200),
    confirm: z.boolean().optional(),
  }));
  if (body.amountMinor < 1) return fail(400, 'The amount must be at least 1 minor unit.', 'amount_too_small', { message_ar: 'يجب ألا يقل المبلغ عن وحدة صغرى واحدة.' });
  const db = getDb();
  const target = { type: 'price_point', id: `${body.packageId}:${body.currency}` };
  const [old] = await db.select().from(pricePoints).where(and(eq(pricePoints.packageId, body.packageId), eq(pricePoints.currency, body.currency))).limit(1);
  if (old && !body.confirm && (moved(old.amountMinor, body.amountMinor) || moved(old.credits, body.credits))) {
    return fail(400, 'This change moves the amount or the credits by more than 50%. Send confirm: true to apply it.', 'change_needs_confirm', { message_ar: 'هذا التغيير يغيّر المبلغ أو الرصيد بأكثر من 50%. أرسل confirm: true لتطبيقه.' });
  }
  const now = Date.now();
  const next = { amountMinor: body.amountMinor, credits: body.credits, active: body.active ? 1 : 0, updatedAt: now, updatedBy: admin.userId };
  const { confirm: _confirm, ...meta } = body;
  try {
    await db.insert(pricePoints).values({ id: crypto.randomUUID(), packageId: body.packageId, currency: body.currency, createdAt: now, ...next }).onConflictDoUpdate({ target: [pricePoints.packageId, pricePoints.currency], set: next });
  } catch (e) {
    await audit(request, admin.userId, 'admin.price_point', target, meta, { result: 'failed', reason: body.reason, actorRole: admin.role });
    throw e;
  }
  try {
    await audit(request, admin.userId, 'admin.price_point', target, meta, {
      before: old ? { amountMinor: old.amountMinor, credits: old.credits, active: old.active === 1 } : null,
      after: { amountMinor: body.amountMinor, credits: body.credits, active: body.active },
      reason: body.reason,
      actorRole: admin.role,
      sensitive: true,
    });
  } catch (e) {
    const where = and(eq(pricePoints.packageId, body.packageId), eq(pricePoints.currency, body.currency));
    await (old
      ? db.update(pricePoints).set({ amountMinor: old.amountMinor, credits: old.credits, active: old.active, updatedAt: old.updatedAt, updatedBy: old.updatedBy }).where(where)
      : db.delete(pricePoints).where(where)
    ).catch(err => console.error('price point put-back failed', String(err).slice(0, 200)));
    throw e;
  }
  return json({ ok: true });
});
