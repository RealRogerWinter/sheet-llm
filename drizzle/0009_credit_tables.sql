CREATE TABLE `credit_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`credits` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `credit_holds_user` ON `credit_holds` (`user_id`);--> statement-breakpoint
CREATE INDEX `credit_holds_expires` ON `credit_holds` (`expires_at`);--> statement-breakpoint
CREATE TABLE `credit_purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`external_ref` text,
	`credits_delta` integer NOT NULL,
	`amount_minor_usd` integer,
	`currency` text,
	`status` text DEFAULT 'settled' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_purchases_external_ref_unique` ON `credit_purchases` (`external_ref`);--> statement-breakpoint
CREATE INDEX `credit_purchases_user_created` ON `credit_purchases` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `credit_wallets` (
	`user_id` text PRIMARY KEY NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`held` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "credit_wallets_nonneg" CHECK(balance >= 0 AND held >= 0)
);
--> statement-breakpoint
CREATE TABLE `usage_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text,
	`request_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`kind` text NOT NULL,
	`model` text,
	`generation_tier` text,
	`input_tokens` integer,
	`cached_input_tokens` integer,
	`cache_creation_input_tokens` integer,
	`output_tokens` integer,
	`cost_micro_usd` integer,
	`credits_charged` integer NOT NULL,
	`balance_after` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_ledger_idempotency_key_unique` ON `usage_ledger` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `usage_ledger_user_created` ON `usage_ledger` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_ledger_request` ON `usage_ledger` (`request_id`);