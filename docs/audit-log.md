# Audit log (SEC-4)

## What a row holds
`audit_logs`: id, time, actor id and role, action, target type and id, `meta`, `before`, `after`, `reason`, `result` (`success`, `denied`, `failed`), ip, and the chain fields `seq`, `prev_hash`, `hash`.
Secret-looking keys (password, token, secret, api key, recovery, code, cookie, authorization) and secret-shaped values (`sk-...`, `Bearer ...`, `wasl_session=...`, 64-hex strings) are replaced by `[redacted]` before the write (`lib/audit-chain.mjs`, `redact`).

## The chain
Each chained row has `seq` (1, 2, 3 ...), `prev_hash` (the hash of the row before; 64 zeros for seq 1) and `hash` (SHA-256 of the row's fields plus `prev_hash`; field order in `canonical()`). Changing, deleting or inserting a row in the middle breaks it.
**Parallel writers:** a writer reads the last row, then inserts `seq + 1`. The unique index `audit_seq_uq` lets only one writer win a given `seq`. The loser re-reads and retries (up to 60 times). The chain cannot fork. Proven by the 20-parallel test.
**Old rows:** rows written before migration 0006 have no `seq` or `hash`. The chain starts at the first hashed row. Old rows are counted, not checked.

## What it does not stop
Someone who can write the database file can rewrite the whole chain and recompute every hash, or delete the newest rows. The off-box copy is what catches that: keep the `tail` line (last seq and hash) somewhere the box cannot reach, and compare it later.
Rows added outside the app (for example by `deploy/reset-mfa.sh`, which has no hash) are reported as "unhashed rows after the chain started". They do not break the chain.

## Which actions fail without an audit row
Sensitive: role change, suspension, approval of a request, request creation, credit adjustment (through approval), model markup. The audit row is written **first**; if that fails the action returns 503 `audit_unavailable` and nothing changes (an approval claim is put back to pending). If the change then fails, a row with result `failed` follows.
A `success` row written first means intent: the change follows, and if it does not apply, a `failed` row follows it. A model markup that fails to save writes `admin.model_update_failed`. A repeated approval that re-applies a change (same approver, within 15 minutes) writes its own `admin.request_approved` row (meta `duplicate: true`) and the action row before it applies; if those rows cannot be written nothing is applied and the request stays approved.
If an approval writes its first audit row and the second write then fails, that one row stays and no compensating row can be written (the log is down). The claim is put back to pending, so the request can be approved again.
Everything else (login, tickets, incidents, keys) keeps the old behaviour: a failed audit write is logged (error text only) and the action goes on.

## Denied attempts
`auth.admin_denied` (signed-in user without the role, or an admin without MFA), `admin.request_denied` (self-approval, own account, wrong role, stale MFA), `admin.user_update_denied`, `admin.request_rejected` with reason `stale`, `auth.mfa_verify_failed` and `auth.mfa_locked` (result `denied`).

`auth.admin_denied` is written at most once per actor, route pattern and reason in 60 seconds (the id in `/api/admin/users/<id>` is stored as `:id`, so changing the id does not make a new row), so looping on an admin URL cannot flood the log. The skipped attempts are not counted.

## Who can read it, and for how long (owner decision D-22)
- **Reads: `super_admin` only.** `GET /api/admin/audit` answers 403 to `admin`, `support` and customers. The refusal is written as a denied row (`auth.admin_denied`, at most one per actor, route and reason in 60 seconds). The Audit tab is shown only to a `super_admin`; an `admin` who reaches it sees "The audit log is for super admins only." An `ADMIN_EMAILS` break-glass entry is `admin`, never `super_admin`, so it cannot read the log.
- **Retention: 12 months online, then export and archive.** Nothing deletes rows today; the archive step is the export script below, run by the person the owner names.
- **Tamper-evident only until the off-box copy runs.** The off-box destination is not chosen and the export stays OFF. Say "tamper-evident", not "protected", until it runs.

## Verify
Run on a COPY of the database file, never the live one:
`node scripts/verify-audit.mjs <copy.sqlite>` prints the first broken row (exit 1) or OK (exit 0).

### Daily verifier with an alert (AUD-1)
`node scripts/verify-audit-daily.mjs <copy.sqlite>` runs the verifier on the copy you give it. It has no default path, opens the file read-only and never writes to the database.
Exit codes: 0 intact, 1 chain broken, 2 check failed (no path, unreadable file), 3 the alert hook itself failed.
On 1 or 2 it calls the alert hook. The hook is OFF unless you set one of these (no destination is built in):
- `AUDIT_ALERT_COMMAND`: absolute path of an executable. Run with no shell and no arguments. It reads `AUDIT_ALERT_STATUS` (`broken` or `failed`) and `AUDIT_ALERT_MESSAGE` from its environment.
- `AUDIT_ALERT_WEBHOOK_URL`: an `https://` URL. It gets one POST with JSON `{status, message, file, at}`.
With no hook set, the failure is only printed and the exit code is non-zero.
Example systemd files (not installed, not run): `deploy/verify-audit.service.example` and `deploy/verify-audit.timer.example` (daily 03:30). Something else must put a fresh copy of the database at the path first; that copy job and the alert receiver are the owner's choice (D-22).

## Off-box export hook (OFF by default)
`node scripts/export-audit.mjs <copy.sqlite> --out <file.jsonl> [--after <seq>]` writes chained rows after `seq` and a last `{"tail":{seq,hash}}` line. Without `--out` it does nothing. No destination is built in and nothing is scheduled: where the file goes and how often (daily) is the owner's decision.

## Daily signed export (AUD-2)
Tamper-evident only. The off-box copy is not done yet, so someone who holds the key and the box can still rewrite both the log and the files.
`node scripts/export-audit-daily.mjs <copy.sqlite> --dir <folder> [--day YYYY-MM-DD] [--key-env NAME] [--keep-days 365]` writes `<folder>/audit-<day>.jsonl` for one UTC day (default: yesterday; today is refused). Run it on a COPY.
- File: a header line (day, row count, first and last seq, the hash before the first row, the tail hash), one line per chained row with its hash, and a last line `{"hmac": ...}` (HMAC-SHA256 over all earlier lines).
- Key: read from the environment variable named by `--key-env` (default `AUDIT_EXPORT_HMAC_KEY`, at least 32 characters). Only the name is ever used in messages. The value is never printed or stored in the repo.
- Idempotent: if the day's file exists it is skipped. The same rows give the same bytes (no "made at" time inside).
- It refuses to export (exit 1) when the chain on the copy is broken.
- Retention: after a run, files named exactly `audit-YYYY-MM-DD.jsonl` that are plain files inside the export folder and older than 365 days are deleted. Nothing outside the folder, no other names, no links.
- Verify: `node scripts/verify-audit-export.mjs <file> [--previous <file of the day before>] [--key-env NAME]`. Exit 0 intact, 1 tampered, 2 usage error. It checks the signature, each row's hash and link, and with `--previous` that the day continues the day before.
- Example files, never installed or run here: `deploy/export-audit-daily.sh`, `deploy/export-audit.service.example`, `deploy/export-audit.timer.example` (00:20 UTC). The key goes in `/etc/wasl/audit-export.env`, created by a person on the server.
- Limits: a missed day is not back-filled by the timer (run the script with `--day`); rows without a hash are only counted in the header (`unchainedRows`); a day with no rows cannot be linked to the day before.

## Rollback
The migration only adds nullable columns and indexes. Old code ignores the new columns, so rolling the code back needs no database change. Rows written by new code keep their extra columns and stay valid. Do not remove the columns while new code could still run.
</text>
