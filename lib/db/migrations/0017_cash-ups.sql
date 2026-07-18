CREATE TABLE `cash_ups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`staff_id` integer,
	`opening_float` integer NOT NULL,
	`cash_sales` integer NOT NULL,
	`cash_refunds` integer NOT NULL,
	`cash_buy_payouts` integer NOT NULL,
	`expected_cash` integer NOT NULL,
	`counted_cash` integer NOT NULL,
	`variance` integer NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_ups_day_unique` ON `cash_ups` (`day`);