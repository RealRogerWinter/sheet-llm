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
ALTER TABLE `credit_holds` ADD `idempotency_key` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `credit_holds_idempotency_key_unique` ON `credit_holds` (`idempotency_key`);--> statement-breakpoint
ALTER TABLE `usage_ledger` ADD `hold_id` text REFERENCES credit_holds(id);