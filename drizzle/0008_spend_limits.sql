ALTER TABLE `accounts` ADD `monthly_limit_micro_usd` integer;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `monthly_limit_micro_usd` integer;--> statement-breakpoint
ALTER TABLE `credit_holds` ADD `key_id` text;--> statement-breakpoint
CREATE INDEX `usage_key_time_idx` ON `usage_events` (`key_id`,`created_at`);