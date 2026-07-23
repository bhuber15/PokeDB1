ALTER TABLE `cards` ADD `alias_name` text;--> statement-breakpoint
CREATE INDEX `idx_cards_game_language` ON `cards` (`game`,`language`);--> statement-breakpoint
ALTER TABLE `settings` ADD `enabled_languages` text DEFAULT '["EN"]' NOT NULL;