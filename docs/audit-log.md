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
Everything else (login, tickets, incidents, keys) keeps the old behaviour: a failed audit write is logged (error text only) and the action goes on.

## Denied attempts
`auth.admin_denied` (signed-in user without the role, or an admin without MFA), `admin.request_denied` (self-approval, own account, wrong role, stale MFA), `admin.user_update_denied`, `admin.request_rejected` with reason `stale`, `auth.mfa_verify_failed` and `auth.mfa_locked` (result `denied`).

## Verify
Run on a COPY of the database file, never the live one:
`node scripts/verify-audit.mjs <copy.sqlite>` prints the first broken row (exit 1) or OK (exit 0).

## Off-box export hook (OFF by default)
`node scripts/export-audit.mjs <copy.sqlite> --out <file.jsonl> [--after <seq>]` writes chained rows after `seq` and a last `{"tail":{seq,hash}}` line. Without `--out` it does nothing. No destination is built in and nothing is scheduled: where the file goes and how often (daily) is the owner's decision.

## Rollback
The migration only adds nullable columns and indexes. Old code ignores the new columns, so rolling the code back needs no database change. Rows written by new code keep their extra columns and stay valid. Do not remove the columns while new code could still run.
</text>
