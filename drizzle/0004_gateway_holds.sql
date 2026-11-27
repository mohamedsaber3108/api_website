CREATE TABLE `credit_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`amount_micro_usd` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `accounts`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holds_request_uq` ON `credit_holds` (`request_id`);--> statement-breakpoint
CREATE INDEX `holds_user_status_idx` ON `credit_holds` (`user_id`,`status`,`expires_at`);