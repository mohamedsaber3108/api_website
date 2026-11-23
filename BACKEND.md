# Wasl AI backend

Cloudflare Worker (Vinext) + D1 (Drizzle). All money is integer micro-USD; the balance is the sum of an append-only `credit_ledger`.

## Setup

1. `pnpm install`
2. `pnpm build`
3. Apply migrations in order (local):
   `node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/000X_name.sql`
   Production: run the same files with `--remote` against the real database.
4. Configure variables (see `.dev.vars.example`). Locally, `pnpm start` does not pick up `.dev.vars`; pass them with `--var`:
   `pnpm start -- --port 8799 --var APP_ENV:development --var ADMIN_EMAILS:you@example.com`
   Production: `wrangler secret put OPENROUTER_API_KEY` (and the Stripe/Resend secrets); non-secrets as `[vars]`.
5. Smoke test (local, APP_ENV=development): `node scripts/smoke-test.mjs http://127.0.0.1:8799 you@example.com`

## Turning features on

| Feature | Required variables |
|---|---|
| Paid inference `/api/v1/chat/completions` | `INFERENCE_ENABLED=true`, `OPENROUTER_API_KEY` (only with a provider agreement that allows resale) |
| Card top-ups (Stripe Checkout) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; webhook URL `POST /api/billing/webhook` |
| Email (verify, reset, receipts, ticket replies) | `RESEND_API_KEY`, `EMAIL_FROM` |
| Admin access | Email listed in `ADMIN_EMAILS` and verified |

Without these, the related endpoints answer `503` and the UI shows "not activated".

## API map

- Auth: `/api/auth/register|login|logout|session|verify-email|resend-verification|forgot-password|reset-password|sessions`
- Account: `/api/account` (GET, DELETE), `/profile`, `/password`, `/keys` (+ `/rotate`), `/usage` (+ `/export` CSV), `/saved`, `/playground`
- Billing: `/api/billing`, `/checkout`, `/webhook`, `/invoices/:id`
- Support: `/api/support`, `/api/support/tickets`, `/api/support/tickets/:id`
- Admin (role admin/support): `/api/admin/overview|users|users/:id|users/:id/credits|tickets|tickets/:id|models|usage|incidents|audit`
- OpenAPI 3.1 spec: `/api/v1/openapi.json`
- Legal pages (frontend): `/terms`, `/privacy`, `/refund`, `/acceptable-use`. These are drafts: replace `[COMPANY LEGAL NAME]`, `[legal@your-domain]` and `[JURISDICTION]` in `components/legal.tsx` and have a lawyer review them. If you change the text, bump `LEGAL_VERSION` there and `TERMS_VERSION` in `lib/server/config.ts` together.
- Public / API-key: `/api/v1/models`, `/models/:id`, `/pricing/estimate`, `/health`, `/status`, `/chat/completions` (scope `chat`), `/balance` and `/usage` (scope `usage`), `/try` (BYOK)

## Security notes

- Sessions: random token in an HttpOnly SameSite=Lax cookie; only its SHA-256 is stored. Cookie-authenticated mutations require a same-origin `Origin` header.
- Passwords: PBKDF2-SHA256, 100k iterations (Workers maximum).
- API keys: `wasl_` + 64 hex; only the SHA-256 is stored; scopes, expiry, per-key rate limit, rotation.
- Webhooks: Stripe signature verified on the raw body with a 5-minute window; events and ledger entries are idempotent.
- `APP_ENV` must be exactly `development` for verify/reset tokens to be echoed in responses; anything else is treated as production.
