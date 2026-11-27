CREATE TABLE `admin_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_user_id` text NOT NULL,
	`payload` text NOT NULL,
	`reason` text NOT NULL,
	`requested_by` text NOT NULL,
	`request_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`decision_reason` text,
	FOREIGN KEY (`target_user_id`) REFERENCES `accounts`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by`) REFERENCES `accounts`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `admin_requests_status_idx` ON `admin_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `admin_requests_key_uq` ON `admin_requests` (`requested_by`,`request_key`);