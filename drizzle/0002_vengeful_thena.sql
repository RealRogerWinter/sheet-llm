PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_score_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`parent_version_id` text,
	`score_json` text NOT NULL,
	`score_hash` text NOT NULL,
	`source` text NOT NULL,
	`message_id` text,
	`coalesce_key` text,
	`idempotency_key` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_version_id`) REFERENCES `score_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "score_versions_source_valid" CHECK(source IN ('llm', 'edit', 'import', 'fork-seed', 'revert'))
);
--> statement-breakpoint
INSERT INTO `__new_score_versions`("id", "session_id", "parent_version_id", "score_json", "score_hash", "source", "message_id", "coalesce_key", "idempotency_key", "created_at") SELECT "id", "session_id", "parent_version_id", "score_json", "score_hash", "source", "message_id", "coalesce_key", "idempotency_key", "created_at" FROM `score_versions`;--> statement-breakpoint
DROP TABLE `score_versions`;--> statement-breakpoint
ALTER TABLE `__new_score_versions` RENAME TO `score_versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `score_versions_idempotency_key_unique` ON `score_versions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `sv_session_created` ON `score_versions` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sv_session_hash` ON `score_versions` (`session_id`,`score_hash`);