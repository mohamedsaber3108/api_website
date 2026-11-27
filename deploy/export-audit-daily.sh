#!/usr/bin/env bash
# EXAMPLE ONLY (AUD-2). Not installed, not run by any script or test in this repo.
# Makes a fresh COPY of the live database, then writes yesterday's signed audit export from the copy.
# The signing key is NOT in this file: the service loads it from an environment file (see export-audit.service.example).
# Tamper-evident only. Copying the export folder off this box is not done yet (owner decision D-22).
set -euo pipefail

DB="${AUDIT_DB_PATH:?set AUDIT_DB_PATH to the live database file}"
EXPORT_DIR="${AUDIT_EXPORT_DIR:-/var/backups/wasl/audit-exports}"
APP_DIR="${AUDIT_APP_DIR:-/opt/wasl}"
# The copy holds the whole database. Keep it private: new files are owner-only, it lives in its own
# mode-700 folder (never loose in a shared /tmp), and the folder is always removed, also on error or signal.
umask 077
WORK="$(mktemp -d "${AUDIT_TMP_BASE:-${TMPDIR:-/tmp}}/audit-copy.XXXXXX")"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
trap 'exit 1' HUP INT TERM
COPY="$WORK/copy.sqlite"

# sqlite3 .backup gives a consistent copy while the app keeps running.
sqlite3 "$DB" ".backup '$COPY'"
node "$APP_DIR/scripts/export-audit-daily.mjs" "$COPY" --dir "$EXPORT_DIR"
