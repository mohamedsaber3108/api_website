import { and, eq, isNull, or, lt } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { getDb } from '../../db';
import { mfaCredentials, mfaRecoveryCodes, sessions } from '../../db/schema';
import { audit } from './audit';
import { isProduction } from './config';
import { fromHex, hmacSha256Hex, safeEqual, toHex } from './crypto';
import { db1, HttpError } from './http';

/** TOTP per RFC 6238 (HMAC-SHA1, 30 s, 6 digits) and admin MFA state. No third-party dependency. */

export const STEP_SECONDS = 30;
export const RECENT_MFA_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_SECONDS = 15 * 60;
const RECOVERY_CODE_COUNT = 10;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const encoder = new TextEncoder();

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(0, Math.floor(counter / 2 ** 32));
  new DataView(msg.buffer).setUint32(4, counter >>> 0);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[19] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/** Returns the matched step (previous, current or next) or null. Every candidate is compared in constant time. */
export async function matchTotp(secret: Uint8Array, code: string, now = Date.now()): Promise<number | null> {
  const cur = currentStep(now);
  let matched: number | null = null;
  for (const step of [cur - 1, cur, cur + 1]) {
    if (safeEqual(await hotp(secret, step), code)) matched = step;
  }
  return matched;
}

export function otpauthUrl(email: string, secretB32: string): string {
  return `otpauth://totp/Wasl:${encodeURIComponent(email)}?secret=${secretB32}&issuer=Wasl&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

// ---- secret encryption (AES-GCM, key derived from MFA_ENCRYPTION_KEY) ----

/** Fails closed: in production a missing key is a 503 so admin routes cannot open. Development uses a fixed local key. */
const MIN_KEY_LENGTH = 32;
function keyMaterial(): string {
  const k = (env.MFA_ENCRYPTION_KEY || '').trim();
  if (!isProduction()) return k || 'wasl-development-only-mfa-key';
  if (k.length >= MIN_KEY_LENGTH) return k;
  throw new HttpError(503, `Admin MFA is not configured on this server (MFA_ENCRYPTION_KEY is missing or shorter than ${MIN_KEY_LENGTH} characters).`, 'mfa_not_configured');
}

async function aesKey(): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', encoder.encode(keyMaterial()));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Format `v2.<iv>.<ciphertext>`. The user id is the AES-GCM additional data, so a secret copied to another user's row does not decrypt. */
export async function encryptSecret(plain: Uint8Array, userId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(userId) }, await aesKey(), plain as BufferSource);
  return `v2.${toHex(iv)}.${toHex(ct)}`;
}

export async function decryptSecret(stored: string, userId: string): Promise<Uint8Array> {
  const [v, iv, ct] = stored.split('.');
  if (v !== 'v2' || !iv || !ct) throw new HttpError(500, 'Stored MFA secret is unreadable', 'mfa_secret_unreadable');
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(iv) as BufferSource, additionalData: encoder.encode(userId) }, await aesKey(), fromHex(ct) as BufferSource));
  } catch {
    throw new HttpError(500, 'Stored MFA secret cannot be decrypted with the current MFA_ENCRYPTION_KEY', 'mfa_secret_unreadable');
  }
}

// ---- state ----

export async function getMfaState(userId: string): Promise<{ enrolled: boolean; pending: boolean }> {
  const [row] = await getDb().select({ enrolledAt: mfaCredentials.enrolledAt }).from(mfaCredentials).where(eq(mfaCredentials.userId, userId)).limit(1);
  return { enrolled: !!row?.enrolledAt, pending: !!row && !row.enrolledAt };
}

/** Admin gate used by requireRole: a verified session is required, and the encryption key must exist. */
export async function assertAdminMfa(p: { userId: string; mfaVerifiedAt: number | null }): Promise<void> {
  keyMaterial(); // throws mfa_not_configured in production
  if (p.mfaVerifiedAt) return;
  const { enrolled } = await getMfaState(p.userId);
  throw new HttpError(403, enrolled ? 'Enter your MFA code to continue.' : 'Set up MFA to use the admin area.', 'mfa_required', { enrolled });
}

/** For money-moving actions: the session must have passed MFA in the last 15 minutes. */
export function assertRecentMfa(p: { mfaVerifiedAt: number | null }, now = Date.now()): void {
  if (!p.mfaVerifiedAt || now - p.mfaVerifiedAt > RECENT_MFA_MS) throw new HttpError(403, 'Enter a fresh MFA code to do this.', 'mfa_recent_required');
}

// ---- failure lockout: 5 failures in a 15 minute window lock attempts for that account ----
// shortcut: fixed window from the first failure (lock ends at most 15 min after it); move to a sliding window if that is too lenient.

const failKey = (userId: string) => `mfa:fail:${userId}`;

/**
 * Reserves one try BEFORE the code is checked (one atomic upsert), so parallel guesses cannot pass the limit together.
 * Try 6 and later in the window get 429. A right code deletes the bucket (clearFailures).
 * The first blocked request of a window (count = MAX_FAILURES + 1) writes the single `auth.mfa_locked` audit row.
 */
async function assertNotLocked(request: Request, userId: string) {
  const now = Date.now();
  const row = await db1()
    .prepare(
      `INSERT INTO rate_limit_buckets (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start < ?3 THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END
       RETURNING count, window_start`,
    )
    .bind(failKey(userId), now, now - LOCK_SECONDS * 1000)
    .first<{ count: number; window_start: number }>();
  if (row && row.count > MAX_FAILURES) {
    const retry = Math.max(1, Math.ceil((row.window_start + LOCK_SECONDS * 1000 - now) / 1000));
    if (row.count === MAX_FAILURES + 1) await audit(request, userId, 'auth.mfa_locked', { type: 'account', id: userId });
    throw new HttpError(429, 'Too many wrong codes. MFA is locked for this account for a while.', 'mfa_locked', { retry_after: retry }, { 'Retry-After': String(retry) });
  }
}

async function clearFailures(userId: string) {
  await db1().prepare('DELETE FROM rate_limit_buckets WHERE key = ?1').bind(failKey(userId)).run();
}

async function recordFailure(request: Request, userId: string, kind: string): Promise<never> {
  await audit(request, userId, 'auth.mfa_verify_failed', { type: 'account', id: userId }, { kind });
  throw new HttpError(401, 'Incorrect code', 'invalid_mfa_code');
}

// ---- recovery codes ----

const normaliseRecovery = (s: string) => s.toUpperCase().replace(/[\s-]/g, '');

/** HMAC-SHA-256 keyed with MFA_ENCRYPTION_KEY: a copy of the table alone is not enough to test guesses offline. */
const recoveryHash = (code: string) => hmacSha256Hex(keyMaterial(), `wasl-mfa-recovery-v1:${normaliseRecovery(code)}`);

function newRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const chars = [...bytes].map(b => B32[b & 31]).join(''); // 256 is a multiple of 32: no modulo bias
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/** Replaces all codes of the user with 10 fresh ones. Returns the plain codes; only hashes are stored. */
async function issueRecoveryCodes(userId: string): Promise<string[]> {
  const db = getDb();
  const now = Date.now();
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const rows = await Promise.all(codes.map(async c => ({ id: crypto.randomUUID(), userId, hash: await recoveryHash(c), createdAt: now })));
  await db.batch([db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId)), db.insert(mfaRecoveryCodes).values(rows)]);
  return codes;
}

// ---- operations ----

/** Atomically accepts a TOTP step only if it is newer than the last accepted one. */
async function acceptTotp(userId: string, code: string, requireEnrolled: boolean): Promise<boolean> {
  const db = getDb();
  const [row] = await db.select().from(mfaCredentials).where(eq(mfaCredentials.userId, userId)).limit(1);
  if (!row || (requireEnrolled && !row.enrolledAt)) throw new HttpError(409, 'MFA is not set up for this account', 'mfa_not_enrolled');
  if (!/^\d{6}$/.test(code)) return false;
  const step = await matchTotp(await decryptSecret(row.secretEnc, userId), code);
  if (step === null) return false;
  const updated = await db
    .update(mfaCredentials)
    .set({ lastUsedStep: step })
    .where(and(eq(mfaCredentials.userId, userId), or(isNull(mfaCredentials.lastUsedStep), lt(mfaCredentials.lastUsedStep, step))))
    .returning({ userId: mfaCredentials.userId });
  return updated.length === 1; // 0 rows: that step (or a later one) was already used
}

async function acceptRecovery(userId: string, code: string): Promise<boolean> {
  const hash = await recoveryHash(code);
  const rows = await getDb()
    .update(mfaRecoveryCodes)
    .set({ usedAt: Date.now() })
    .where(and(eq(mfaRecoveryCodes.userId, userId), eq(mfaRecoveryCodes.hash, hash), isNull(mfaRecoveryCodes.usedAt)))
    .returning({ id: mfaRecoveryCodes.id });
  return rows.length === 1;
}

async function markSessionVerified(sessionId: string) {
  await getDb().update(sessions).set({ mfaVerifiedAt: Date.now() }).where(eq(sessions.id, sessionId));
}

export async function beginEnrolment(request: Request, userId: string, email: string) {
  keyMaterial();
  if ((await getMfaState(userId)).enrolled) throw new HttpError(409, 'MFA is already set up. Ask a server operator to reset it.', 'mfa_already_enrolled');
  const secret = crypto.getRandomValues(new Uint8Array(20));
  const secretEnc = await encryptSecret(secret, userId);
  const now = Date.now();
  await getDb().insert(mfaCredentials).values({ userId, secretEnc, createdAt: now }).onConflictDoUpdate({ target: mfaCredentials.userId, set: { secretEnc, createdAt: now, lastUsedStep: null } });
  await audit(request, userId, 'auth.mfa_enrol_started', { type: 'account', id: userId });
  const b32 = base32Encode(secret);
  return { secret: b32, otpauthUrl: otpauthUrl(email, b32) };
}

export async function confirmEnrolment(request: Request, p: { userId: string; sessionId: string }, code: string) {
  await assertNotLocked(request, p.userId);
  keyMaterial();
  if ((await getMfaState(p.userId)).enrolled) throw new HttpError(409, 'MFA is already set up.', 'mfa_already_enrolled');
  if (!(await acceptTotp(p.userId, code, false))) return recordFailure(request, p.userId, 'enrol');
  await getDb().update(mfaCredentials).set({ enrolledAt: Date.now() }).where(eq(mfaCredentials.userId, p.userId));
  const recoveryCodes = await issueRecoveryCodes(p.userId);
  await markSessionVerified(p.sessionId);
  await clearFailures(p.userId);
  await audit(request, p.userId, 'auth.mfa_enrolled', { type: 'account', id: p.userId });
  return { recoveryCodes };
}

/** Step-up: a TOTP code or a recovery code marks the session as MFA verified. */
export async function verifyStepUp(request: Request, p: { userId: string; sessionId: string }, code: string) {
  await assertNotLocked(request, p.userId);
  keyMaterial();
  const clean = code.replace(/\s/g, '');
  if (/^\d{6}$/.test(clean)) {
    if (!(await acceptTotp(p.userId, clean, true))) return recordFailure(request, p.userId, 'totp');
  } else {
    if (!(await getMfaState(p.userId)).enrolled) throw new HttpError(409, 'MFA is not set up for this account', 'mfa_not_enrolled');
    if (!(await acceptRecovery(p.userId, clean))) return recordFailure(request, p.userId, 'recovery');
    await audit(request, p.userId, 'auth.mfa_recovery_used', { type: 'account', id: p.userId });
  }
  await markSessionVerified(p.sessionId);
  await clearFailures(p.userId);
  return { verified: true };
}

/** Needs a valid TOTP code (not a recovery code), so a stolen recovery code cannot mint more. */
export async function regenerateRecovery(request: Request, p: { userId: string }, code: string) {
  await assertNotLocked(request, p.userId);
  keyMaterial();
  if (!(await acceptTotp(p.userId, code.replace(/\s/g, ''), true))) return recordFailure(request, p.userId, 'regenerate');
  const recoveryCodes = await issueRecoveryCodes(p.userId);
  await clearFailures(p.userId);
  await audit(request, p.userId, 'auth.mfa_recovery_regenerated', { type: 'account', id: p.userId });
  return { recoveryCodes };
}
