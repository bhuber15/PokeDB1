CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`ean` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_ean_unique` ON `products` (`ean`);--> statement-breakpoint
ALTER TABLE `inventory_items` ADD `product_id` integer REFERENCES products(id);--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_items_product_id_unique` ON `inventory_items` (`product_id`) WHERE product_id IS NOT NULL;