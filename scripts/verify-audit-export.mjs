#!/usr/bin/env node
// Verify one signed audit export file (AUD-2).
// Usage: node scripts/verify-audit-export.mjs <audit-YYYY-MM-DD.jsonl> [--previous <file of the day before>] [--key-env NAME]
// Checks: signature (HMAC key from the environment variable NAME, default AUDIT_EXPORT_HMAC_KEY, never printed),
// row count, every row's hash and link, and (with --previous) that this day continues the day before.
// Exit: 0 intact, 1 tampered or broken, 2 usage or read error. Read-only.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readKey, verifyExport } from '../lib/audit-export.mjs';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const file = args[0];
if (!file || file.startsWith('--')) {
  console.error('usage: node scripts/verify-audit-export.mjs <export-file.jsonl> [--previous <earlier-export-file.jsonl>] [--key-env NAME]');
  process.exit(2);
}
let key; let text; let prev;
try {
  key = readKey(opt('--key-env') ?? 'AUDIT_EXPORT_HMAC_KEY');
  text = readFileSync(file, 'utf8');
  const p = opt('--previous');
  if (p) prev = readFileSync(p, 'utf8');
} catch (e) {
  console.error(e instanceof Error ? e.message : 'cannot read');
  process.exit(2);
}
const r = await verifyExport(text, key, prev, path.basename(file));
if (r.ok) {
  console.log(`OK: ${r.day}, ${r.rows} rows intact${r.tail ? ` (last seq ${r.tail.seq}, hash ${r.tail.hash})` : ''}.`);
  process.exit(0);
}
console.error(`TAMPERED OR BROKEN: ${r.reason}`);
process.exit(1);
