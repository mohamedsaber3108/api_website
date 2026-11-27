#!/usr/bin/env bash
# Tests for deploy/rollback-db.sh and deploy/offbox-backup.sh (OPS-3, OPS-5). Plain bash, no network, no root,
# no sqlite3, no systemd. Run: bash tests/deploy-scripts.test.sh   Exit 0 = all passed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
OUT=""; RC=0

run() { set +e; OUT="$("$@" 2>&1)"; RC=$?; set -e; }
check() {  # name, condition result (0 = true)
  if [[ "$2" -eq 0 ]]; then pass=$((pass + 1)); echo "ok   $1"; else fail=$((fail + 1)); echo "FAIL $1"; echo "$OUT" | sed 's/^/     | /'; fi
}
has() { [[ "$OUT" == *"$1"* ]]; }

# ---- 1. every shell script parses ----
for f in "$ROOT"/deploy/*.sh; do
  run bash -n "$f"; check "bash -n $(basename "$f")" "$RC"
done

# ---- rollback-db.sh with a fake release folder ----
APP="$T/app"; DATA="$T/data"; BK="$T/bk"
mkdir -p "$DATA"

fresh() {  # builds releases/old (0000, 0001) and releases/new (0000..0002); current -> new; $1 = SQL of migration 0002
  rm -rf "$APP"; mkdir -p "$APP/releases/old/drizzle" "$APP/releases/new/drizzle"
  for d in old new; do
    echo 'CREATE TABLE `a` (id integer);' > "$APP/releases/$d/drizzle/0000_init.sql"
    echo 'CREATE TABLE `b` (id integer);' > "$APP/releases/$d/drizzle/0001_more.sql"
  done
  printf '%s\n' "$1" > "$APP/releases/new/drizzle/0002_new.sql"
  touch -d '2 days ago' "$APP/releases/old"
  ln -s "$APP/releases/new" "$APP/current"
  printf '0000_init.sql\n0001_more.sql\n0002_new.sql\n' > "$T/applied.txt"
}
rb() { APP_ROOT="$APP" DATA_DIR="$DATA" BACKUP_DIR="$BK" APPLIED_LIST_FILE="$T/applied.txt" bash "$ROOT/deploy/rollback-db.sh" "$@"; }

fresh 'CREATE TABLE `c` (id integer);
--> statement-breakpoint
CREATE UNIQUE INDEX `c_id` ON `c` (`id`);
--> statement-breakpoint
ALTER TABLE `a` ADD `note` text;'
run rb; check "additive migration: dry run exits 0" "$RC"
has "DRY-RUN"; check "dry run is labelled" "$?"
has "would point"; check "dry run says what it would do" "$?"
[[ "$(readlink -f "$APP/current")" == "$(readlink -f "$APP/releases/new")" ]]; check "dry run left the symlink alone" "$?"

fresh '-- DROP TABLE a;
/* DROP TABLE b; */
CREATE TABLE `c` (id integer);'
run rb; check "comments with DROP are ignored" "$RC"

fresh 'ALTER TABLE `a` DROP COLUMN `id`;'
run rb; [[ "$RC" -eq 1 ]]; check "DROP COLUMN is refused (exit 1)" "$?"
has "REFUSED"; check "refusal says REFUSED" "$?"
has "0002_new"; check "refusal names the migration" "$?"

fresh 'DROP TABLE `a`;'
run rb; [[ "$RC" -eq 1 ]]; check "DROP TABLE is refused" "$?"

fresh 'ALTER TABLE `a` RENAME TO `z`;'
run rb; [[ "$RC" -eq 1 ]]; check "RENAME is refused" "$?"

fresh 'CREATE TABLE `c` (id integer); UPDATE `a` SET id = 1;'
run rb; [[ "$RC" -eq 1 ]]; check "UPDATE hidden after an additive statement is refused" "$?"

fresh 'CREATE TABLE `c` (id integer);'
printf '0000_init.sql\n0001_more.sql\n0002_new.sql\n0009_ghost.sql\n' > "$T/applied.txt"
run rb; [[ "$RC" -eq 1 ]]; check "migration with no SQL file is refused" "$?"
has "0009_ghost"; check "missing-SQL refusal names it" "$?"

fresh 'DROP TABLE `a`;'
printf '0000_init.sql\n0001_more.sql\n' > "$T/applied.txt"
run rb; check "target knows every applied migration: exits 0 even if 0002 is unsafe" "$RC"

run rb --bogus; [[ "$RC" -eq 2 ]]; check "unknown option exits 2" "$?"

# ---- offbox-backup.sh ----
ob() { env -u OFFBOX_TARGET BACKUP_DIR="$BK" AUDIT_EXPORT_DIR="$BK/audit-exports" "$@" bash "$ROOT/deploy/offbox-backup.sh" ${DRYARG:-}; }
run env -u OFFBOX_TARGET bash "$ROOT/deploy/offbox-backup.sh"
check "off by default: exits 0" "$RC"
has "OFFBOX_TARGET is not set"; check "off message is clear" "$?"

run env OFFBOX_TARGET='ftp://nope' bash "$ROOT/deploy/offbox-backup.sh"
[[ "$RC" -eq 2 ]]; check "unsupported target exits 2" "$?"

run env OFFBOX_TARGET='ssh:u@h:/x; rm -rf /' bash "$ROOT/deploy/offbox-backup.sh"
[[ "$RC" -eq 2 ]]; check "target with shell characters is refused" "$?"

mkdir -p "$BK/audit-exports"
touch "$BK/app-20260101-000000.sqlite" "$BK/app-20260102-000000.sqlite" "$BK/pre-rollback-x.sqlite"
for d in 01 02 03 04; do touch "$BK/audit-exports/audit-2026-01-$d.jsonl"; done
run env OFFBOX_TARGET='ssh:u@h:/srv/x' BACKUP_DIR="$BK" AUDIT_EXPORT_DIR="$BK/audit-exports" bash "$ROOT/deploy/offbox-backup.sh" --dry-run
check "dry run exits 0" "$RC"
has "app-20260102-000000.sqlite"; check "dry run picks the newest db backup" "$?"
! has "app-20260101-000000.sqlite"; check "dry run skips the older db backup" "$?"
has "audit-2026-01-04.jsonl"; check "dry run picks the newest audit export" "$?"
! has "audit-2026-01-01.jsonl"; check "dry run skips audit exports older than 3 files" "$?"
! has "u@h"; check "destination is not printed" "$?"

echo "passed: $pass, failed: $fail"
[[ "$fail" -eq 0 ]]
