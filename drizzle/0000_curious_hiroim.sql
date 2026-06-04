CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`content_json` text NOT NULL,
	`tool_use_id` text,
	`score_version_id` text,
	`is_synthetic` integer DEFAULT 0 NOT NULL,
	`stream_status` text DEFAULT 'complete' NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`score_version_id`) REFERENCES `score_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_session_seq` ON `messages` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `messages_tool_use` ON `messages` (`session_id`,`tool_use_id`) WHERE tool_use_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `messages_streaming` ON `messages` (`stream_status`,`created_at`) WHERE stream_status = 'partial';--> statement-breakpoint
CREATE TABLE `score_versions` (
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
	CONSTRAINT "score_versions_source_valid" CHECK(source IN ('llm', 'edit', 'import', 'fork-seed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `score_versions_idempotency_key_unique` ON `score_versions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `sv_session_created` ON `score_versions` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sv_session_hash` ON `score_versions` (`session_id`,`score_hash`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text,
	`head_version_id` text,
	`forked_from_session_id` text,
	`forked_from_version_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_message_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`head_version_id`) REFERENCES `score_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`forked_from_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`forked_from_version_id`) REFERENCES `score_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sessions_user_activity` ON `sessions` (`user_id`,`last_message_at`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `sessions_user_forked` ON `sessions` (`user_id`,`forked_from_session_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_external_id_unique` ON `users` (`external_id`);--> statement-breakpoint
CREATE INDEX `users_last_seen` ON `users` (`last_seen_at`);