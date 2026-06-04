PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_credit_wallets` (
	`user_id` text PRIMARY KEY NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`held` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "credit_wallets_solvent" CHECK(balance >= 0 AND held >= 0 AND held <= balance)
);
--> statement-breakpoint
INSERT INTO `__new_credit_wallets`("user_id", "balance", "held", "version", "updated_at") SELECT "user_id", "balance", "held", "version", "updated_at" FROM `credit_wallets`;--> statement-breakpoint
DROP TABLE `credit_wallets`;--> statement-breakpoint
ALTER TABLE `__new_credit_wallets` RENAME TO `credit_wallets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_credit_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`credits` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_credit_holds`("id", "user_id", "request_id", "idempotency_key", "credits", "status", "expires_at", "created_at", "settled_at") SELECT "id", "user_id", "request_id", "id", "credits", "status", "expires_at", "created_at", "settled_at" FROM `credit_holds`;--> statement-breakpoint
DROP TABLE `credit_holds`;--> statement-breakpoint
ALTER TABLE `__new_credit_holds` RENAME TO `credit_holds`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `credit_holds_user` ON `credit_holds` (`user_id`);--> statement-breakpoint
CREATE INDEX `credit_holds_expires` ON `credit_holds` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `credit_holds_idempotency_key_unique` ON `credit_holds` (`idempotency_key`);--> statement-breakpoint
ALTER TABLE `usage_ledger` ADD `hold_id` text REFERENCES credit_holds(id);