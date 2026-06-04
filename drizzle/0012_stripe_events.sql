CREATE TABLE `stripe_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`payload` text NOT NULL,
	`user_id` text,
	`credits_granted` integer,
	`reason` text,
	`received_at` integer NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
CREATE INDEX `stripe_events_status` ON `stripe_events` (`status`);--> statement-breakpoint
CREATE INDEX `stripe_events_received` ON `stripe_events` (`received_at`);