CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`meta` text,
	`ip` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_time_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_actor_idx` ON `audit_logs` (`actor_id`);--> statement-breakpoint
CREATE TABLE `auth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `accounts`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_tokens_hash_unique` ON `auth_tokens` (`hash`);--> statement-breakpoint
CREATE INDEX `auth_tokens_user_idx` ON `auth_tokens` (`user_id`,`type`);--> statement-breakpoint
CREATE TABLE `credit_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`delta_micro_usd` integer NOT NULL,
	`type` text NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`idempotency_key` text NOT NULL,
	`note` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `accounts`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_idem_uq` ON `credit_ledger` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `ledger_user_time_idx` ON `credit_ledger` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'investigating' NOT NULL,
	`severity` text DEFAULT 'minor' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`user_id` text NOT NULL,
	`payment_id` text,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'paid' NOT NULL,
	`issued_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `accounts`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_number_unique` ON `invoices` (`number`);--> statement-breakpoint
CREATE INDEX `invoices_user_idx` ON `invoices` (`user_id`,`issued_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_payment_uq` ON `invoices` (`payment_id`);--> statement-breakpoint
CREATE TABLE `model_configs` (
	`model_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`markup_percent` integer,
	`note` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payment_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`type` text NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_session_id` text,
	`provider_payment_intent` text,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`credit_micro_usd` integer NOT NULL,
	`refunded_minor` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `accounts`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payments_user_idx` ON `payments` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `payments_session_idx` ON `payments` (`provider_session_id`);--> statement-breakpoint
CREATE INDEX `payments_intent_idx` ON `payments` (`provider_payment_intent`);--> statement-breakpoint
CREATE TABLE `rate_limit_buckets` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `saved_models` (
	`user_id` text NOT NULL,
	`model_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `model_id`),
	FOREIGN KEY (`user_id`) REFERENCES `accounts`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `accounts`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `ticket_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`author_id` text,
	`author_role` text NOT NULL,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ticket_messages_idx` ON `ticket_messages` (`ticket_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `name` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `auth_provider` text DEFAULT 'chatgpt' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `password_hash` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `role` text DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `email_verified_at` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `terms_accepted_at` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `terms_version` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `last_login_at` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `preferences` text;--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_password_email_uq` ON `accounts` (`email`) WHERE auth_provider = 'password';--> statement-breakpoint
CREATE INDEX `accounts_email_idx` ON `accounts` (`email`);--> statement-breakpoint
ALTER TABLE `api_keys` ADD `scopes` text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `last_used_at` integer;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `rate_limit_per_min` integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `rotated_from_id` text;--> statement-breakpoint
ALTER TABLE `support_tickets` ADD `priority` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `support_tickets` ADD `assignee_id` text;--> statement-breakpoint
ALTER TABLE `support_tickets` ADD `updated_at` integer;--> statement-breakpoint
CREATE INDEX `support_status_idx` ON `support_tickets` (`status`,`updated_at`);--> statement-breakpoint
ALTER TABLE `usage_events` ADD `request_id` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `provider_cost_micro_usd` integer;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `status` text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `latency_ms` integer;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `source` text DEFAULT 'api' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `usage_request_uq` ON `usage_events` (`request_id`);