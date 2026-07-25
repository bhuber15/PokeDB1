CREATE INDEX `idx_buy_items_buy_id` ON `buy_items` (`buy_id`);--> statement-breakpoint
CREATE INDEX `idx_credit_ledger_customer_id` ON `credit_ledger` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_inventory_items_card_id` ON `inventory_items` (`card_id`);--> statement-breakpoint
CREATE INDEX `idx_refund_items_sale_item_id` ON `refund_items` (`sale_item_id`);--> statement-breakpoint
CREATE INDEX `idx_refunds_sale_id` ON `refunds` (`sale_id`);--> statement-breakpoint
CREATE INDEX `idx_sale_items_sale_id` ON `sale_items` (`sale_id`);--> statement-breakpoint
CREATE INDEX `idx_sale_items_inventory_item_id` ON `sale_items` (`inventory_item_id`);--> statement-breakpoint
CREATE INDEX `idx_sale_payments_sale_id` ON `sale_payments` (`sale_id`);--> statement-breakpoint
CREATE INDEX `idx_sales_created_at` ON `sales` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_sales_customer_id` ON `sales` (`customer_id`);