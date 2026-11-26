CREATE TABLE `customer_billing_profiles` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`details_enc` text NOT NULL,
	`country` char(2) NOT NULL,
	`region` varchar(64),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `customer_billing_profiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `customer_billing_profiles_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cust_billing_prof_user_uq` UNIQUE(`user_id`)
);
--> statement-breakpoint
ALTER TABLE `order_reference_counters` MODIFY COLUMN `scope` varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `first_name_enc` text;--> statement-breakpoint
ALTER TABLE `users` ADD `last_name_enc` text;--> statement-breakpoint
ALTER TABLE `users` ADD `preferred_name_enc` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `group_root_order_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `orders` ADD `reference_stem` varchar(32);--> statement-breakpoint
ALTER TABLE `carts` ADD `add_to_order_public_id` char(26);--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD `booking_source` enum('webhook','provider_lookup');--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD `last_customer_lookup_at` datetime(3);--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD `missing_webhook_alerted_at` datetime(3);--> statement-breakpoint
ALTER TABLE `customer_billing_profiles` ADD CONSTRAINT `cust_billing_prof_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `orders_group_root_idx` ON `orders` (`group_root_order_id`,`id`);--> statement-breakpoint
CREATE INDEX `pmt_att_bk_wh_idx` ON `payment_attempts` (`provider`,`environment`,`booking_source`,`paid_at`);