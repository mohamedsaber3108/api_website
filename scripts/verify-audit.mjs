#!/usr/bin/env node
// Usage: node scripts/verify-audit.mjs <path-to-sqlite-file>
// Reads audit_logs from the given SQLite file (read-only) and reports the first broken link of the hash chain.
// Exit code 0 = chain intact, 1 = broken, 2 = usage or read error.
// Run it on a COPY of the database file, never on the live file: SQLite may need to write journal files next to it.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { verifyChain } from '../lib/audit-chain.mjs';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('usage: node scripts/verify-audit.mjs <path-to-sqlite-file>');
  process.exit(2);
}
let rows;
try {
  const db = new DatabaseSync(file, { readOnly: true });
  rows = db.prepare('SELECT * FROM audit_logs').all();
  db.close();
} catch (e) {
  console.error(`cannot read audit_logs: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}
const r = await verifyChain(rows);
if (r.ok) {
  console.log(`OK: ${r.checked} chained rows intact${r.tail ? ` (last seq ${r.tail.seq}, hash ${r.tail.hash})` : ''}.`);
  console.log(`Rows before the chain started (no hash, not checked): ${r.unhashedBeforeChain}. Unhashed rows after it started (e.g. written by deploy/reset-mfa.sh): ${r.unhashedAfterChainStart}.`);
  process.exit(0);
}
console.error(`BROKEN at seq ${r.firstBroken.seq} (row ${r.firstBroken.id}): ${r.firstBroken.reason}. ${r.checked} rows before it were intact.`);
process.exit(1);
