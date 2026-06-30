CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`shop_name` text DEFAULT 'PokeDB' NOT NULL,
	`usd_to_gbp` real DEFAULT 0.79 NOT NULL,
	`margin_multiplier` real DEFAULT 0.85 NOT NULL,
	`high_value_threshold` real DEFAULT 50 NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
