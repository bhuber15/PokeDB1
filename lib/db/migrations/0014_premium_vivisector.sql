DROP INDEX "auth_lockouts_scope_unique";--> statement-breakpoint
DROP INDEX "cards_external_id_unique";--> statement-breakpoint
DROP INDEX "inventory_items_qr_code_unique";--> statement-breakpoint
DROP INDEX "price_cache_card_id_unique";--> statement-breakpoint
DROP INDEX "price_history_card_id_recorded_on_unique";--> statement-breakpoint
DROP INDEX "sales_client_uuid_unique";--> statement-breakpoint
ALTER TABLE `inventory_items` ALTER COLUMN "cost_price" TO "cost_price" integer;--> statement-breakpoint
CREATE UNIQUE INDEX `auth_lockouts_scope_unique` ON `auth_lockouts` (`scope`);--> statement-breakpoint
CREATE UNIQUE INDEX `cards_external_id_unique` ON `cards` (`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_items_qr_code_unique` ON `inventory_items` (`qr_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `price_cache_card_id_unique` ON `price_cache` (`card_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `price_history_card_id_recorded_on_unique` ON `price_history` (`card_id`,`recorded_on`);--> statement-breakpoint
CREATE UNIQUE INDEX `sales_client_uuid_unique` ON `sales` (`client_uuid`);--> statement-breakpoint
ALTER TABLE `settings` ADD `margin_no_cost_handling` text DEFAULT 'exclude' NOT NULL;