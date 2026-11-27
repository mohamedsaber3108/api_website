import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../../db';
import { pricePoints } from '../../../../db/schema';
import { audit } from '../../../../lib/server/audit';
import { requireRole } from '../../../../lib/server/auth';
import { handle, json, parseBody, requireSameOrigin } from '../../../../lib/server/http';
import { ALLOWED_CURRENCIES, MAX_AMOUNT_MINOR, MAX_CREDITS, PACKAGE_ID_RE } from '../../../../lib/server/prices';

export const dynamic = 'force-dynamic';

/** All price points, active or not. super_admin only (the price is the owner's decision). */
export const GET = handle(async request => {
  await requireRole(request, 'super_admin');
  const rows = await getDb().select().from(pricePoints);
  return json({ allowedCurrencies: ALLOWED_CURRENCIES, prices: rows.map(r => ({ ...r, active: r.active === 1 })) });
});

/**
 * Adds or changes one price for one (package, currency). Nothing is converted: the amount is exactly what the admin types.
 * The audit row is written first (sensitive: no row, no change). Default taken, owner may change: no second-person approval
 * for price changes (the request/approval flow in lib/server/approvals.ts is not used).
 */
export const PUT = handle(async request => {
  requireSameOrigin(request);
  const admin = await requireRole(request, 'super_admin');
  const body = await parseBody(request, z.object({
    packageId: z.string().regex(PACKAGE_ID_RE),
    currency: z.enum(ALLOWED_CURRENCIES),
    amountMinor: z.number().int().min(1).max(MAX_AMOUNT_MINOR),
    credits: z.number().int().min(1).max(MAX_CREDITS),
    active: z.boolean(),
    reason: z.string().trim().min(3).max(200),
  }));
  const db = getDb();
  const [old] = await db.select().from(pricePoints).where(and(eq(pricePoints.packageId, body.packageId), eq(pricePoints.currency, body.currency))).limit(1);
  const now = Date.now();
  const next = { amountMinor: body.amountMinor, credits: body.credits, active: body.active ? 1 : 0, updatedAt: now, updatedBy: admin.userId };
  await audit(request, admin.userId, 'admin.price_point', { type: 'price_point', id: `${body.packageId}:${body.currency}` }, { ...body }, {
    before: old ? { amountMinor: old.amountMinor, credits: old.credits, active: old.active === 1 } : null,
    after: { amountMinor: body.amountMinor, credits: body.credits, active: body.active },
    reason: body.reason,
    actorRole: admin.role,
    sensitive: true,
  });
  await db.insert(pricePoints).values({ id: crypto.randomUUID(), packageId: body.packageId, currency: body.currency, createdAt: now, ...next }).onConflictDoUpdate({ target: [pricePoints.packageId, pricePoints.currency], set: next });
  return json({ ok: true });
});
