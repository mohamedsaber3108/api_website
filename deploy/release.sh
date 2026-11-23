#!/usr/bin/env bash
# Builds and activates a release from a source tarball, applies new DB migrations, restarts.
#   sudo bash release.sh /tmp/wasl-<sha>.tar.gz <sha>
# Keeps the 3 newest releases; roll back with: sudo bash release.sh --rollback
set -euo pipefail

APP_ROOT=/opt/wasl
DATA_DIR=/var/lib/wasl
ENV_FILE=/etc/wasl/wasl.env
KEEP=3
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }

as_wasl() { sudo -u wasl -H env CI=true WRANGLER_SEND_METRICS=false COREPACK_ENABLE_DOWNLOAD_PROMPT=0 SITES_PNPM_SHARED_STORE="$APP_ROOT/pnpm-store" "$@"; }

health() {
  for _ in $(seq 1 60); do
    if curl -fsS -m 3 http://127.0.0.1:8787/api/v1/health >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

if [[ "${1:-}" == "--rollback" ]]; then
  current=$(readlink -f "$APP_ROOT/current")
  previous=$(ls -1dt "$APP_ROOT"/releases/*/ | sed 's:/$::' | grep -vx "$current" | head -1)
  [[ -n "$previous" ]] || { echo "No previous release." >&2; exit 1; }
  ln -sfn "$previous" "$APP_ROOT/current"
  systemctl restart wasl
  health && echo "Rolled back to $(basename "$previous")" || { echo "Rollback unhealthy; see journalctl -u wasl" >&2; exit 1; }
  exit 0
fi

tarball=${1:?tarball path}
sha=${2:?commit sha}
dir="$APP_ROOT/releases/$(date +%Y%m%d%H%M%S)-${sha:0:7}"

echo "==> Unpack $sha -> $dir"
mkdir -p "$dir"
tar -xzf "$tarball" -C "$dir"
echo "$sha" > "$dir/REVISION"
chown -R wasl:wasl "$dir"

echo "==> Install dependencies"
(cd "$dir" && as_wasl pnpm install --frozen-lockfile --config.confirmModulesPurge=false)

echo "==> Build"
(cd "$dir" && as_wasl pnpm build)
test -f "$dir/dist/server/wrangler.json"

echo "==> Runtime config and migrations"
# wrangler reads .dev.vars next to the config file it is given.
install -o wasl -g wasl -m 600 "$ENV_FILE" "$dir/dist/server/.dev.vars"
mkdir -p "$dir/dist/server/migrations"
cp "$dir"/drizzle/[0-9][0-9][0-9][0-9]_*.sql "$dir/dist/server/migrations/"
chown -R wasl:wasl "$dir/dist/server"

echo "==> Backup before migrating"
/etc/cron.daily/wasl-backup || true

# The local D1 file cannot be migrated while the server holds it.
systemctl stop wasl || true
(cd "$dir" && as_wasl node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js \
  d1 migrations apply DB --local --config dist/server/wrangler.json --persist-to "$DATA_DIR")

echo "==> Activate"
previous=$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)
ln -sfn "$dir" "$APP_ROOT/current"
systemctl start wasl
if ! health; then
  echo "New release failed its health check; restoring previous release." >&2
  journalctl -u wasl -n 40 --no-pager >&2 || true
  if [[ -n "$previous" && -d "$previous" ]]; then ln -sfn "$previous" "$APP_ROOT/current"; systemctl restart wasl; fi
  exit 1
fi

echo "==> Prune old releases"
ls -1dt "$APP_ROOT"/releases/*/ | tail -n +$((KEEP + 1)) | xargs -r rm -rf
rm -f "$tarball"
echo "Release $sha is live."
