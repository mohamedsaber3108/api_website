#!/usr/bin/env node
// Daily audit verifier wrapper (AUD-1, D-22).
// Usage: node scripts/verify-audit-daily.mjs <path-to-database-COPY.sqlite>
// Runs scripts/verify-audit.mjs on the copy and, if the chain is broken or the check fails, calls the alert hook.
// Exit code: 0 = chain intact, 1 = chain broken, 2 = check failed (no path, unreadable file), 3 = the alert hook itself failed.
//
// Alert hook (OFF when neither variable is set; there is no built-in destination):
//   AUDIT_ALERT_COMMAND      absolute path of an executable. Run without a shell and without arguments.
//                            It gets AUDIT_ALERT_STATUS (broken | failed) and AUDIT_ALERT_MESSAGE in its environment.
//   AUDIT_ALERT_WEBHOOK_URL  an https:// URL. It gets one POST with JSON {status, message, file, at}.
// Safety: there is no default path (a live database path is never opened unless someone passes it);
// this script and verify-audit.mjs only read the file (read-only open). Always pass a COPY.
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = process.argv[2];
const here = path.dirname(fileURLToPath(import.meta.url));
let status = 'failed';
let message = 'usage: node scripts/verify-audit-daily.mjs <path-to-database-copy.sqlite>';
let code = 2;

if (file) {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(here, 'verify-audit.mjs'), file], { encoding: 'utf8', timeout: 10 * 60_000 });
  if (r.status === 0) {
    console.log(r.stdout.trim());
    process.exit(0);
  }
  code = r.status === 1 ? 1 : 2;
  status = code === 1 ? 'broken' : 'failed';
  message = (r.stderr || r.stdout || r.error?.message || 'verifier did not run').trim().slice(0, 1000);
}
console.error(`audit verification ${status}: ${message}`);

let hookFailed = false;
const command = process.env.AUDIT_ALERT_COMMAND;
const url = process.env.AUDIT_ALERT_WEBHOOK_URL;
if (command) {
  try {
    execFileSync(command, [], { env: { ...process.env, AUDIT_ALERT_STATUS: status, AUDIT_ALERT_MESSAGE: message }, timeout: 30_000, stdio: 'ignore' });
  } catch (e) {
    hookFailed = true;
    console.error(`alert command failed: ${e instanceof Error ? e.message : e}`);
  }
}
if (url) {
  try {
    if (!url.startsWith('https://')) throw new Error('AUDIT_ALERT_WEBHOOK_URL must start with https://');
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status, message, file: file ?? null, at: new Date().toISOString() }), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`webhook answered ${res.status}`);
  } catch (e) {
    hookFailed = true;
    console.error(`alert webhook failed: ${e instanceof Error ? e.message : e}`);
  }
}
if (!command && !url) console.error('no alert hook set (AUDIT_ALERT_COMMAND / AUDIT_ALERT_WEBHOOK_URL): alert is OFF');
process.exit(hookFailed ? 3 : code);
