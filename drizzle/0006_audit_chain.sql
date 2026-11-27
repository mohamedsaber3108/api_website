ALTER TABLE `audit_logs` ADD `seq` integer;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `prev_hash` text;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `hash` text;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `actor_role` text;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `before` text;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `after` text;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `result` text;--> statement-breakpoint
CREATE UNIQUE INDEX `audit_seq_uq` ON `audit_logs` (`seq`);--> statement-breakpoint
CREATE INDEX `audit_action_idx` ON `audit_logs` (`action`);--> statement-breakpoint
CREATE INDEX `audit_target_idx` ON `audit_logs` (`target_id`);