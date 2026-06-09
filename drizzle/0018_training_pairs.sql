CREATE TABLE `training_pairs` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`session_hash` text NOT NULL,
	`captured_at` integer NOT NULL,
	FOREIGN KEY (`turn_id`) REFERENCES `orchestrator_turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `training_pairs_turn` ON `training_pairs` (`turn_id`);--> statement-breakpoint
CREATE INDEX `training_pairs_captured` ON `training_pairs` (`captured_at`);