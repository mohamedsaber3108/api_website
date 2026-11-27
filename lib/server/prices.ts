import { asc, and, eq } from 'drizzle-orm';
import { getDb } from '../../db';
import { pricePoints } from '../../db/schema';
import { CREDIT_PACKAGES, MICRO } from './config';

/** Currencies an admin may add a price for. */
export const ALLOWED_CURRENCIES = ['EGP', 'SAR', 'USD'] as const;
export const PACKAGE_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
/** 1,000,000.00 in minor units. */
export const MAX_AMOUNT_MINOR = 100_000_000;
/** 10,000 USD of credit, in micro-USD. */
export const MAX_CREDITS = 10_000 * MICRO;

export type PricePoint = { packageId: string; currency: string; amountMinor: number; credits: number; active: boolean };
export type PackageView = { id: string; prices: { currency: string; amountMinor: number; credits: number }[] };

export const PRICE_UNAVAILABLE_MESSAGE = {
  en: 'This package is not available in the selected currency.',
  ar: 'هذه الباقة غير متاحة بالعملة المختارة.',
} as const;
export const CURRENCY_UNSUPPORTED_MESSAGE = {
  en: 'This currency cannot be charged with the current payment method.',
  ar: 'لا يمكن الدفع بهذه العملة بالطريقة الحالية.',
} as const;

/** Today's code values (USD only). Used when price_points has no rows at all. No other currency is ever invented here. */
export function defaultPricePoints(): PricePoint[] {
  return CREDIT_PACKAGES.map(n => ({ packageId: `credits-${n}`, currency: 'USD', amountMinor: n * 100, credits: n * MICRO, active: true }));
}

const sortPoints = (a: PricePoint, b: PricePoint) => a.credits - b.credits || a.packageId.localeCompare(b.packageId) || a.currency.localeCompare(b.currency);

/** Active price points from the table, or the defaults when the table is empty. */
export async function listActivePricePoints(): Promise<PricePoint[]> {
  const rows = await getDb().select().from(pricePoints).orderBy(asc(pricePoints.credits), asc(pricePoints.packageId), asc(pricePoints.currency));
  if (rows.length === 0) return defaultPricePoints();
  return rows.filter(r => r.active === 1).map(r => ({ packageId: r.packageId, currency: r.currency, amountMinor: r.amountMinor, credits: r.credits, active: true })).sort(sortPoints);
}

/** The active price for one (package, currency), or null. Currency is matched upper-case. */
export async function findPricePoint(packageId: string, currency: string): Promise<PricePoint | null> {
  const cur = currency.toUpperCase();
  const [row] = await getDb().select().from(pricePoints).where(and(eq(pricePoints.packageId, packageId), eq(pricePoints.currency, cur))).limit(1);
  if (row) return row.active === 1 ? { packageId: row.packageId, currency: row.currency, amountMinor: row.amountMinor, credits: row.credits, active: true } : null;
  const [any] = await getDb().select({ id: pricePoints.id }).from(pricePoints).limit(1);
  if (any) return null; // table in use: a missing row means not offered
  return defaultPricePoints().find(p => p.packageId === packageId && p.currency === cur) ?? null;
}

/** Active price points grouped by package, for GET /api/billing. */
export async function listPackages(): Promise<PackageView[]> {
  const out: PackageView[] = [];
  for (const p of await listActivePricePoints()) {
    let pkg = out.find(x => x.id === p.packageId);
    if (!pkg) out.push((pkg = { id: p.packageId, prices: [] }));
    pkg.prices.push({ currency: p.currency, amountMinor: p.amountMinor, credits: p.credits });
  }
  return out;
}
