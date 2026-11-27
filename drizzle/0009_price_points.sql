CREATE TABLE `price_points` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`currency` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`credits` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	CONSTRAINT `price_points_currency_chk` CHECK(length(currency) = 3 AND currency = upper(currency)),
	CONSTRAINT `price_points_amount_chk` CHECK(amount_minor > 0),
	CONSTRAINT `price_points_credits_chk` CHECK(credits > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX `price_points_pkg_currency_uq` ON `price_points` (`package_id`,`currency`);--> statement-breakpoint
INSERT INTO `price_points` (`id`, `package_id`, `currency`, `amount_minor`, `credits`, `active`, `created_at`, `updated_at`, `updated_by`) VALUES
	('seed-credits-5-USD', 'credits-5', 'USD', 500, 5000000, 1, CAST(strftime('%s','now') AS integer) * 1000, CAST(strftime('%s','now') AS integer) * 1000, NULL),
	('seed-credits-10-USD', 'credits-10', 'USD', 1000, 10000000, 1, CAST(strftime('%s','now') AS integer) * 1000, CAST(strftime('%s','now') AS integer) * 1000, NULL),
	('seed-credits-25-USD', 'credits-25', 'USD', 2500, 25000000, 1, CAST(strftime('%s','now') AS integer) * 1000, CAST(strftime('%s','now') AS integer) * 1000, NULL),
	('seed-credits-50-USD', 'credits-50', 'USD', 5000, 50000000, 1, CAST(strftime('%s','now') AS integer) * 1000, CAST(strftime('%s','now') AS integer) * 1000, NULL),
	('seed-credits-100-USD', 'credits-100', 'USD', 10000, 100000000, 1, CAST(strftime('%s','now') AS integer) * 1000, CAST(strftime('%s','now') AS integer) * 1000, NULL);
