#!/usr/bin/env node
// Off-box export hook for the audit log (SEC-4). OFF by default: with no --out it does nothing and says so.
// Usage: node scripts/export-audit.mjs <path-to-sqlite-copy> --out <file.jsonl> [--after <seq>]
// Writes every chained row with seq > N (default 0) as one JSON line each, then one last line {"tail":{seq,hash}}.
// Where the file goes (another host, a bucket) is an owner decision: no destination is built in, so copying
// it off the box is a step the owner adds to a daily job. Keep the tail line: it pins the chain so deleted rows show up.
// Never run it against the live file; use a copy.
import { writeFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const out = opt('--out');
if (!out) {
  console.log('Audit export is OFF (no --out given). Nothing was read or written.');
  process.exit(0);
}
const file = args[0];
const after = Number(opt('--after') ?? 0);
if (!file || file.startsWith('--') || !existsSync(file) || !Number.isInteger(after) || after < 0) {
  console.error('usage: node scripts/export-audit.mjs <path-to-sqlite-copy> --out <file.jsonl> [--after <seq>]');
  process.exit(2);
}
const db = new DatabaseSync(file, { readOnly: true });
const rows = db.prepare('SELECT * FROM audit_logs WHERE seq IS NOT NULL AND seq > ? ORDER BY seq').all(after);
db.close();
const tail = rows.length ? { seq: rows[rows.length - 1].seq, hash: rows[rows.length - 1].hash } : null;
writeFileSync(out, `${rows.map(r => JSON.stringify(r)).join('\n')}${rows.length ? '\n' : ''}${JSON.stringify({ tail })}\n`, { flag: 'wx' });
console.log(`Exported ${rows.length} rows to ${out}.`);
