ALTER TABLE `sales` ADD `voided_at` text;--> statement-breakpoint
ALTER TABLE `sales` ADD `voided_by_staff_id` integer REFERENCES staff(id);--> statement-breakpoint
ALTER TABLE `sales` ADD `void_reason` text;