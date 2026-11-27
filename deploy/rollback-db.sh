#!/usr/bin/env bash
# Database-aware code rollback (OPS-3).
#   bash deploy/rollback-db.sh [--target <release-dir>] [--apply]
# Default is a DRY RUN: it reads, checks and logs what it would do, and changes nothing.
# Why: deploy/release.sh --rollback flips the code symlink but never looks at the database.
# If the release you leave behind added migrations that were already applied, the older code then runs
# on a newer schema. That is only safe when every such migration is ADDITIVE.
#
# What it does:
#   1. Finds the current release (APP_ROOT/current) and the target (default: the newest older release,
#      the same pick as release.sh --rollback).
#   2. Reads the applied migrations from the d1_migrations table of the local D1 files in DATA_DIR.
#   3. Lists the applied migrations the target release does not have (drizzle/NNNN_*.sql).
#   4. Refuses (exit 1) and prints which ones if any of those is not additive, or if its SQL file
#      cannot be found (then additive cannot be proved).
#   5. Otherwise, with --apply: takes a fresh backup of every local database, flips the symlink,
#      restarts the service, waits for the health check. The additive schema stays in place.
#      If the target is unhealthy it flips back to the old release and exits 1.
# It never deletes data, never runs a migration, never touches the database except to read it and to
# make a .backup copy. Backups are kept.
#
# "Additive" here means every statement is one of: CREATE TABLE, CREATE [UNIQUE] INDEX,
# ALTER TABLE ... ADD [COLUMN], INSERT [OR IGNORE] INTO. Anything else (DROP, RENAME, DELETE, UPDATE,
# CREATE TRIGGER/VIEW, PRAGMA, ...) is treated as NOT additive. The check is deliberately strict.
# shortcut: it reads the SQL text, it does not run it. A CREATE UNIQUE INDEX on an old table or an INSERT
# of rows the old code mishandles passes this check; read those migrations yourself before --apply.
#
# Settings (environment, all optional):
#   APP_ROOT=/opt/wasl  DATA_DIR=/var/lib/wasl  BACKUP_DIR=/var/backups/wasl  SERVICE=wasl
#   HEALTH_URL=http://127.0.0.1:8787/api/v1/health  LOG_FILE=<file to append the log to>
#   APPLIED_LIST_FILE=<file with one applied migration name per line; replaces reading the databases (tests)>
# Exit: 0 ok (dry run or applied), 1 refused or failed, 2 usage.
set -euo pipefail
umask 077

APP_ROOT="${APP_ROOT:-/opt/wasl}"
DATA_DIR="${DATA_DIR:-/var/lib/wasl}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/wasl}"
SERVICE="${SERVICE:-wasl}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8787/api/v1/health}"
LOG_FILE="${LOG_FILE:-}"
APPLIED_LIST_FILE="${APPLIED_LIST_FILE:-}"
APPLY=0
TARGET=""

usage() { echo "usage: rollback-db.sh [--target <release-dir>] [--apply]   (default: dry run)" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --target) [[ $# -ge 2 ]] || { usage; exit 2; }; TARGET="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if [[ "$APPLY" -eq 1 ]]; then MODE="APPLY"; else MODE="DRY-RUN"; fi

log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) [$MODE] $*"
  printf '%s\n' "$line"
  if [[ -n "$LOG_FILE" ]]; then printf '%s\n' "$line" >> "$LOG_FILE" || true; fi
}
die() { log "ERROR: $*" >&2; exit 1; }

norm() { local n="${1##*/}"; printf '%s' "${n%.sql}"; }

health() {
  local i
  for i in $(seq 1 "${HEALTH_TRIES:-60}"); do
    if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# ---- 1. releases -------------------------------------------------------------------------------
APP_ROOT="$(readlink -f "$APP_ROOT")"
CURRENT="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
[[ -n "$CURRENT" && -d "$CURRENT" ]] || die "no current release at $APP_ROOT/current"

if [[ -z "$TARGET" ]]; then
  while IFS= read -r d; do
    d="${d%/}"
    [[ "$(readlink -f "$d")" == "$CURRENT" ]] && continue
    TARGET="$d"
    break
  done < <(ls -1dt "$APP_ROOT"/releases/*/ 2>/dev/null || true)
fi
[[ -n "$TARGET" ]] || die "no previous release to roll back to"
TARGET="$(readlink -f "$TARGET")"
[[ -d "$TARGET" ]] || die "target is not a folder: $TARGET"
[[ "$TARGET" == "$APP_ROOT/releases/"* ]] || die "target must be inside $APP_ROOT/releases"
[[ "$TARGET" != "$CURRENT" ]] || die "target is already the current release"
[[ -d "$TARGET/drizzle" ]] || die "target has no drizzle folder, cannot compare migrations"
log "current release: $CURRENT"
log "target release:  $TARGET"

# ---- 2. applied migrations ---------------------------------------------------------------------
DBS=()
if [[ -d "$DATA_DIR" ]]; then
  while IFS= read -r -d '' db; do DBS+=("$db"); done < <(find "$DATA_DIR" -name '*.sqlite' -type f -print0)
fi

applied=()
if [[ -n "$APPLIED_LIST_FILE" ]]; then
  [[ -f "$APPLIED_LIST_FILE" ]] || die "APPLIED_LIST_FILE not found"
  while IFS= read -r line; do [[ -n "$line" ]] && applied+=("$(norm "$line")"); done < "$APPLIED_LIST_FILE"
else
  command -v sqlite3 >/dev/null || die "sqlite3 is not installed"
  found_table=0
  for db in "${DBS[@]}"; do
    has="$(sqlite3 -readonly "$db" "SELECT count(*) FROM sqlite_master WHERE name='d1_migrations'")"
    [[ "$has" == "1" ]] || continue
    found_table=1
    while IFS= read -r line; do [[ -n "$line" ]] && applied+=("$(norm "$line")"); done \
      < <(sqlite3 -readonly "$db" "SELECT name FROM d1_migrations ORDER BY id")
  done
  [[ "$found_table" -eq 1 ]] || die "no d1_migrations table found under $DATA_DIR; cannot tell which migrations ran"
fi
log "applied migrations read: ${#applied[@]}"

# ---- 3. migrations the target does not know ----------------------------------------------------
declare -A known=()
for f in "$TARGET"/drizzle/[0-9][0-9][0-9][0-9]_*.sql; do
  [[ -e "$f" ]] || continue
  known["$(norm "$f")"]=1
done
[[ "${#known[@]}" -gt 0 ]] || die "target has no migration files"

declare -A seen=()
unknown=()
for n in "${applied[@]}"; do
  [[ -n "${seen[$n]:-}" ]] && continue
  seen["$n"]=1
  [[ -n "${known[$n]:-}" ]] || unknown+=("$n")
done

find_sql() {
  local n="$1" c
  for c in "$CURRENT/drizzle/$n.sql" "$APP_ROOT"/releases/*/drizzle/"$n".sql; do
    if [[ -f "$c" ]]; then printf '%s' "$c"; return 0; fi
  done
  return 1
}

# ---- 4. additive check -------------------------------------------------------------------------
ADDITIVE_RE='^(create (unique )?index |create table |alter table [^ ]+ add |insert (or ignore )?into )'
blocked=()

check_file() {
  local name="$1" f="$2" text stmt s
  # Drop "--" comments (this includes drizzle's "--> statement-breakpoint") and /* */ comments.
  text="$(sed -e 's/--.*$//' "$f" | tr '\n\t' '  ' | sed -e 's:/\*[^*]*\*/: :g')"
  while IFS= read -r -d ';' stmt || [[ -n "$stmt" ]]; do
    s="$(printf '%s' "$stmt" | tr -d '`"[]' | tr 'A-Z' 'a-z' | tr -s ' ' | sed -e 's/^ //' -e 's/ $//')"
    [[ -n "$s" ]] || continue
    if ! [[ "$s" =~ $ADDITIVE_RE ]]; then
      blocked+=("$name: ${s:0:100}")
    fi
  done < <(printf '%s' "$text")
}

if [[ "${#unknown[@]}" -eq 0 ]]; then
  log "the target knows every applied migration: nothing to check"
else
  log "applied migrations the target does not know: ${unknown[*]}"
  for n in "${unknown[@]}"; do
    if sql="$(find_sql "$n")"; then
      check_file "$n" "$sql"
    else
      blocked+=("$n: SQL file not found in any release, cannot prove it is additive")
    fi
  done
fi

if [[ "${#blocked[@]}" -gt 0 ]]; then
  log "REFUSED: the code rollback is not safe, these migrations are not additive:" >&2
  for b in "${blocked[@]}"; do log "  - $b" >&2; done
  log "Nothing was changed. Options: stay on the current release, or ship a fixed release forward." >&2
  exit 1
fi
log "all unknown migrations are additive: the schema can stay as it is"

# ---- 5. act (or say what would happen) ---------------------------------------------------------
TS="$(date -u +%Y%m%d-%H%M%S)"
if [[ "$APPLY" -ne 1 ]]; then
  for db in "${DBS[@]}"; do
    log "would back up $db -> $BACKUP_DIR/pre-rollback-$TS-$(basename "$db" .sqlite).sqlite"
  done
  log "would point $APP_ROOT/current at $TARGET"
  log "would restart service $SERVICE and wait for $HEALTH_URL"
  log "would leave the additive schema and all data in place (no migration is undone)"
  log "dry run finished. Re-run with --apply to act."
  exit 0
fi

[[ $EUID -eq 0 ]] || die "--apply needs root (sudo)"
[[ "${#DBS[@]}" -gt 0 ]] || die "no database files under $DATA_DIR to back up; refusing to roll back without a backup"
command -v sqlite3 >/dev/null || die "sqlite3 is not installed"
mkdir -p "$BACKUP_DIR"
for db in "${DBS[@]}"; do
  dest="$BACKUP_DIR/pre-rollback-$TS-$(basename "$db" .sqlite).sqlite"
  [[ ! -e "$dest" ]] || die "backup file already exists: $dest"
  sqlite3 "$db" ".backup '$dest'"
  check="$(sqlite3 -readonly "$dest" 'PRAGMA integrity_check')"
  [[ "$check" == "ok" ]] || die "backup failed its integrity check: $dest"
  log "backup written and checked: $dest"
done

log "pointing current at $TARGET"
ln -sfn "$TARGET" "$APP_ROOT/current"
systemctl restart "$SERVICE"
if health; then
  log "rolled back code to $(basename "$TARGET"); additive schema left in place"
  exit 0
fi
log "target release is unhealthy; putting the old release back" >&2
ln -sfn "$CURRENT" "$APP_ROOT/current"
systemctl restart "$SERVICE"
if health; then die "rollback failed its health check; old release restored. See: journalctl -u $SERVICE"; fi
die "both releases unhealthy. See: journalctl -u $SERVICE. Backups are in $BACKUP_DIR"
