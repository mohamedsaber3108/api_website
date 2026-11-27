// Hash chain for audit_logs (SEC-4). Plain JS so the server code and scripts/verify-audit.mjs share one implementation.
// Each hashed row stores seq (1, 2, 3 ...), prev_hash (hash of the row before; GENESIS for seq 1) and hash
// (SHA-256 over the row's own fields plus prev_hash). Editing, deleting or inserting a row in the middle breaks the chain.
// Rows written before migration 0006 have no seq and no hash. The chain starts at the first hashed row.

export const GENESIS = '0'.repeat(64);

/** @typedef {{ seq: number, id: string, actorId: string|null, actorRole: string|null, action: string, targetType: string|null, targetId: string|null, meta: string|null, before: string|null, after: string|null, reason: string|null, result: string|null, ip: string|null, createdAt: number, prevHash: string }} ChainFields */

/** The exact text that is hashed. Fixed field order; a change here changes every hash, so never reorder. */
export function canonical(/** @type {ChainFields} */ f) {
  return JSON.stringify([f.seq, f.id, f.actorId ?? null, f.actorRole ?? null, f.action, f.targetType ?? null, f.targetId ?? null, f.meta ?? null, f.before ?? null, f.after ?? null, f.reason ?? null, f.result ?? null, f.ip ?? null, f.createdAt, f.prevHash]);
}

export async function chainHash(/** @type {ChainFields} */ f) {
  const bytes = new TextEncoder().encode(canonical(f));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Checks rows read straight from audit_logs (snake_case or camelCase both accepted).
 * Returns the first broken link, or ok. Rows without seq are counted, not checked.
 * @param {Record<string, any>[]} rows
 */
export async function verifyChain(rows) {
  const norm = rows.map(r => ({
    seq: r.seq ?? null, id: r.id, actorId: r.actorId ?? r.actor_id ?? null, actorRole: r.actorRole ?? r.actor_role ?? null, action: r.action,
    targetType: r.targetType ?? r.target_type ?? null, targetId: r.targetId ?? r.target_id ?? null, meta: r.meta ?? null, before: r.before ?? null,
    after: r.after ?? null, reason: r.reason ?? null, result: r.result ?? null, ip: r.ip ?? null, createdAt: r.createdAt ?? r.created_at, prevHash: r.prevHash ?? r.prev_hash ?? null, hash: r.hash ?? null,
  }));
  const hashed = norm.filter(r => r.seq !== null).sort((a, b) => a.seq - b.seq);
  const unhashed = norm.filter(r => r.seq === null);
  const start = hashed.length ? hashed[0].createdAt : Infinity;
  const base = { checked: 0, unhashedBeforeChain: unhashed.filter(r => r.createdAt < start).length, unhashedAfterChainStart: unhashed.filter(r => r.createdAt >= start).length, unhashedAfterList: unhashed.filter(r => r.createdAt >= start).map(r => ({ id: r.id, action: r.action })) };
  let prev = GENESIS;
  let expected = 1;
  for (const r of hashed) {
    const broken = (reason) => ({ ok: false, ...base, firstBroken: { seq: r.seq, id: r.id, reason } });
    if (r.seq !== expected) return broken(r.seq < expected ? 'duplicate_seq' : 'missing_rows_before_this_seq');
    if (r.prevHash !== prev) return broken('prev_hash_does_not_match_previous_row');
    if (r.hash !== (await chainHash({ ...r, prevHash: r.prevHash }))) return broken('row_content_does_not_match_its_hash');
    prev = r.hash;
    expected++;
    base.checked++;
  }
  return { ok: true, ...base, firstBroken: null, tail: { seq: expected - 1, hash: prev } };
}

// Keys whose values must never reach the log, and value shapes that look like credentials.
const SECRET_KEY = /pass(word|phrase)?|secret|token|otp|recovery|authorization|cookie|api[_-]?key|private|credential|^code$|mfa_?code|^hash$/i;
const SECRET_VALUE = /\bsk-[A-Za-z0-9_-]{12,}|\bwasl_session=[^\s;]+|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\bwhsec_[A-Za-z0-9]{8,}|\b[A-Fa-f0-9]{64}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}|\b[A-Z2-7]{26,}={0,6}(?![A-Za-z0-9])/;

/** Returns a copy with secret-looking keys and values replaced by [redacted]. Depth and size are bounded. */
export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return SECRET_VALUE.test(value) ? '[redacted]' : value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (typeof value !== 'object') return value;
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}
