# Wasl AI

Arabic/English platform for exploring AI models and selling metered access to them through one OpenAI-compatible API.

- **Catalog:** 300+ models with live prices, five display currencies, comparison, CSV export, and favourites.
- **Accounts:** sign-up with email verification, password reset, session management, and account deletion.
- **API keys:** scopes, expiry, rotation, and a per-key rate limit. Only the key's hash is stored.
- **Paid gateway:** `POST /api/v1/chat/completions`, OpenAI-compatible with streaming, billed against a prepaid credit ledger.
- **Billing:** Stripe Checkout top-ups, signed and idempotent webhooks, refunds, and invoices.
- **Support:** tickets with replies for customers and a staff inbox.
- **Admin console:** users, credit adjustments, per-model availability and markup, incidents, and the audit log.
- **Legal and docs:** legal pages, a status page with live checks, and an OpenAPI spec at `/api/v1/openapi.json`.

Stack: React 19, Vinext (Next.js on Vite), Cloudflare Workers runtime (workerd), D1/SQLite with Drizzle, and zod.

## Run locally

```bash
pnpm install
pnpm build
# apply migrations once (see BACKEND.md), then:
pnpm start -- --port 8799 --var APP_ENV:development --var ADMIN_EMAILS:you@example.com
node scripts/smoke-test.mjs http://127.0.0.1:8799 you@example.com
```

## Deploy to an Ubuntu server (EC2)

```powershell
# first time: installs Node 22, pnpm, Caddy, the systemd service and /etc/wasl/wasl.env
.\deploy\deploy.ps1 -Server <public-ip> -Key C:\path\to\key.pem -Setup
# later releases
.\deploy\deploy.ps1 -Server <public-ip> -Key C:\path\to\key.pem
```

On the server:

| Task | Command |
|---|---|
| Configure features and secrets | `sudo nano /etc/wasl/wasl.env`, then redeploy (or copy the file to `/opt/wasl/current/dist/server/.dev.vars` and run `sudo systemctl restart wasl`) |
| Promote yourself to admin (after signing up) | `sudo bash /opt/wasl/current/deploy/make-admin.sh you@example.com` |
| Logs | `journalctl -u wasl -f` |
| Roll back | `sudo bash /opt/wasl/current/deploy/release.sh --rollback` |
| Backups | daily to `/var/backups/wasl` (14 days) |
| HTTPS | point a domain at the server, replace `:80` with the domain in `/etc/caddy/Caddyfile`, run `sudo systemctl reload caddy`, and set `PUBLIC_BASE_URL` |

The EC2 security group must allow inbound TCP 80 (and 443 for HTTPS).

See [BACKEND.md](BACKEND.md) for the API map, configuration, and security notes, and [docs/PROJECT_COMPLETE_AUDIT.md](docs/PROJECT_COMPLETE_AUDIT.md) for the original gap analysis.
