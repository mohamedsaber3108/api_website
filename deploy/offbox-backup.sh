#!/usr/bin/env bash
# Off-box copy of the latest database backup and the latest signed audit exports (OPS-5).
#   bash deploy/offbox-backup.sh [--dry-run]
# OFF BY DEFAULT: if OFFBOX_TARGET is not set it prints a message and exits 0. No destination has been
# chosen. That is an owner decision. Nothing here is installed or run by any other script in this repo.
#
# OFFBOX_TARGET (one of):
#   ssh:[user@]host:/absolute/folder     rsync over ssh. Optional OFFBOX_SSH_KEY=<key file path>.
#                                        The host key must already be in known_hosts (strict checking).
#   s3://bucket[/prefix]                 AWS CLI ("aws s3 cp"). Credentials come from the environment or the AWS config.
#   rclone:remote:path                   rclone. The remote is set up in rclone's own config.
# Credentials and keys are NEVER in this file or in the log. Put them in an env file (mode 600) that the
# service loads (see offbox-backup.service.example).
#
# What is copied (into <target>/db/ and <target>/audit/):
#   - the newest file for each database in BACKUP_DIR (names like app-20260101-020000.sqlite)
#   - the newest OFFBOX_AUDIT_DAYS (default 3) files audit-YYYY-MM-DD.jsonl from AUDIT_EXPORT_DIR
# Each copy is checked: the file is read back from the destination and its size and sha256 must match the local file.
# The local copy is kept. Nothing is deleted, here or on the destination (old remote files stay until
# someone sets a retention rule on the destination).
# shortcut: the check downloads each file again, so it costs one extra transfer. Fine for small files;
# use the storage's own checksum when the files get big.
# Exit: 0 ok or off, 1 a copy failed its check, 2 usage or bad settings.
set -euo pipefail
umask 077

BACKUP_DIR="${BACKUP_DIR:-/var/backups/wasl}"
AUDIT_EXPORT_DIR="${AUDIT_EXPORT_DIR:-$BACKUP_DIR/audit-exports}"
AUDIT_DAYS="${OFFBOX_AUDIT_DAYS:-3}"
TARGET="${OFFBOX_TARGET:-}"
DRY=0

case "${1:-}" in
  "") ;;
  --dry-run) DRY=1 ;;
  *) echo "usage: offbox-backup.sh [--dry-run]" >&2; exit 2 ;;
esac

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

if [[ -z "$TARGET" ]]; then
  log "OFFBOX_TARGET is not set: off-box backup is OFF. Nothing was copied. (No destination is chosen yet; owner decision.)"
  exit 0
fi
[[ "$AUDIT_DAYS" =~ ^[0-9]+$ && "$AUDIT_DAYS" -ge 1 ]] || { echo "OFFBOX_AUDIT_DAYS must be a whole number of at least 1" >&2; exit 2; }

# ---- parse the target (strict patterns: no spaces, no quotes, nothing the remote shell could read as code) ----
KIND=""; RHOST=""; RBASE=""
if [[ "$TARGET" =~ ^ssh:(([A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+):(/[A-Za-z0-9._/-]*)$ ]]; then
  KIND="ssh"; RHOST="${BASH_REMATCH[1]}"; RBASE="${BASH_REMATCH[3]%/}"
elif [[ "$TARGET" =~ ^s3://[A-Za-z0-9._-]+(/[A-Za-z0-9._/-]*)?$ ]]; then
  KIND="s3"; RBASE="${TARGET%/}"
elif [[ "$TARGET" =~ ^rclone:([A-Za-z0-9_.-]+:[A-Za-z0-9._/-]*)$ ]]; then
  KIND="rclone"; RBASE="${BASH_REMATCH[1]%/}"
else
  echo "OFFBOX_TARGET is not in a supported form (ssh:user@host:/folder, s3://bucket/prefix, rclone:remote:path)" >&2
  exit 2
fi
RSH="ssh -o BatchMode=yes -o StrictHostKeyChecking=yes"
if [[ -n "${OFFBOX_SSH_KEY:-}" ]]; then
  [[ "$OFFBOX_SSH_KEY" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "OFFBOX_SSH_KEY must be a plain absolute path" >&2; exit 2; }
  RSH="$RSH -i $OFFBOX_SSH_KEY"
fi
log "off-box backup ON, kind: $KIND (destination not printed)"

# ---- pick the files ----
declare -A latest=()
if [[ -d "$BACKUP_DIR" ]]; then
  while IFS= read -r f; do
    prefix="${f%-????????-??????.sqlite}"
    [[ "$prefix" != "$f" ]] || continue
    latest["$prefix"]="$f"
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.sqlite' -printf '%f\n' | sort)
fi

audit=()
if [[ -d "$AUDIT_EXPORT_DIR" ]]; then
  while IFS= read -r f; do audit+=("$f"); done \
    < <(find "$AUDIT_EXPORT_DIR" -maxdepth 1 -type f -name 'audit-????-??-??.jsonl' -printf '%f\n' | sort | tail -n "$AUDIT_DAYS")
fi

jobs=()   # "subfolder|local path|name"
for prefix in "${!latest[@]}"; do jobs+=("db|$BACKUP_DIR/${latest[$prefix]}|${latest[$prefix]}"); done
for f in "${audit[@]}"; do jobs+=("audit|$AUDIT_EXPORT_DIR/$f|$f"); done

if [[ "${#jobs[@]}" -eq 0 ]]; then log "no backup or audit files found to copy"; exit 0; fi

put() {  # subfolder, local file, name
  case "$KIND" in
    ssh)
      ssh -o BatchMode=yes -o StrictHostKeyChecking=yes ${OFFBOX_SSH_KEY:+-i "$OFFBOX_SSH_KEY"} "$RHOST" "mkdir -p -- '$RBASE/$1'"
      rsync -t --chmod=F600 -e "$RSH" -- "$2" "$RHOST:$RBASE/$1/$3" ;;
    s3) aws s3 cp --only-show-errors "$2" "$RBASE/$1/$3" ;;
    rclone) rclone copyto "$2" "$RBASE/$1/$3" ;;
  esac
}
get() {  # subfolder, name -> stdout
  case "$KIND" in
    ssh) ssh -o BatchMode=yes -o StrictHostKeyChecking=yes ${OFFBOX_SSH_KEY:+-i "$OFFBOX_SSH_KEY"} "$RHOST" "cat -- '$RBASE/$1/$2'" ;;
    s3) aws s3 cp --only-show-errors "$RBASE/$1/$2" - ;;
    rclone) rclone cat "$RBASE/$1/$2" ;;
  esac
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/offbox.XXXXXX")"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
trap 'exit 1' HUP INT TERM

errors=0
for j in "${jobs[@]}"; do
  IFS='|' read -r sub path name <<<"$j"
  if [[ "$DRY" -eq 1 ]]; then log "dry run: would copy $name -> $sub/ and verify it"; continue; fi
  want_size="$(stat -c %s "$path")"
  want_sha="$(sha256sum "$path" | cut -d' ' -f1)"
  if ! put "$sub" "$path" "$name"; then log "FAILED to copy $name"; errors=$((errors + 1)); continue; fi
  if ! get "$sub" "$name" > "$TMP/check"; then log "FAILED to read back $name"; errors=$((errors + 1)); continue; fi
  got_size="$(stat -c %s "$TMP/check")"
  got_sha="$(sha256sum "$TMP/check" | cut -d' ' -f1)"
  if [[ "$got_size" == "$want_size" && "$got_sha" == "$want_sha" ]]; then
    log "ok $sub/$name size=$want_size sha256=$want_sha (local copy kept)"
  else
    log "MISMATCH $sub/$name local size=$want_size sha256=$want_sha, remote size=$got_size sha256=$got_sha"
    errors=$((errors + 1))
  fi
  rm -f "$TMP/check"
done

[[ "$errors" -eq 0 ]] || { log "$errors file(s) failed"; exit 1; }
log "off-box backup finished"
