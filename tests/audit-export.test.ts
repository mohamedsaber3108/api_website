import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { chainHash, GENESIS } from '../lib/audit-chain.mjs';
import { buildExport, dayBounds, expiredNames, readKey, verifyExport } from '../lib/audit-export.mjs';

const KEY = 'test-only-key-0123456789-abcdefghijklmnop';
const KEY_ENV = 'AUD2_TEST_KEY';
const DAY1 = '2026-01-10';
const DAY2 = '2026-01-11';
const t = (day: string, n: number) => Date.parse(`${day}T10:00:00.000Z`) + n;
const exportScript = path.resolve(__dirname, '../scripts/export-audit-daily.mjs');
const verifyScript = path.resolve(__dirname, '../scripts/verify-audit-export.mjs');

async function makeRows() {
  const rows: Record<string, unknown>[] = [];
  let prev = GENESIS;
  const times = [t(DAY1, 1), t(DAY1, 2), t(DAY2, 1), t(DAY2, 2)];
  for (let i = 0; i < times.length; i++) {
    const f = { seq: i + 1, id: `r${i + 1}`, actorId: 'u1', actorRole: 'admin', action: 'x.y', targetType: null, targetId: null, meta: null, before: null, after: null, reason: null, result: 'success', ip: null, createdAt: times[i], prevHash: prev };
    const hash = await chainHash(f);
    rows.push({ id: f.id, actor_id: 'u1', actor_role: 'admin', action: 'x.y', target_type: null, target_id: null, meta: null, ip: null, created_at: f.createdAt, seq: f.seq, prev_hash: prev, hash, before: null, after: null, reason: null, result: 'success' });
    prev = hash;
  }
  return rows;
}
function makeDb(dir: string, rows: Record<string, unknown>[]) {
  const file = path.join(dir, 'copy.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE audit_logs (id text primary key, actor_id text, action text not null, target_type text, target_id text, meta text, ip text, created_at integer not null, seq integer, prev_hash text, hash text, actor_role text, `before` text, `after` text, reason text, result text)');
  const ins = db.prepare('INSERT INTO audit_logs (id, actor_id, actor_role, action, created_at, seq, prev_hash, hash, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r.id as string, 'u1', 'admin', 'x.y', r.created_at as number, r.seq as number, r.prev_hash as string, r.hash as string, 'success');
  db.close();
  return file;
}
const asEnv = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
const run = (script: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync('node', ['--no-warnings', script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv });

describe('AUD-2: signed audit export (library)', () => {
  it('exports one day, verifies, and gives the same bytes twice', async () => {
    const rows = await makeRows();
    const a = buildExport(rows, DAY1, KEY);
    expect(buildExport(rows, DAY1, KEY)).toBe(a);
    const r = await verifyExport(a, KEY);
    expect(r).toMatchObject({ ok: true, rows: 2, day: DAY1 });
    expect(a).not.toContain(KEY);
  });

  it('detects an edited row, a removed row, a wrong key and a cut-short file', async () => {
    const rows = await makeRows();
    const a = buildExport(rows, DAY1, KEY);
    const edited = a.replace('"action":"x.y"', '"action":"x.z"');
    expect((await verifyExport(edited, KEY)).ok).toBe(false);
    const lines = a.split('\n');
    lines.splice(1, 1); // drop the first row
    expect((await verifyExport(lines.join('\n'), KEY)).ok).toBe(false);
    expect((await verifyExport(a, `${KEY}x`)).reason).toBe('signature_does_not_match');
    expect((await verifyExport(a.slice(0, -5), KEY)).ok).toBe(false);
  });

  it('a re-signed file with an edited row (key holder) still fails on the row hash', async () => {
    const rows = await makeRows();
    const a = buildExport(rows, DAY1, KEY);
    const forged = buildExport(rows.map(r => (r.id === 'r1' ? { ...r, action: 'x.z' } : r)), DAY1, KEY);
    expect(forged).not.toBe(a);
    const r = await verifyExport(forged, KEY);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/row_content_does_not_match_hash_at_seq_1/);
  });

  it('checks that day 2 continues day 1', async () => {
    const rows = await makeRows();
    const d1 = buildExport(rows, DAY1, KEY);
    const d2 = buildExport(rows, DAY2, KEY);
    expect((await verifyExport(d2, KEY, d1)).ok).toBe(true);
    const other = buildExport(rows.filter(r => r.seq !== 2), DAY1, KEY);
    expect((await verifyExport(d2, KEY, other)).ok).toBe(false);
  });

  it('readKey reads by name, rejects short or missing keys and never puts the value in the message', () => {
    expect(readKey('K', asEnv({ K: KEY }))).toBe(KEY);
    expect(() => readKey('K', asEnv({}))).toThrow(/K is not set/);
    expect(() => readKey('K', asEnv({ K: 'short-secret-value' }))).toThrow(/at least 32/);
    try { readKey('K', asEnv({ K: 'short-secret-value' })); } catch (e) { expect(String(e)).not.toContain('short-secret-value'); }
    expect(() => readKey('bad name', asEnv({ 'bad name': KEY }))).toThrow();
  });

  it('dayBounds rejects fake dates; expiredNames picks only exact old export names', () => {
    expect(() => dayBounds('2026-02-30')).toThrow();
    expect(() => dayBounds('x')).toThrow();
    const names = ['audit-2025-01-01.jsonl', 'audit-2026-01-01.jsonl', 'audit-2025-01-01.jsonl.tmp', 'notes.txt', '../audit-2020-01-01.jsonl', 'audit-2020-13-01.jsonl'];
    expect(expiredNames(names, '2026-06-01', 365)).toEqual(['audit-2025-01-01.jsonl']);
  });
});

describe('AUD-2: scripts', () => {
  it('writes a day file, skips on re-run, verifies, and removes only old export files in the folder', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aud2-'));
    const db = makeDb(dir, await makeRows());
    const out = path.join(dir, 'exports');
    mkdirSync(out);
    const old = path.join(out, 'audit-2020-01-01.jsonl');
    writeFileSync(old, 'old');
    writeFileSync(path.join(out, 'keepme.txt'), 'x');
    writeFileSync(path.join(out, 'audit-2020-01-02.jsonl.bak'), 'x');
    const outside = path.join(dir, 'audit-2020-01-03.jsonl');
    writeFileSync(outside, 'x');
    symlinkSync(outside, path.join(out, 'audit-2020-01-04.jsonl'));
    const env = { [KEY_ENV]: KEY };

    const r1 = run(exportScript, [db, '--dir', out, '--day', DAY1, '--key-env', KEY_ENV], env);
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain('written');
    expect(r1.stdout + r1.stderr).not.toContain(KEY);
    expect(existsSync(old)).toBe(false);
    expect(readdirSync(out).sort()).toEqual(['audit-2020-01-02.jsonl.bak', 'audit-2020-01-04.jsonl', `audit-${DAY1}.jsonl`, 'keepme.txt']);
    expect(existsSync(outside)).toBe(true);

    const f = path.join(out, `audit-${DAY1}.jsonl`);
    const before = readFileSync(f, 'utf8');
    const r2 = run(exportScript, [db, '--dir', out, '--day', DAY1, '--key-env', KEY_ENV], env);
    expect(r2.stdout).toContain('skipped');
    expect(readFileSync(f, 'utf8')).toBe(before);

    expect(run(verifyScript, [f, '--key-env', KEY_ENV], env).status).toBe(0);
    writeFileSync(f, before.replace('"x.y"', '"x.z"'));
    const bad = run(verifyScript, [f, '--key-env', KEY_ENV], env);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('TAMPERED');
  });

  it('refuses today, a missing key, and a broken chain', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aud2-'));
    const rows = await makeRows();
    const out = path.join(dir, 'exports');
    const env = { [KEY_ENV]: KEY };
    const today = new Date().toISOString().slice(0, 10);
    expect(run(exportScript, [makeDb(dir, rows), '--dir', out, '--day', today, '--key-env', KEY_ENV], env).status).toBe(2);
    expect(run(exportScript, [path.join(dir, 'copy.sqlite'), '--dir', out, '--day', DAY1, '--key-env', KEY_ENV]).status).toBe(2);
    const dir2 = mkdtempSync(path.join(tmpdir(), 'aud2-'));
    const broken = makeDb(dir2, rows.map(r => (r.seq === 2 ? { ...r, hash: 'f'.repeat(64) } : r)));
    const r = run(exportScript, [broken, '--dir', path.join(dir2, 'exports'), '--day', DAY1, '--key-env', KEY_ENV], env);
    expect(r.status).toBe(1);
    expect(existsSync(path.join(dir2, 'exports', `audit-${DAY1}.jsonl`))).toBe(false);
  });
});
