ALTER TABLE `orchestrator_turns` ADD `preservation_ok` integer;--> statement-breakpoint
ALTER TABLE `orchestrator_turns` ADD `preservation_mismatch_count` integer;--> statement-breakpoint
ALTER TABLE `orchestrator_turns` ADD `replacement_retained_identity_ratio` real;--> statement-breakpoint
ALTER TABLE `orchestrator_turns` ADD `replacement_reasons` text;--> statement-breakpoint
ALTER TABLE `orchestrator_turns` ADD `replacement_user_explicit_rewrite` integer;