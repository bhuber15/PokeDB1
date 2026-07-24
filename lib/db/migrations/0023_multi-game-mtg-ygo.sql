CREATE TABLE `catalogue_sync_state` (
	`game` text PRIMARY KEY NOT NULL,
	`cursor` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `settings` ADD `enabled_games` text DEFAULT '["pokemon"]' NOT NULL;