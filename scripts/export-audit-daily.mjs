#!/usr/bin/env node
// Daily signed audit export (AUD-2, D-22). Tamper-evident only. The off-box copy is NOT done yet.
// Usage: node scripts/export-audit-daily.mjs <path-to-database-COPY.sqlite> --dir <export-folder> [--day YYYY-MM-DD] [--key-env NAME] [--keep-days 365]
// Writes <export-folder>/audit-<day>.jsonl for one UTC day (default: yesterday), signed with HMAC-SHA256.
// The key is read from the environment variable NAME (default AUDIT_EXPORT_HMAC_KEY, at least 32 characters). Its value is never printed.
// Idempotent: if the day's file already exists it is left alone ("skipped"). The same rows always give the same bytes.
// Refuses to export (exit 1) if the hash chain on the copy is broken, and refuses today or a future day (the day is not over).
// After a successful run it deletes export files older than --keep-days (default 365) INSIDE the export folder only:
// only plain files named audit-YYYY-MM-DD.jsonl, never a link, never another name, never another folder.
// Exit: 0 written or skipped, 1 chain broken, 2 usage or read error. Run it on a COPY, never on the live database.
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifyChain } from '../lib/audit-chain.mjs';
import { buildExport, expiredNames, fileNameForDay, readKey } from '../lib/audit-export.mjs';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const usage = 'usage: node scripts/export-audit-daily.mjs <database-copy.sqlite> --dir <export-folder> [--day YYYY-MM-DD] [--key-env NAME] [--keep-days 365]';
const fail = (msg, code = 2) => { console.error(msg); process.exit(code); };

const file = args[0];
const dir = opt('--dir');
if (!file || file.startsWith('--') || !dir || !existsSync(file)) fail(usage);
const keepDays = Number(opt('--keep-days') ?? 365);
if (!Number.isInteger(keepDays) || keepDays < 1) fail('--keep-days must be a whole number of at least 1');
const today = new Date().toISOString().slice(0, 10);
const day = opt('--day') ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail('--day must look like YYYY-MM-DD');
if (day >= today) fail('the day is not over yet: export a day before today (UTC)');

let key;
try { key = readKey(opt('--key-env') ?? 'AUDIT_EXPORT_HMAC_KEY'); } catch (e) { fail(e instanceof Error ? e.message : 'key error'); }

const folder = path.resolve(dir);
const target = path.join(folder, fileNameForDay(day));
mkdirSync(folder, { recursive: true, mode: 0o700 });

if (existsSync(target)) {
  console.log(`skipped: ${fileNameForDay(day)} already exists`);
} else {
  let rows;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    rows = db.prepare('SELECT * FROM audit_logs').all();
    db.close();
  } catch (e) { fail(`cannot read audit_logs: ${e instanceof Error ? e.message : e}`); }
  const chain = await verifyChain(rows);
  if (!chain.ok) fail(`chain is BROKEN at seq ${chain.firstBroken.seq}: ${chain.firstBroken.reason}. Nothing was exported.`, 1);
  const text = buildExport(rows, day, key);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, text, { flag: 'w', mode: 0o600 });
  renameSync(tmp, target);
  console.log(`written: ${fileNameForDay(day)} (${text.split('\n').length - 3} rows)`);
}

// Retention: only inside `folder`, only exact export names, only plain files.
let removed = 0;
for (const name of expiredNames(readdirSync(folder), today, keepDays)) {
  const p = path.join(folder, name);
  if (path.dirname(p) !== folder) continue;
  const st = lstatSync(p);
  if (!st.isFile()) continue;
  unlinkSync(p);
  removed++;
}
console.log(`old files removed: ${removed}`);
