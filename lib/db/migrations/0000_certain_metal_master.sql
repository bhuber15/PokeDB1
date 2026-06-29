CREATE TABLE `cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`game` text DEFAULT 'pokemon' NOT NULL,
	`set_name` text NOT NULL,
	`set_number` text NOT NULL,
	`variant` text,
	`language` text DEFAULT 'EN' NOT NULL,
	`external_id` text,
	`tcgplayer_id` text,
	`image_url` text,
	`image_url_large` text
);
--> statement-breakpoint
CREATE TABLE `inventory_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer,
	`condition` text NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`cost_price` real NOT NULL,
	`sell_price_override` real,
	`qr_code` text NOT NULL,
	`location` text,
	`defect_notes` text,
	`low_stock_threshold` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_items_qr_code_unique` ON `inventory_items` (`qr_code`);--> statement-breakpoint
CREATE TABLE `price_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`tcgplayer_market` real,
	`tcgplayer_low` real,
	`tcgplayer_mid` real,
	`tcgplayer_high` real,
	`last_synced_at` text DEFAULT (datetime('now')) NOT NULL,
	`is_high_value` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_cache_card_id_unique` ON `price_cache` (`card_id`);--> statement-breakpoint
CREATE TABLE `sale_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`inventory_item_id` integer,
	`quantity` integer NOT NULL,
	`price_at_sale` real NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inventory_item_id`) REFERENCES `inventory_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sales` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`staff_id` integer,
	`subtotal` real NOT NULL,
	`discount_amount` real DEFAULT 0 NOT NULL,
	`vat_amount` real DEFAULT 0 NOT NULL,
	`vat_scheme` text DEFAULT 'none' NOT NULL,
	`total` real NOT NULL,
	`payment_method` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `staff` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`pin_hash` text NOT NULL,
	`role` text DEFAULT 'staff' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
