#!/usr/bin/env bash
# Creates a verified admin (or support) account directly on the server, without the website.
# Prompts for the name and password (hidden). If the account already exists, it is promoted.
#   sudo bash /opt/wasl/current/deploy/create-admin.sh you@example.com [admin|support]
set -euo pipefail
email=$(echo "${1:?usage: create-admin.sh email [admin|support]}" | tr '[:upper:]' '[:lower:]')
role=${2:-admin}
re='^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
[[ "$email" =~ $re ]] || { echo "invalid email" >&2; exit 1; }
[[ "$role" == "admin" || "$role" == "support" ]] || { echo "role must be admin or support" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }

db=""
while IFS= read -r f; do
  if sqlite3 "$f" "SELECT 1 FROM accounts LIMIT 1" >/dev/null 2>&1; then db="$f"; break; fi
done < <(find /var/lib/wasl -name '*.sqlite' -type f -size +0)
[[ -n "$db" ]] || { echo "Database not found under /var/lib/wasl" >&2; exit 1; }

existing=$(sqlite3 "$db" "SELECT COUNT(*) FROM accounts WHERE email='$email' AND auth_provider='password' AND status='active';")
if [[ "$existing" != "0" ]]; then
  echo "An account for $email already exists; promoting it to $role."
  exec bash "$(dirname "$0")/make-admin.sh" "$email" "$role"
fi

read -r -p "Display name: " name
[[ ${#name} -ge 2 && ${#name} -le 80 ]] || { echo "name must be 2-80 characters" >&2; exit 1; }
read -r -s -p "Password (min 10 chars): " pw1; echo
read -r -s -p "Repeat password: " pw2; echo
[[ "$pw1" == "$pw2" ]] || { echo "passwords do not match" >&2; exit 1; }
[[ ${#pw1} -ge 10 && ${#pw1} -le 200 ]] || { echo "password must be 10-200 characters" >&2; exit 1; }

# Same format as lib/server/crypto.ts: pbkdf2$<iterations>$<salt hex>$<sha256 key hex>.
# Values travel through the environment, never the command line. Output is a ready SQL statement.
sql=$(WASL_EMAIL="$email" WASL_NAME="$name" WASL_PW="$pw1" WASL_ROLE="$role" /usr/local/bin/node -e '
  const c = require("node:crypto");
  const q = s => "\x27" + String(s).replace(/\x27/g, "\x27\x27") + "\x27";
  const salt = c.randomBytes(16);
  const key = c.pbkdf2Sync(process.env.WASL_PW, salt, 100000, 32, "sha256");
  const hash = `pbkdf2$100000$${salt.toString("hex")}$${key.toString("hex")}`;
  const id = "usr_" + c.randomUUID().replace(/-/g, "");
  const now = Date.now();
  process.stdout.write(`INSERT INTO accounts (user_id, email, created_at, name, auth_provider, password_hash, role, status, email_verified_at, terms_accepted_at, terms_version) VALUES (${q(id)}, ${q(process.env.WASL_EMAIL)}, ${now}, ${q(process.env.WASL_NAME)}, \x27password\x27, ${q(hash)}, ${q(process.env.WASL_ROLE)}, \x27active\x27, ${now}, ${now}, \x272026-10-01\x27);`);
')
unset pw1 pw2

systemctl stop wasl
trap 'systemctl start wasl' EXIT
sqlite3 "$db" "$sql"
echo "Created $role account $email. Sign in at ${PUBLIC_BASE_URL:-the website}/login"
