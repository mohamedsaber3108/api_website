CREATE TABLE `mfa_credentials` (
	`user_id` text PRIMARY KEY NOT NULL,
	`secret_enc` text NOT NULL,
	`created_at` integer NOT NULL,
	`enrolled_at` integer,
	`last_used_step` integer,
	FOREIGN KEY (`user_id`) REFERENCES `accounts`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `mfa_recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `accounts`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mfa_recovery_codes_hash_unique` ON `mfa_recovery_codes` (`hash`);--> statement-breakpoint
CREATE INDEX `mfa_recovery_user_idx` ON `mfa_recovery_codes` (`user_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `mfa_verified_at` integer;