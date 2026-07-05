ALTER TABLE `sales` ADD `client_uuid` text;--> statement-breakpoint
CREATE UNIQUE INDEX `sales_client_uuid_unique` ON `sales` (`client_uuid`);