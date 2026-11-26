#!/usr/bin/env bash
# Clears one admin's MFA from the server terminal (lost phone and no recovery codes) and writes an audit row.
# The admin enrols again at next sign-in. Takes the same stop/start of the service as create-admin.sh.
#   sudo bash /opt/wasl/current/deploy/reset-mfa.sh admin@example.com
set -euo pipefail
email=$(echo "${1:?usage: reset-mfa.sh email}" | tr '[:upper:]' '[:lower:]')
re='^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
[[ "$email" =~ $re ]] || { echo "invalid email" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }

db=""
while IFS= read -r f; do
  if sqlite3 "$f" "SELECT 1 FROM accounts LIMIT 1" >/dev/null 2>&1; then db="$f"; break; fi
done < <(find /var/lib/wasl -name '*.sqlite' -type f -size +0)
[[ -n "$db" ]] || { echo "Database not found under /var/lib/wasl" >&2; exit 1; }

# The email matched the regex above, so it holds no quote and is safe inside the SQL string.
uid=$(sqlite3 "$db" "SELECT user_id FROM accounts WHERE email='$email' AND auth_provider='password' AND role='admin' AND status='active' LIMIT 1;")
[[ -n "$uid" ]] || { echo "No active admin with that email (role must be admin in the database)." >&2; exit 1; }
sqlite3 "$db" "SELECT 1 FROM mfa_credentials LIMIT 1" >/dev/null 2>&1 || { echo "MFA tables not found: has the MFA migration been applied?" >&2; exit 1; }

operator="${SUDO_USER:-root}"
audit_id="mfa-reset-$(date +%s)-$RANDOM"
now_ms=$(( $(date +%s) * 1000 ))

systemctl stop wasl
trap 'systemctl start wasl' EXIT
sqlite3 "$db" <<SQL
BEGIN;
DELETE FROM mfa_recovery_codes WHERE user_id='$uid';
DELETE FROM mfa_credentials WHERE user_id='$uid';
UPDATE sessions SET mfa_verified_at=NULL WHERE user_id='$uid';
INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, meta, ip, created_at)
  VALUES ('$audit_id', NULL, 'auth.mfa_reset', 'account', '$uid', '{"by":"server terminal","operator":"$operator"}', NULL, $now_ms);
COMMIT;
SQL
echo "MFA cleared for $email. They enrol again at next sign-in. Audit row $audit_id written."
