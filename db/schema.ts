import { sqliteTable, text, integer, index, uniqueIndex, primaryKey, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * PAY-2 / PKG-1: price and credit amount per (package, currency), set by hand by a super_admin. Not converted at checkout.
 * `credits` is micro-USD of credit granted. `amountMinor` is the charge in the currency's minor units (2 decimals for EGP, SAR, USD).
 */
export const pricePoints = sqliteTable('price_points', {
  id: text('id').primaryKey(),
  packageId: text('package_id').notNull(),
  /** Upper-case ISO code: EGP, SAR or USD. */
  currency: text('currency').notNull(),
  amountMinor: integer('amount_minor').notNull(),
  credits: integer('credits').notNull(),
  active: integer('active').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  updatedBy: text('updated_by'),
}, t => [
  uniqueIndex('price_points_pkg_currency_uq').on(t.packageId, t.currency),
  check('price_points_currency_chk', sql`length(currency) = 3 AND currency = upper(currency)`),
  check('price_points_amount_chk', sql`amount_minor > 0`),
  check('price_points_credits_chk', sql`credits > 0`),
]);

/**
 * Money is stored as integer micro-USD (1 USD = 1_000_000) everywhere except
 * `payments.amountMinor`, which keeps the gateway's own minor units (cents).
 */

export const accounts = sqliteTable('accounts', {
  userId: text('user_id').primaryKey(),
  email: text('email').notNull(),
  createdAt: integer('created_at').notNull(),
  name: text('name'),
  /** 'password' for Wasl-native accounts, 'chatgpt' for hosted ChatGPT identity. */
  authProvider: text('auth_provider').notNull().default('chatgpt'),
  passwordHash: text('password_hash'),
  /** customer | support | admin | super_admin. Admin roles are only effective once the email is verified. */
  role: text('role').notNull().default('customer'),
  /** active | suspended | deleted */
  status: text('status').notNull().default('active'),
  emailVerifiedAt: integer('email_verified_at'),
  termsAcceptedAt: integer('terms_accepted_at'),
  termsVersion: text('terms_version'),
  lastLoginAt: integer('last_login_at'),
  /** JSON: { lang, theme, currency } */
  preferences: text('preferences'),
  /** FEAT-2: optional monthly spend limit for the whole account (micro-USD). null = no limit. */
  monthlyLimitMicroUsd: integer('monthly_limit_micro_usd'),
}, t => [
  uniqueIndex('accounts_password_email_uq').on(t.email).where(sql`auth_provider = 'password'`),
  index('accounts_email_idx').on(t.email),
]);

export const sessions = sqliteTable('sessions', {
  /** SHA-256 of the cookie token. */
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => accounts.userId),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  /** Set when this session passed an MFA check (TOTP or recovery code). Admin routes need it. */
  mfaVerifiedAt: integer('mfa_verified_at'),
}, t => [index('sessions_user_idx').on(t.userId)]);

/** TOTP secret per admin, AES-GCM encrypted with MFA_ENCRYPTION_KEY (user id as additional data). `enrolledAt` is null while enrolment is pending. */
export const mfaCredentials = sqliteTable('mfa_credentials', {
  userId: text('user_id').primaryKey().references(() => accounts.userId),
  secretEnc: text('secret_enc').notNull(),
  createdAt: integer('created_at').notNull(),
  enrolledAt: integer('enrolled_at'),
  /** Highest 30 s TOTP step already accepted; a code for a step <= this is a replay. */
  lastUsedStep: integer('last_used_step'),
});

/** Single-use recovery codes, stored only as HMAC-SHA-256 keyed with MFA_ENCRYPTION_KEY. */
export const mfaRecoveryCodes = sqliteTable('mfa_recovery_codes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => accounts.userId),
  hash: text('hash').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  usedAt: integer('used_at'),
}, t => [index('mfa_recovery_user_idx').on(t.userId)]);

export const authTokens = sqliteTable('auth_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => accounts.userId),
  /** verify_email | reset_password */
  type: text('type').notNull(),
  hash: text('hash').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
}, t => [index('auth_tokens_user_idx').on(t.userId, t.type)]);

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => accounts.userId),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  hash: text('hash').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  revokedAt: integer('revoked_at'),
  /** Comma separated: chat, usage. */
  scopes: text('scopes').notNull().default('chat'),
  expiresAt: integer('expires_at'),
  lastUsedAt: integer('last_used_at'),
  rateLimitPerMin: integer('rate_limit_per_min').notNull().default(60),
  rotatedFromId: text('rotated_from_id'),
  /** FEAT-2: optional monthly spend limit for this key (micro-USD). null = no limit. */
  monthlyLimitMicroUsd: integer('monthly_limit_micro_usd'),
}, t => [index('keys_user_idx').on(t.userId)]);

export const usageEvents = sqliteTable('usage_events', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => accounts.userId),
  keyId: text('key_id').references(() => apiKeys.id),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  /** Amount charged to the customer. */
  costMicroUsd: integer('cost_micro_usd').notNull(),
  createdAt: integer('created_at').notNull(),
  /** One event per gateway request; unique to keep metering idempotent. */
  requestId: text('request_id'),
  providerCostMicroUsd: integer('provider_cost_micro_usd'),
  status: text('status').notNull().default('ok'),
  latencyMs: integer('latency_ms'),
  source: text('source').notNull().default('api'),
}, t => [
  index('usage_user_time_idx').on(t.userId, t.createdAt),
  index('usage_key_time_idx').on(t.keyId, t.createdAt),
  uniqueIndex('usage_request_uq').on(t.requestId),
]);

/** Append-only. Balance is SUM(delta_micro_usd). */
export const creditLedger = sqliteTable('credit_ledger', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => accounts.userId),
  deltaMicroUsd: integer('delta_micro_usd').notNull(),
  /** topup | usage | refund | adjustment | bonus */
  type: text('type').notNull(),
  refType: text('ref_type'),
  refId: text('ref_id'),
  idempotencyKey: text('idempotency_key').notNull(),
  note: text('note'),
  createdBy: text('created_by'),
  createdAt: integer('created_at').notNull(),
}, t => [
  uniqueIndex('ledger_idem_uq').on(t.idempotencyKey),
  index('ledger_user_time_idx').on(t.userId, t.createdAt),
]);

/**
 * Credit held for one in-flight gateway call (SEC-1). Open holds that have not expired count against
 * the spendable balance. Rows are never deleted: status moves open -> settled | released.
 */
export const creditHolds = sqliteTable('credit_holds', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => accounts.userId),
  requestId: text('request_id').notNull(),
  amountMicroUsd: integer('amount_micro_usd').notNull(),
  /** open | settled | released */
  status: text('status').notNull().default('open'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  /** FEAT-2: the API key this call used (null for the playground), so per-key limits can count open holds. */
  keyId: text('key_id'),
}, t => [
  uniqueIndex('holds_request_uq').on(t.requestId),
  index('holds_user_status_idx').on(t.userId, t.status, t.expiresAt),
]);

export const payments = sqliteTable('payments', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => accounts.userId),
  provider: text('provider').notNull(),
  providerSessionId: text('provider_session_id'),
  providerPaymentIntent: text('provider_payment_intent'),
  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull().default('usd'),
  creditMicroUsd: integer('credit_micro_usd').notNull(),
  refundedMinor: integer('refunded_minor').notNull().default(0),
  /** pending | paid | failed | expired | refunded | partially_refunded */
  status: text('status').notNull().default('pending'),
  createdAt: integer('created_at').notNull(),
  completedAt: integer('completed_at'),
}, t => [
  index('payments_user_idx').on(t.userId, t.createdAt),
  index('payments_session_idx').on(t.providerSessionId),
  index('payments_intent_idx').on(t.providerPaymentIntent),
]);

export const paymentWebhookEvents = sqliteTable('payment_webhook_events', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  type: text('type').notNull(),
  receivedAt: integer('received_at').notNull(),
  processedAt: integer('processed_at'),
  error: text('error'),
});

export const invoices = sqliteTable('invoices', {
  id: text('id').primaryKey(),
  number: text('number').notNull().unique(),
  userId: text('user_id').notNull().references(() => accounts.userId),
  paymentId: text('payment_id').references(() => payments.id),
  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull(),
  description: text('description').notNull(),
  status: text('status').notNull().default('paid'),
  issuedAt: integer('issued_at').notNull(),
}, t => [index('invoices_user_idx').on(t.userId, t.issuedAt), uniqueIndex('invoices_payment_uq').on(t.paymentId)]);

export const supportTickets = sqliteTable('support_tickets', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  email: text('email').notNull(),
  name: text('name').notNull(),
  subject: text('subject').notNull(),
  message: text('message').notNull(),
  status: text('status').notNull().default('open'),
  createdAt: integer('created_at').notNull(),
  /** low | normal | high | urgent */
  priority: text('priority').notNull().default('normal'),
  assigneeId: text('assignee_id'),
  updatedAt: integer('updated_at'),
}, t => [
  index('support_email_time_idx').on(t.email, t.createdAt),
  index('support_status_idx').on(t.status, t.updatedAt),
]);

export const ticketMessages = sqliteTable('ticket_messages', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id').notNull().references(() => supportTickets.id),
  authorId: text('author_id'),
  /** customer | staff */
  authorRole: text('author_role').notNull(),
  authorName: text('author_name').notNull(),
  body: text('body').notNull(),
  createdAt: integer('created_at').notNull(),
}, t => [index('ticket_messages_idx').on(t.ticketId, t.createdAt)]);

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  meta: text('meta'),
  ip: text('ip'),
  createdAt: integer('created_at').notNull(),
  // SEC-4 (migration 0006). All nullable: rows written before it have none of these and are not part of the chain.
  seq: integer('seq'),
  prevHash: text('prev_hash'),
  hash: text('hash'),
  actorRole: text('actor_role'),
  before: text('before'),
  after: text('after'),
  reason: text('reason'),
  result: text('result'),
}, t => [index('audit_time_idx').on(t.createdAt), index('audit_actor_idx').on(t.actorId), uniqueIndex('audit_seq_uq').on(t.seq), index('audit_action_idx').on(t.action), index('audit_target_idx').on(t.targetId)]);

/**
 * A sensitive admin action waiting for a second person (SEC-2). kind: credit_adjustment | role_change.
 * status: pending | approved | rejected | expired. Pending requests expire after 24 hours (`expiresAt`).
 * `payload` is JSON: { amountUsd, note } or { role }. `requestKey` makes a retried request idempotent per requester.
 */
export const adminRequests = sqliteTable('admin_requests', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  targetUserId: text('target_user_id').notNull().references(() => accounts.userId),
  payload: text('payload').notNull(),
  reason: text('reason').notNull(),
  requestedBy: text('requested_by').notNull().references(() => accounts.userId),
  requestKey: text('request_key'),
  status: text('status').notNull().default('pending'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  decidedBy: text('decided_by'),
  decidedAt: integer('decided_at'),
  decisionReason: text('decision_reason'),
}, t => [
  index('admin_requests_status_idx').on(t.status, t.createdAt),
  uniqueIndex('admin_requests_key_uq').on(t.requestedBy, t.requestKey),
]);

/**
 * Feature flags set from the admin (ADM-D1 slice 2). No row means "not switched off". `enabled` is 1 or 0.
 * Key `inference` is the emergency stop. Written only through lib/server/flags.ts.
 */
export const featureFlags = sqliteTable('feature_flags', {
  key: text('key').primaryKey(),
  enabled: integer('enabled').notNull(),
  updatedAt: integer('updated_at').notNull(),
  updatedBy: text('updated_by'),
});

/** Admin overrides per catalog model: availability and markup. */
export const modelConfigs = sqliteTable('model_configs', {
  modelId: text('model_id').primaryKey(),
  enabled: integer('enabled').notNull().default(1),
  /** null = use platform default markup. */
  markupPercent: integer('markup_percent'),
  note: text('note'),
  updatedAt: integer('updated_at').notNull(),
});

export const rateLimitBuckets = sqliteTable('rate_limit_buckets', {
  key: text('key').primaryKey(),
  windowStart: integer('window_start').notNull(),
  count: integer('count').notNull(),
});

export const savedModels = sqliteTable('saved_models', {
  userId: text('user_id').notNull().references(() => accounts.userId),
  modelId: text('model_id').notNull(),
  createdAt: integer('created_at').notNull(),
}, t => [primaryKey({ columns: [t.userId, t.modelId] })]);

export const incidents = sqliteTable('incidents', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  /** investigating | identified | monitoring | resolved */
  status: text('status').notNull().default('investigating'),
  /** minor | major | critical */
  severity: text('severity').notNull().default('minor'),
  createdAt: integer('created_at').notNull(),
  resolvedAt: integer('resolved_at'),
});
