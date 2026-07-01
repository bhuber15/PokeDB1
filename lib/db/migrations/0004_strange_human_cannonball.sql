ALTER TABLE `price_cache` ADD `cardmarket_trend` real;--> statement-breakpoint
ALTER TABLE `price_cache` ADD `cardmarket_low` real;--> statement-breakpoint
ALTER TABLE `price_cache` ADD `cardmarket_avg` real;--> statement-breakpoint
ALTER TABLE `price_cache` ADD `cardmarket_synced_at` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `eur_to_gbp` real DEFAULT 0.86 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `primary_price_source` text DEFAULT 'cardmarket' NOT NULL;