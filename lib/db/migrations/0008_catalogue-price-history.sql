CREATE TABLE `price_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`cardmarket_trend` integer,
	`tcgplayer_market` integer,
	`recorded_on` text NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_history_card_id_recorded_on_unique` ON `price_history` (`card_id`,`recorded_on`);--> statement-breakpoint
UPDATE `cards` SET `external_id` = NULL WHERE `external_id` IS NOT NULL AND `id` NOT IN (SELECT MIN(`id`) FROM `cards` WHERE `external_id` IS NOT NULL GROUP BY `external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cards_external_id_unique` ON `cards` (`external_id`);