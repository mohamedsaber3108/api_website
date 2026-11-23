#!/usr/bin/env bash
# One-time (idempotent) setup for an Ubuntu EC2 host. Run as a sudo-capable user:
#   sudo bash deploy/setup-server.sh
# Installs Node 22 + pnpm, Caddy (reverse proxy on :80/:443), a `wasl` system user,
# the systemd unit, and /etc/wasl/wasl.env (created once, never overwritten).
set -euo pipefail

NODE_MAJOR=22
PNPM_VERSION=11.25.0
APP_ROOT=/opt/wasl
DATA_DIR=/var/lib/wasl
ENV_FILE=/etc/wasl/wasl.env

[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> Packages"
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl xz-utils git caddy sqlite3

echo "==> Node.js ${NODE_MAJOR}"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != "${NODE_MAJOR}" ]]; then
  ver=$(curl -fsSL https://nodejs.org/dist/index.json | grep -o "\"version\":\"v${NODE_MAJOR}\.[0-9.]*\"" | head -1 | cut -d'"' -f4)
  [[ -n "$ver" ]] || { echo "Could not resolve Node ${NODE_MAJOR} version" >&2; exit 1; }
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/${ver}/node-${ver}-linux-x64.tar.xz" -o "$tmp/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/${ver}/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " node-${ver}-linux-x64.tar.xz\$" SHASUMS256.txt | sed "s/node-${ver}-linux-x64.tar.xz/node.tar.xz/" | sha256sum -c -)
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$tmp/node.tar.xz" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  ln -sf /opt/node/bin/npx /usr/local/bin/npx
  ln -sf /opt/node/bin/corepack /usr/local/bin/corepack
  rm -rf "$tmp"
fi
node -v

echo "==> pnpm ${PNPM_VERSION}"
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack enable --install-directory /usr/local/bin pnpm
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack install -g "pnpm@${PNPM_VERSION}"

echo "==> User and directories"
id wasl >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/wasl --shell /usr/sbin/nologin wasl
mkdir -p "$APP_ROOT/releases" "$APP_ROOT/pnpm-store" "$DATA_DIR" /etc/wasl /var/backups/wasl
chown -R wasl:wasl "$APP_ROOT" "$DATA_DIR"
chmod 750 "$DATA_DIR"
# pnpm needs corepack's cache for the wasl user too.
sudo -u wasl COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack install -g "pnpm@${PNPM_VERSION}" >/dev/null

echo "==> Environment file"
if [[ ! -f "$ENV_FILE" ]]; then
  ip=$(curl -fsS -m 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
       | xargs -I{} curl -fsS -m 3 -H 'X-aws-ec2-metadata-token: {}' http://169.254.169.254/latest/meta-data/public-ipv4 || true)
  cat > "$ENV_FILE" <<EOF
# Wasl AI runtime configuration. Edit, then: sudo systemctl restart wasl
APP_ENV=production
PUBLIC_BASE_URL=http://${ip:-YOUR_PUBLIC_IP}
# Comma separated; admins once verified. Or promote directly: sudo bash ${APP_ROOT}/current/deploy/make-admin.sh you@example.com
ADMIN_EMAILS=
TRUST_CHATGPT_HEADERS=false
CLIENT_IP_HEADER=x-real-ip
DEFAULT_MARKUP_PERCENT=20
SIGNUP_BONUS_USD=0
# Paid inference (needs a provider agreement that allows resale)
INFERENCE_ENABLED=false
OPENROUTER_API_KEY=
# Stripe Checkout; webhook URL: \${PUBLIC_BASE_URL}/api/billing/webhook
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
# Transactional email (Resend)
RESEND_API_KEY=
EMAIL_FROM=
EOF
fi
chown root:wasl "$ENV_FILE"
chmod 640 "$ENV_FILE"

# Settings added after the first install; append if missing (existing values are never changed).
grep -q '^CLIENT_IP_HEADER=' "$ENV_FILE" || echo 'CLIENT_IP_HEADER=x-real-ip' >> "$ENV_FILE"

echo "==> systemd unit"
cat > /etc/systemd/system/wasl.service <<EOF
[Unit]
Description=Wasl AI (workerd via wrangler, local D1)
After=network-online.target
Wants=network-online.target

[Service]
User=wasl
Group=wasl
WorkingDirectory=${APP_ROOT}/current
Environment=NODE_ENV=production
Environment=CI=true
Environment=WRANGLER_SEND_METRICS=false
Environment=SITES_PNPM_SHARED_STORE=${APP_ROOT}/pnpm-store
ExecStart=/usr/local/bin/node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js dev --config dist/server/wrangler.json --local --persist-to ${DATA_DIR} --ip 127.0.0.1 --port 8787 --inspector-port 0 --show-interactive-dev-session=false --log-level info
Restart=always
RestartSec=3
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${APP_ROOT} ${DATA_DIR} /home/wasl
ProtectKernelTunables=true
ProtectControlGroups=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable wasl >/dev/null

echo "==> Caddy"
cat > /etc/caddy/Caddyfile <<'EOF'
# Replace ":80" with your domain (e.g. "api.example.com") to get automatic HTTPS,
# then: sudo systemctl reload caddy  (ports 80 and 443 must be open).
:80 {
	encode zstd gzip
	request_body {
		max_size 2MB
	}
	reverse_proxy 127.0.0.1:8787 {
		# Identity/IP headers must only ever come from us, never from the client.
		header_up -Oai-Authenticated-User-Id
		header_up -Oai-Authenticated-User-Email
		header_up -Oai-Authenticated-User-Full-Name
		header_up -Oai-Authenticated-User-Full-Name-Encoding
		header_up -Cf-Connecting-Ip
		header_up X-Forwarded-For {remote_host}
		# Always overwritten, so clients cannot spoof it. The app reads it via CLIENT_IP_HEADER.
		header_up X-Real-IP {remote_host}
		flush_interval -1
	}
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		X-Frame-Options SAMEORIGIN
		-Server
	}
	log {
		output file /var/log/caddy/wasl-access.log {
			roll_size 20MiB
			roll_keep 5
		}
	}
}
EOF
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --now caddy >/dev/null
systemctl reload caddy

echo "==> Daily database backup (keeps 14)"
cat > /etc/cron.daily/wasl-backup <<EOF
#!/bin/sh
set -e
ts=\$(date +%Y%m%d-%H%M%S)
for db in \$(find ${DATA_DIR} -name '*.sqlite' -type f); do
  sqlite3 "\$db" ".backup '/var/backups/wasl/\$(basename "\$db" .sqlite)-\$ts.sqlite'"
done
find /var/backups/wasl -name '*.sqlite' -mtime +14 -delete
EOF
chmod 755 /etc/cron.daily/wasl-backup

echo "Setup complete. Next: deploy a release with deploy/release.sh"
