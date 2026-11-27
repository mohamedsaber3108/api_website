#!/usr/bin/env bash
# Promotes an existing account to admin (or support) and marks its email as verified.
# The person must have signed up on the website first.
#   sudo bash /opt/wasl/current/deploy/make-admin.sh you@example.com [admin|super_admin|support]
set -euo pipefail
email=$(echo "${1:?email}" | tr '[:upper:]' '[:lower:]')
role=${2:-admin}
re='^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
[[ "$email" =~ $re ]] || { echo "invalid email" >&2; exit 1; }
[[ "$role" == "admin" || "$role" == "super_admin" || "$role" == "support" ]] || { echo "role must be admin, super_admin or support" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }

db=""
while IFS= read -r f; do
  if sqlite3 "$f" "SELECT 1 FROM accounts LIMIT 1" >/dev/null 2>&1; then db="$f"; break; fi
done < <(find /var/lib/wasl -name '*.sqlite' -type f -size +0)
[[ -n "$db" ]] || { echo "Database not found under /var/lib/wasl" >&2; exit 1; }

# Write with the server stopped so workerd does not hold the database file.
systemctl stop wasl
trap 'systemctl start wasl' EXIT
changed=$(sqlite3 "$db" "UPDATE accounts SET role='$role', email_verified_at=COALESCE(email_verified_at, CAST(strftime('%s','now') AS INTEGER)*1000) WHERE email='$email' AND auth_provider='password' AND status='active'; SELECT changes();")
if [[ "$changed" == "1" ]]; then
  echo "$email is now $role. Sign out and back in to pick up the new role."
else
  echo "No active password account found for $email. Sign up on the website first." >&2
  exit 1
fi
