CREATE TABLE `platform_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor` text NOT NULL,
	`tenant_id` integer,
	`action` text NOT NULL,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stripe_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stripe_event_id` text NOT NULL,
	`type` text NOT NULL,
	`processed_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_events_event_id_unique` ON `stripe_events` (`stripe_event_id`);--> statement-breakpoint
CREATE TABLE `tenant_sync_state` (
	`tenant_id` integer PRIMARY KEY NOT NULL,
	`last_price_sync_at` integer,
	`last_catalogue_sync_at` integer,
	`last_backup_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'trialing' NOT NULL,
	`plan` text DEFAULT 'growth' NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`turso_db_name` text,
	`db_url` text NOT NULL,
	`region` text DEFAULT 'fra' NOT NULL,
	`setup_token` text,
	`setup_completed_at` integer,
	`entitlement_overrides` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_unique` ON `tenants` (`slug`);