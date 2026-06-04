CREATE TABLE `request_quota` (
	`quota_key` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `request_quota_window` ON `request_quota` (`window_start`);