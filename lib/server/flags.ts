import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db';
import { featureFlags } from '../../db/schema';
import { audit } from './audit';
import { features } from './config';

/**
 * Feature flags kept in the database (ADM-D1 slice 2). Only `inference` exists today.
 * A flag with no row is on. A flag is off only when a row says enabled = 0.
 * Fail safe: if the database cannot be read, `flagEnabled` answers false (off).
 * shortcut: the answer is cached for 5 seconds per worker instance, so another instance can serve a stale
 * "on" for up to 5 seconds after an emergency stop. Lower FLAG_CACHE_MS, or read per request, if that is too slow.
 */
export const FLAGS = ['inference'] as const;
export type FlagKey = (typeof FLAGS)[number];
export const FLAG_CACHE_MS = 5000;

export const isFlagKey = (k: unknown): k is FlagKey => typeof k === 'string' && (FLAGS as readonly string[]).includes(k);

let cache: { at: number; off: Set<string> } | null = null;
export function resetFlagCache() {
  cache = null;
}

const errorText = (e: unknown) => String((e as { cause?: { message?: string } })?.cause?.message ?? (e instanceof Error ? e.message.split('\n')[0] : e)).slice(0, 200);

/** Keys switched off in the database. Throws when the read fails; only successful reads are cached. */
async function offKeys(): Promise<Set<string>> {
  const now = Date.now();
  if (cache && now >= cache.at && now - cache.at < FLAG_CACHE_MS) return cache.off;
  const rows = await getDb().select({ key: featureFlags.key, enabled: featureFlags.enabled }).from(featureFlags);
  const off = new Set(rows.filter(r => r.enabled === 0).map(r => r.key));
  cache = { at: now, off };
  return off;
}

/** The database side only: true, false, or null when it cannot be read. */
export async function dbEnabled(key: FlagKey): Promise<boolean | null> {
  try {
    return !(await offKeys()).has(key);
  } catch (e) {
    console.error('flag read failed', key, errorText(e));
    return null;
  }
}

/** Fail safe: false when the flag is off or cannot be read. */
export async function flagEnabled(key: FlagKey): Promise<boolean> {
  return (await dbEnabled(key)) === true;
}

/** Effective inference: INFERENCE_ENABLED=true AND an OpenRouter key AND the database flag not off. */
export async function inferenceEnabled(): Promise<boolean> {
  if (!features.inference()) return false;
  return flagEnabled('inference');
}

/** For the admin screen. Booleans only; the key value is never returned. */
export async function flagStatus() {
  resetFlagCache();
  const db = await dbEnabled('inference');
  const envOn = env.INFERENCE_ENABLED === 'true';
  const keyPresent = !!env.OPENROUTER_API_KEY;
  return [{ key: 'inference' as const, envOn, keyPresent, dbEnabled: db, effective: envOn && keyPresent && db === true }];
}

export async function setFlag(key: FlagKey, enabled: boolean, userId: string) {
  const now = Date.now();
  await getDb()
    .insert(featureFlags)
    .values({ key, enabled: enabled ? 1 : 0, updatedAt: now, updatedBy: userId })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled: enabled ? 1 : 0, updatedAt: now, updatedBy: userId } });
  resetFlagCache();
}

/**
 * Switch OFF: any admin, at once. Write-ahead audit (503 audit_unavailable if the row cannot be written, and nothing changes),
 * then the change. If the change fails a `failed` row follows.
 */
export async function turnOff(request: Request, actor: { userId: string; role: string | null }, key: FlagKey, reason: string) {
  const target = { type: 'feature_flag', id: key };
  const before = await dbEnabled(key);
  await audit(request, actor.userId, 'admin.flag_changed', target, { flag: key, enabled: false }, { reason, actorRole: actor.role, before: { enabled: before }, after: { enabled: false }, sensitive: true });
  try {
    await setFlag(key, false, actor.userId);
  } catch (e) {
    await audit(request, actor.userId, 'admin.flag_change_failed', target, { flag: key, enabled: false }, { result: 'failed', reason: 'write failed', actorRole: actor.role });
    throw e;
  }
}
