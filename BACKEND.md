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

## Tests

`pnpm test` runs the unit and route tests (vitest, plain Node 22). Run one file with `pnpm exec vitest run tests/billing.test.ts`.

- Database: a local in-memory D1 (real SQLite in the Workers runtime, started through wrangler's `getPlatformProxy`). All `drizzle/*.sql` migrations are applied first. No live database is used.
- `cloudflare:workers` is aliased to `tests/helpers/cloudflare-workers.ts` (see `vitest.config.ts`); tests set secrets and flags on that `env` object.
- Stripe and the model provider are stubbed with `vi.stubGlobal('fetch', ...)`. No real key and no network call.
- Covered: password hash, sessions, API keys, ledger idempotency, Stripe signature, webhook replay, refunds, `chargeMicro`, the 15 admin handlers (401 and 403), error codes, checkout. Tests named `FINDING:` pin a known defect; when the defect is fixed, update that test.
- Start-up cost is about 1 second per test file; files run one after another.

## Turning features on

| Feature | Required variables |
|---|---|
| Paid inference `/api/v1/chat/completions` | `INFERENCE_ENABLED=true`, `OPENROUTER_API_KEY` (only with a provider agreement that allows resale) |
| Card top-ups (Stripe Checkout) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; webhook URL `POST /api/billing/webhook` |
| Email (verify, reset, receipts, ticket replies) | `RESEND_API_KEY`, `EMAIL_FROM` |
| Admin access | An account with role `admin` or `super_admin`, MFA set up (see "Admin approvals"). Before any `super_admin` exists, a verified email in `ADMIN_EMAILS` is also admin. |

Without these, the related endpoints answer `503` and the UI shows "not activated".

## API map

- Auth: `/api/auth/register|login|logout|session|verify-email|resend-verification|forgot-password|reset-password|sessions`
- Account: `/api/account` (GET, DELETE), `/profile`, `/password`, `/keys` (+ `/rotate`), `/usage` (+ `/export` CSV), `/saved`, `/playground`
- Billing: `/api/billing`, `/checkout`, `/webhook`, `/invoices/:id`
- Support: `/api/support`, `/api/support/tickets`, `/api/support/tickets/:id`
- Admin (role admin/super_admin/support): `/api/admin/overview|users|users/:id|users/:id/credits|requests|requests/:id|tickets|tickets/:id|models|usage|incidents|audit`
- OpenAPI 3.1 spec: `/api/v1/openapi.json`
- Legal pages (frontend): `/terms`, `/privacy`, `/refund`, `/acceptable-use`. These are drafts: replace `[COMPANY LEGAL NAME]`, `[legal@your-domain]` and `[JURISDICTION]` in `components/legal.tsx` and have a lawyer review them. If you change the text, bump `LEGAL_VERSION` there and `TERMS_VERSION` in `lib/server/config.ts` together.
- Public / API-key: `/api/v1/models`, `/models/:id`, `/pricing/estimate`, `/health`, `/status`, `/chat/completions` (scope `chat`), `/balance` and `/usage` (scope `usage`), `/try` (BYOK)

## Gateway charging (SEC-1, GW-1)

Money rules for `POST /api/v1/chat/completions` and the playground (`lib/server/gateway.ts`, `lib/server/ledger.ts`, table `credit_holds`).

1. **Hold first.** Before the provider is called, the gateway reserves the worst-case cost (estimated input plus `max_tokens` output, with markup). The hold is one conditional `INSERT` run inside a D1 batch: it is inserted only if `balance - open holds >= worst-case cost`. If not, the call gets `402 insufficient_credits` and the provider is never called. The message is in English and Arabic and links to `/dashboard` (prefixed with `PUBLIC_BASE_URL` when set).
2. **Settle.** The real charge (ledger row `usage`, usage row) and the hold closing (`settled`) are written in the same batch. The charge never exceeds the hold, so the balance cannot go below zero. The provider cost stays on the usage row.
3. **Release.** A failed call (provider error, timeout, bad reply) closes the hold as `released` and charges nothing.
4. **Expiry.** A hold counts only while `status = open` and `expires_at > now`. Holds last 10 minutes (the upstream timeout is 5), so a crashed call frees its credit by itself. Hold rows are never deleted.
5. **Stream cut (aborted).** If the client leaves or the provider connection drops, the usage row gets `status = aborted` and the call is charged: from the provider's `usage` (cost, else tokens) if the provider sent it before the cut; otherwise from the input estimate plus the output actually delivered (`characters / 3` tokens). In every case the charge is capped at the hold. An aborted call is never free: the input is always charged.
6. **Rounding.** Charge = `ceil(provider cost x (1 + markup%))` in whole micro-USD, integer arithmetic only. A provider cost above 0 charges at least 1 micro-USD.

7. **Balance views (FU-5).** `GET /api/v1/balance` (scope `usage`), `GET /api/billing` and `GET /api/account` return the ledger balance, the open unexpired holds and the available amount (`balance - held`), all from one statement (`getBalanceSummary`). Existing fields are unchanged. `/api/v1/balance` adds `available_usd`, `available_micro_usd` and `held_micro_usd` next to `balance_usd`; `/api/billing` and `/api/account` add `heldMicroUsd` and `availableMicroUsd` next to `balanceMicroUsd`. The dashboard shows one text line: balance, held for running requests, available. A 402 means `available` is below the worst-case cost of the call.

Known limit: the provider may bill us for tokens it generated after the client left; the delivered-output estimate can be lower than that.

## Admin approvals and roles (SEC-2)

Code: `lib/server/approvals.ts`, `lib/server/auth.ts`, table `admin_requests` (migration `drizzle/0005_admin_requests.sql`).

**Roles.** `customer`, `support`, `admin`, `super_admin`. `super_admin` passes every check that allows `admin`. Only a `super_admin` can promote someone to `admin` or `super_admin`, and only a `super_admin` can demote or suspend an `admin` or `super_admin`. An `admin` who tries gets `403 super_admin_required`. Admins still manage `customer` and `support` roles and suspension of non-admins directly. The first `super_admin` can only be made on the server: `sudo bash deploy/make-admin.sh you@example.com super_admin` (or `create-admin.sh`).

**Pending requests.** These two actions never apply directly. They create a row in `admin_requests` and answer `202 {pending: true, requestId, expiresAt}`:
- `POST /api/admin/users/:id/credits` (needs MFA verified in the last 15 minutes; amount limit stays 1,000 USD per call). No amount limit config exists yet: **every** adjustment needs an approver until the owner sets limits (Q-API-5).
- `PATCH /api/admin/users/:id` with `role: admin|super_admin` (needs a `reason`; send it alone, without a status change).

A retry with the same `requestKey` returns the same request (`200`, `duplicate: true`).

**Deciding.** `GET /api/admin/requests?status=pending|approved|rejected|expired|all` lists them. `POST /api/admin/requests/:id` with `{action: "approve"|"reject", reason}` decides. Checked on the server:
- The requester cannot approve their own request: `403 self_approval`. The person the request is about cannot approve it: `403 self_target`.
- The approver must be an `admin` or `super_admin` with an MFA-verified session. For a credit approval the MFA check must be within the last 15 minutes: `403 mfa_recent_required`.
- A role request can only be approved by a `super_admin` (`403 super_admin_required`). So promoting needs two super admins.
- The requester may cancel their own request (reject). Anyone else who rejects must be allowed to approve it.
- The claim is one conditional update (`pending` to `approved`/`rejected`), so parallel approvals apply the change once. A repeated approval answers `200` with `duplicate: true` and changes nothing. A decided request: `409 request_closed`. The ledger entry also uses the request id as its idempotency key.
- A role change clears `mfa_verified_at` on the target's sessions. The new role is read on the target's next request.

**Expiry.** A pending request expires 24 hours after it was made (`410 request_expired` on approval). Expiry is applied when requests are listed, created or decided; nothing runs in the background. Each expiry writes one audit row.

**Audit rows** (`audit()`): `admin.request_created`, `admin.request_approved`, `admin.request_rejected`, `admin.request_expired`. An approved credit also writes `admin.credit_adjustment`, and an approved role change writes `admin.user_updated`, as before, with the approver as actor and `requestId` in `meta`.

**Only one admin.** If no other admin (not the requester, not the target) could approve, the request is refused: `409 no_second_approver` with `message_en` and `message_ar`. For a role change the second person must be another `super_admin`. With a single admin every adjustment is blocked until a second admin exists.

**`ADMIN_EMAILS`.**
- No active `super_admin` exists: a verified email in `ADMIN_EMAILS` is `admin` on every request (as before). MFA applies.
- An active `super_admin` exists, default: `ADMIN_EMAILS` grants nothing. The account keeps its stored role.
- Break-glass: `ADMIN_EMAILS_BREAKGLASS=true` (off unless exactly `true`). An `ADMIN_EMAILS` email then gets `admin` (never `super_admin`) while a `super_admin` exists. MFA is required, and every admin request writes an `auth.break_glass_used` audit row (actor, method, path). An email whose stored role is already `admin` or `super_admin` is not break-glass.
- Recovery from the server terminal (`deploy/create-admin.sh`, `make-admin.sh`) is unchanged and accepts `super_admin`.

## Security notes

- Sessions: random token in an HttpOnly SameSite=Lax cookie; only its SHA-256 is stored. Cookie-authenticated mutations require a same-origin `Origin` header.
- Passwords: PBKDF2-SHA256, 100k iterations (Workers maximum).
- API keys: `wasl_` + 64 hex; only the SHA-256 is stored; scopes, expiry, per-key rate limit, rotation.
- Webhooks: Stripe signature verified on the raw body with a 5-minute window; events and ledger entries are idempotent.
- `APP_ENV` must be exactly `development` for verify/reset tokens to be echoed in responses; anything else is treated as production.
