// Signed daily export of the audit log (AUD-2, D-22). Plain JS, shared by the export and verify scripts and the tests.
// File format (JSON lines, one file per UTC day, no timestamp of "when it was made", so the same rows give the same bytes):
//   line 1:    {"format":"audit-export-v1","day","rows","firstSeq","lastSeq","prevHash","tail":{seq,hash}|null,"unchainedRows"}
//   next lines: one chained audit row each, with seq, prevHash and hash
//   last line: {"hmac":"<hex>"}  HMAC-SHA256 over every earlier line (each followed by a newline)
// The key comes from an environment variable whose NAME is given. This module never prints or returns the key.
// Tamper-evident only: someone who holds the key can re-sign an edited file. An off-box copy is not done yet.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { chainHash, GENESIS } from './audit-chain.mjs';

export const FORMAT = 'audit-export-v1';
export const MIN_KEY_LENGTH = 32;
export const FILE_RE = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

export function fileNameForDay(day) { return `audit-${day}.jsonl`; }

/** Validates "YYYY-MM-DD" and returns [startMs, endMs) of that UTC day. */
export function dayBounds(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day must look like YYYY-MM-DD');
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== day) throw new Error('day is not a real date');
  return [start, start + DAY_MS];
}

/** Reads the key from process.env[name]. Throws a message that holds the NAME only, never a value. */
export function readKey(name, env = process.env) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name ?? '')) throw new Error('key variable name must be upper-case letters, digits and _');
  const v = env[name];
  if (!v) throw new Error(`environment variable ${name} is not set`);
  if (v.length < MIN_KEY_LENGTH) throw new Error(`environment variable ${name} must hold at least ${MIN_KEY_LENGTH} characters`);
  return v;
}

const sign = (key, text) => createHmac('sha256', key).update(text).digest('hex');

const norm = r => ({
  seq: r.seq, id: r.id, actorId: r.actorId ?? r.actor_id ?? null, actorRole: r.actorRole ?? r.actor_role ?? null, action: r.action,
  targetType: r.targetType ?? r.target_type ?? null, targetId: r.targetId ?? r.target_id ?? null, meta: r.meta ?? null, before: r.before ?? null,
  after: r.after ?? null, reason: r.reason ?? null, result: r.result ?? null, ip: r.ip ?? null, createdAt: r.createdAt ?? r.created_at,
  prevHash: r.prevHash ?? r.prev_hash, hash: r.hash,
});

/** Builds the signed text for one UTC day from rows read from audit_logs (snake_case or camelCase). */
export function buildExport(allRows, day, key) {
  const [from, to] = dayBounds(day);
  const inDay = allRows.filter(r => (r.createdAt ?? r.created_at) >= from && (r.createdAt ?? r.created_at) < to);
  const rows = inDay.filter(r => r.seq !== null && r.seq !== undefined).map(norm).sort((a, b) => a.seq - b.seq);
  const last = rows[rows.length - 1];
  const header = {
    format: FORMAT, day, rows: rows.length, firstSeq: rows[0]?.seq ?? null, lastSeq: last?.seq ?? null,
    prevHash: rows[0]?.prevHash ?? null, tail: last ? { seq: last.seq, hash: last.hash } : null, unchainedRows: inDay.length - rows.length,
  };
  const body = [header, ...rows].map(x => `${JSON.stringify(x)}\n`).join('');
  return `${body}${JSON.stringify({ hmac: sign(key, body) })}\n`;
}

/**
 * Checks one export text. Optional `previousText` is the file of the day before: its tail must be this file's prevHash.
 * Returns {ok:true, rows, day, tail} or {ok:false, reason}.
 */
export async function verifyExport(text, key, previousText) {
  const bad = reason => ({ ok: false, reason });
  if (!text.endsWith('\n')) return bad('file_is_cut_short');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 2) return bad('file_is_too_short');
  let sig;
  try { sig = JSON.parse(lines[lines.length - 1]).hmac; } catch { return bad('last_line_is_not_a_signature'); }
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return bad('last_line_is_not_a_signature');
  const body = `${lines.slice(0, -1).join('\n')}\n`;
  const want = Buffer.from(sign(key, body), 'hex');
  if (!timingSafeEqual(want, Buffer.from(sig, 'hex'))) return bad('signature_does_not_match');
  let header; let rows;
  try { [header, ...rows] = lines.slice(0, -1).map(l => JSON.parse(l)); } catch { return bad('a_line_is_not_json'); }
  if (header?.format !== FORMAT) return bad('unknown_format');
  try { dayBounds(header.day); } catch { return bad('header_day_is_invalid'); }
  if (header.rows !== rows.length) return bad('row_count_does_not_match_header');
  const [from, to] = dayBounds(header.day);
  let prev = header.prevHash;
  let seq = header.firstSeq;
  for (const r of rows) {
    if (r.seq !== seq) return bad(`seq_gap_at_${r.seq}`);
    if (r.prevHash !== prev) return bad(`prev_hash_does_not_match_at_seq_${r.seq}`);
    if (r.hash !== (await chainHash(r))) return bad(`row_content_does_not_match_hash_at_seq_${r.seq}`);
    if (!(r.createdAt >= from && r.createdAt < to)) return bad(`row_is_outside_the_day_at_seq_${r.seq}`);
    prev = r.hash; seq++;
  }
  const last = rows[rows.length - 1];
  if (rows.length && (header.lastSeq !== last.seq || header.tail?.seq !== last.seq || header.tail?.hash !== last.hash)) return bad('header_tail_does_not_match_last_row');
  if (!rows.length && (header.tail !== null || header.prevHash !== null)) return bad('header_tail_does_not_match_last_row');
  if (rows.length && header.firstSeq === 1 && header.prevHash !== GENESIS) return bad('first_row_must_start_from_genesis');
  if (previousText !== undefined) {
    const p = await verifyExport(previousText, key);
    if (!p.ok) return bad(`previous_file_is_not_valid: ${p.reason}`);
    if (p.day >= header.day) return bad('previous_file_is_not_an_earlier_day');
    if (p.tail && rows.length) {
      if (header.firstSeq !== p.tail.seq + 1 || header.prevHash !== p.tail.hash) return bad('does_not_continue_the_previous_file');
    }
  }
  return { ok: true, rows: rows.length, day: header.day, tail: header.tail };
}

/** Names in `names` that are export files older than keepDays before today (UTC). Only names matching FILE_RE are ever returned. */
export function expiredNames(names, todayDay, keepDays = 365) {
  const [today] = dayBounds(todayDay);
  return names.filter(n => {
    const m = FILE_RE.exec(n);
    if (!m) return false;
    try { return dayBounds(m[1])[0] < today - keepDays * DAY_MS; } catch { return false; }
  });
}
