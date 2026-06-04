CREATE TABLE `refund_counters` (
	`user_id` text NOT NULL,
	`day` integer NOT NULL,
	`refund_count` integer DEFAULT 0 NOT NULL,
	`refund_credits` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `day`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "refund_counters_nonneg" CHECK(refund_count >= 0 AND refund_credits >= 0)
);
--> statement-breakpoint
ALTER TABLE `usage_ledger` ADD `reason` text;