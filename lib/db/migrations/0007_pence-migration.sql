DROP INDEX "inventory_items_qr_code_unique";--> statement-breakpoint
DROP INDEX "price_cache_card_id_unique";--> statement-breakpoint
ALTER TABLE `buy_items` ALTER COLUMN "pay_price" TO "pay_price" integer NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_items_qr_code_unique` ON `inventory_items` (`qr_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `price_cache_card_id_unique` ON `price_cache` (`card_id`);--> statement-breakpoint
ALTER TABLE `buy_transactions` ALTER COLUMN "total" TO "total" integer NOT NULL;--> statement-breakpoint
ALTER TABLE `credit_ledger` ALTER COLUMN "delta" TO "delta" integer NOT NULL;--> statement-breakpoint
ALTER TABLE `inventory_items` ALTER COLUMN "cost_price" TO "cost_price" integer NOT NULL;--> statement-breakpoint
ALTER TABLE `inventory_items` ALTER COLUMN "sell_price_override" TO "sell_price_override" integer;--> statement-breakpoint
ALTER TABLE `price_cache` ALTER COLUMN "tcgplayer_market" TO "tcgplayer_market" integer;--> statement-breakpoint
ALTER TABLE `price_cache` ALTER COLUMN "tcgplayer_low" TO "tcgplayer_low" integer;--> statement-breakpoint
ALTER TABLE `price_cache` ALTER COLUMN "tcgplayer_mid" TO "tcgplayer_mid" integer;--> statement-breakpoint
ALTER TABLE `price_cache` ALTER COLUMN "tcgplayer_high" TO "tcgplayer_high" integer;--> statement-breakpoint
ALTER TABLE `price_cache` ALTER COLUMN "cardmarket_trend" TO "cardmarket_trend" integer;--> statement-breakpoint
ALTER TABLE `price_cache` ALTER COLUMN "cardmarket_low" TO "cardmarket_low" integer;--> statement-breakpoint
ALTER TABLE `price_cache` ALTER COLUMN "cardmarket_avg" TO "cardmarket_avg" integer;--> statement-breakpoint
ALTER TABLE `refunds` ALTER COLUMN "amount" TO "amount" integer NOT NULL;--> statement-breakpoint
ALTER TABLE `sale_items` ALTER COLUMN "price_at_sale" TO "price_at_sale" integer NOT NULL;--> statement-breakpoint
ALTER TABLE `sale_items` ALTER COLUMN "cost_at_sale" TO "cost_at_sale" integer;--> statement-breakpoint
ALTER TABLE `sales` ALTER COLUMN "subtotal" TO "subtotal" integer NOT NULL;--> statement-breakpoint
ALTER TABLE `sales` ALTER COLUMN "discount_amount" TO "discount_amount" integer NOT NULL;--> statement-breakpoint
ALTER TABLE `sales` ALTER COLUMN "vat_amount" TO "vat_amount" integer NOT NULL;--> statement-breakpoint
ALTER TABLE `sales` ALTER COLUMN "total" TO "total" integer NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ALTER COLUMN "high_value_threshold" TO "high_value_threshold" integer NOT NULL DEFAULT 5000;--> statement-breakpoint
ALTER TABLE `settings` ADD `vat_scheme` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
UPDATE `inventory_items` SET `cost_price` = CAST(ROUND(`cost_price` * 100) AS INTEGER) WHERE `cost_price` IS NOT NULL;--> statement-breakpoint
UPDATE `inventory_items` SET `sell_price_override` = CAST(ROUND(`sell_price_override` * 100) AS INTEGER) WHERE `sell_price_override` IS NOT NULL;--> statement-breakpoint
UPDATE `price_cache` SET `tcgplayer_market` = CAST(ROUND(`tcgplayer_market` * 100) AS INTEGER) WHERE `tcgplayer_market` IS NOT NULL;--> statement-breakpoint
UPDATE `price_cache` SET `tcgplayer_low` = CAST(ROUND(`tcgplayer_low` * 100) AS INTEGER) WHERE `tcgplayer_low` IS NOT NULL;--> statement-breakpoint
UPDATE `price_cache` SET `tcgplayer_mid` = CAST(ROUND(`tcgplayer_mid` * 100) AS INTEGER) WHERE `tcgplayer_mid` IS NOT NULL;--> statement-breakpoint
UPDATE `price_cache` SET `tcgplayer_high` = CAST(ROUND(`tcgplayer_high` * 100) AS INTEGER) WHERE `tcgplayer_high` IS NOT NULL;--> statement-breakpoint
UPDATE `price_cache` SET `cardmarket_trend` = CAST(ROUND(`cardmarket_trend` * 100) AS INTEGER) WHERE `cardmarket_trend` IS NOT NULL;--> statement-breakpoint
UPDATE `price_cache` SET `cardmarket_low` = CAST(ROUND(`cardmarket_low` * 100) AS INTEGER) WHERE `cardmarket_low` IS NOT NULL;--> statement-breakpoint
UPDATE `price_cache` SET `cardmarket_avg` = CAST(ROUND(`cardmarket_avg` * 100) AS INTEGER) WHERE `cardmarket_avg` IS NOT NULL;--> statement-breakpoint
UPDATE `sales` SET `subtotal` = CAST(ROUND(`subtotal` * 100) AS INTEGER) WHERE `subtotal` IS NOT NULL;--> statement-breakpoint
UPDATE `sales` SET `discount_amount` = CAST(ROUND(`discount_amount` * 100) AS INTEGER) WHERE `discount_amount` IS NOT NULL;--> statement-breakpoint
UPDATE `sales` SET `vat_amount` = CAST(ROUND(`vat_amount` * 100) AS INTEGER) WHERE `vat_amount` IS NOT NULL;--> statement-breakpoint
UPDATE `sales` SET `total` = CAST(ROUND(`total` * 100) AS INTEGER) WHERE `total` IS NOT NULL;--> statement-breakpoint
UPDATE `sale_items` SET `price_at_sale` = CAST(ROUND(`price_at_sale` * 100) AS INTEGER) WHERE `price_at_sale` IS NOT NULL;--> statement-breakpoint
UPDATE `sale_items` SET `cost_at_sale` = CAST(ROUND(`cost_at_sale` * 100) AS INTEGER) WHERE `cost_at_sale` IS NOT NULL;--> statement-breakpoint
UPDATE `refunds` SET `amount` = CAST(ROUND(`amount` * 100) AS INTEGER) WHERE `amount` IS NOT NULL;--> statement-breakpoint
UPDATE `credit_ledger` SET `delta` = CAST(ROUND(`delta` * 100) AS INTEGER) WHERE `delta` IS NOT NULL;--> statement-breakpoint
UPDATE `buy_transactions` SET `total` = CAST(ROUND(`total` * 100) AS INTEGER) WHERE `total` IS NOT NULL;--> statement-breakpoint
UPDATE `buy_items` SET `pay_price` = CAST(ROUND(`pay_price` * 100) AS INTEGER) WHERE `pay_price` IS NOT NULL;--> statement-breakpoint
UPDATE `settings` SET `high_value_threshold` = CAST(ROUND(`high_value_threshold` * 100) AS INTEGER) WHERE `high_value_threshold` IS NOT NULL;--> statement-breakpoint
UPDATE `settings` SET `vat_scheme` = 'none' WHERE `vat_scheme` IS NULL;