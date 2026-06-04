ALTER TABLE `score_versions` ADD `schema_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `score_versions` ADD `pre_migration_score_json` text;
