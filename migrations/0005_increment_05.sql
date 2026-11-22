CREATE TABLE `order_workflow_imports` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`actor_user_id` bigint unsigned NOT NULL,
	`idempotency_key` varchar(80) NOT NULL,
	`digest` char(64) NOT NULL,
	`request_hash` char(64) NOT NULL,
	`source_label` varchar(120),
	`outcome` json NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_workflow_imports_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_workflow_imports_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_workflow_imports_idem_uq` UNIQUE(`actor_user_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `cart_upsell_acceptances` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`cart_id` bigint unsigned NOT NULL,
	`offer_id` bigint unsigned,
	`offer_key` varchar(64) NOT NULL,
	`idempotency_key` varchar(128) NOT NULL,
	`added_product_public_ids` json NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `cart_upsell_acceptances_id` PRIMARY KEY(`id`),
	CONSTRAINT `cart_upsell_acc_cart_idem_uq` UNIQUE(`cart_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `cart_upsell_cart_states` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`cart_id` bigint unsigned NOT NULL,
	`offer_id` bigint unsigned,
	`offer_key` varchar(64) NOT NULL,
	`first_shown_at` datetime(3),
	`dismissed_at` datetime(3),
	`accepted_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `cart_upsell_cart_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `cart_upsell_state_cart_key_uq` UNIQUE(`cart_id`,`offer_key`)
);
--> statement-breakpoint
CREATE TABLE `cart_upsell_offers` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`kind` enum('add_on','tier_upgrade') NOT NULL,
	`title` varchar(120) NOT NULL,
	`short_text` varchar(200) NOT NULL,
	`trigger_mode` enum('any_cart','products') NOT NULL DEFAULT 'products',
	`trigger_product_public_ids` json NOT NULL,
	`target_product_public_id` char(26) NOT NULL,
	`priority` int NOT NULL DEFAULT 100,
	`active` boolean NOT NULL DEFAULT true,
	`starts_at` datetime(3),
	`ends_at` datetime(3),
	`shown_count` int unsigned NOT NULL DEFAULT 0,
	`accepted_count` int unsigned NOT NULL DEFAULT 0,
	`dismissed_count` int unsigned NOT NULL DEFAULT 0,
	`created_by_user_id` bigint unsigned,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `cart_upsell_offers_id` PRIMARY KEY(`id`),
	CONSTRAINT `cart_upsell_offers_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `promo_batches` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`name` varchar(120) NOT NULL,
	`label` varchar(120) NOT NULL,
	`discount_type` enum('percent','fixed') NOT NULL,
	`percent_bps` int unsigned,
	`max_discount_minor` bigint,
	`fixed_amount_minor` bigint,
	`currency` char(3),
	`scope_kind` enum('all','products','tiers','packets') NOT NULL DEFAULT 'all',
	`scope_product_public_ids` json NOT NULL,
	`scope_tier_keys` json NOT NULL,
	`scope_packet_numbers` json NOT NULL,
	`min_subtotal_minor` bigint NOT NULL DEFAULT 0,
	`starts_at` datetime(3),
	`ends_at` datetime(3),
	`max_redemptions` int unsigned,
	`max_per_customer` int unsigned NOT NULL DEFAULT 1,
	`first_order_only` boolean NOT NULL DEFAULT false,
	`allow_customer_public_ids` json NOT NULL,
	`allow_email_domains` json NOT NULL,
	`combine_with_bundle` boolean NOT NULL DEFAULT false,
	`status` enum('active','paused','revoked') NOT NULL DEFAULT 'active',
	`is_batch` boolean NOT NULL DEFAULT false,
	`code_prefix` varchar(16),
	`batch_size` int unsigned NOT NULL DEFAULT 0,
	`redemption_count` int unsigned NOT NULL DEFAULT 0,
	`note` varchar(500),
	`created_by_user_id` bigint unsigned NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `promo_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `promo_batches_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `promo_check_attempts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`failed_count` int unsigned NOT NULL DEFAULT 0,
	`window_started_at` datetime(3) NOT NULL,
	`blocked_until` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `promo_check_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `promo_check_attempts_user_uq` UNIQUE(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `promo_codes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`batch_id` bigint unsigned NOT NULL,
	`code_index` char(64) NOT NULL,
	`code_enc` text NOT NULL,
	`max_uses` int unsigned,
	`redemption_count` int unsigned NOT NULL DEFAULT 0,
	`status` enum('active','paused','revoked') NOT NULL DEFAULT 'active',
	`generation_key` varchar(80),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `promo_codes_id` PRIMARY KEY(`id`),
	CONSTRAINT `promo_codes_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `promo_codes_code_index_uq` UNIQUE(`code_index`)
);
--> statement-breakpoint
CREATE TABLE `promo_redemptions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`batch_id` bigint unsigned NOT NULL,
	`promo_code_id` bigint unsigned NOT NULL,
	`customer_user_id` bigint unsigned NOT NULL,
	`actor_user_id` bigint unsigned NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`status` enum('redeemed','released') NOT NULL DEFAULT 'redeemed',
	`customer_sequence` int unsigned NOT NULL,
	`active_code_sequence` int unsigned,
	`active_batch_sequence` int unsigned,
	`active_code_slot` int unsigned,
	`currency` char(3) NOT NULL,
	`subtotal_minor` bigint NOT NULL,
	`promo_discount_minor` bigint NOT NULL,
	`bundle_discount_minor` bigint NOT NULL,
	`discount_minor` bigint NOT NULL,
	`total_minor` bigint NOT NULL,
	`label_snapshot` varchar(120) NOT NULL,
	`correlation_id` varchar(64) NOT NULL,
	`released_at` datetime(3),
	`release_reason` varchar(48),
	`release_note` varchar(240),
	`released_by_user_id` bigint unsigned,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `promo_redemptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `promo_redemptions_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `promo_redemptions_order_uq` UNIQUE(`order_public_id`),
	CONSTRAINT `promo_redemptions_code_order_uq` UNIQUE(`promo_code_id`,`order_public_id`),
	CONSTRAINT `promo_redemptions_code_cust_seq_uq` UNIQUE(`promo_code_id`,`customer_user_id`,`active_code_sequence`),
	CONSTRAINT `promo_redemptions_batch_cust_seq_uq` UNIQUE(`batch_id`,`customer_user_id`,`active_batch_sequence`),
	CONSTRAINT `promo_redemptions_code_slot_uq` UNIQUE(`promo_code_id`,`active_code_slot`)
);
--> statement-breakpoint
ALTER TABLE `orders` ADD `promo_discount_minor` bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `promo_label` varchar(120);--> statement-breakpoint
ALTER TABLE `policy_acceptances` ADD `context` enum('registration','portal','checkout');--> statement-breakpoint
ALTER TABLE `carts` ADD `applied_promo_code_enc` text;--> statement-breakpoint
ALTER TABLE `carts` ADD `applied_promo_public_id` char(26);--> statement-breakpoint
ALTER TABLE `carts` ADD `applied_promo_label` varchar(120);--> statement-breakpoint
ALTER TABLE `carts` ADD `applied_promo_idempotency_key` varchar(128);--> statement-breakpoint
ALTER TABLE `carts` ADD `checked_out_promo_discount_minor` bigint;--> statement-breakpoint
ALTER TABLE `carts` ADD `checked_out_promo_label` varchar(120);--> statement-breakpoint
ALTER TABLE `order_workflow_imports` ADD CONSTRAINT `order_workflow_imports_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cart_upsell_acceptances` ADD CONSTRAINT `cart_upsell_acc_cart_fk` FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cart_upsell_acceptances` ADD CONSTRAINT `cart_upsell_acc_offer_fk` FOREIGN KEY (`offer_id`) REFERENCES `cart_upsell_offers`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cart_upsell_cart_states` ADD CONSTRAINT `cart_upsell_state_cart_fk` FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cart_upsell_cart_states` ADD CONSTRAINT `cart_upsell_state_offer_fk` FOREIGN KEY (`offer_id`) REFERENCES `cart_upsell_offers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cart_upsell_offers` ADD CONSTRAINT `cart_upsell_offer_creator_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `promo_batches` ADD CONSTRAINT `promo_batches_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `promo_check_attempts` ADD CONSTRAINT `promo_check_attempts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `promo_codes` ADD CONSTRAINT `promo_codes_batch_id_promo_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `promo_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `promo_redemptions` ADD CONSTRAINT `promo_redemptions_batch_id_promo_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `promo_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `promo_redemptions` ADD CONSTRAINT `promo_redemptions_promo_code_id_promo_codes_id_fk` FOREIGN KEY (`promo_code_id`) REFERENCES `promo_codes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `promo_redemptions` ADD CONSTRAINT `promo_redemptions_customer_user_id_users_id_fk` FOREIGN KEY (`customer_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `promo_redemptions` ADD CONSTRAINT `promo_redemptions_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `promo_redemptions` ADD CONSTRAINT `promo_redemptions_released_by_user_id_users_id_fk` FOREIGN KEY (`released_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `cart_upsell_acc_offer_idx` ON `cart_upsell_acceptances` (`offer_id`);--> statement-breakpoint
CREATE INDEX `cart_upsell_state_offer_idx` ON `cart_upsell_cart_states` (`offer_id`);--> statement-breakpoint
CREATE INDEX `cart_upsell_offer_active_prio_idx` ON `cart_upsell_offers` (`active`,`priority`,`id`);--> statement-breakpoint
CREATE INDEX `cart_upsell_offer_target_idx` ON `cart_upsell_offers` (`target_product_public_id`);--> statement-breakpoint
CREATE INDEX `promo_batches_status_id_idx` ON `promo_batches` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `promo_batches_ends_at_idx` ON `promo_batches` (`ends_at`,`id`);--> statement-breakpoint
CREATE INDEX `promo_batches_type_id_idx` ON `promo_batches` (`discount_type`,`id`);--> statement-breakpoint
CREATE INDEX `promo_batches_created_by_idx` ON `promo_batches` (`created_by_user_id`);--> statement-breakpoint
CREATE INDEX `promo_check_attempts_blocked_idx` ON `promo_check_attempts` (`blocked_until`);--> statement-breakpoint
CREATE INDEX `promo_codes_batch_id_idx` ON `promo_codes` (`batch_id`,`id`);--> statement-breakpoint
CREATE INDEX `promo_codes_batch_gen_idx` ON `promo_codes` (`batch_id`,`generation_key`);--> statement-breakpoint
CREATE INDEX `promo_redemptions_batch_id_idx` ON `promo_redemptions` (`batch_id`,`id`);--> statement-breakpoint
CREATE INDEX `promo_redemptions_customer_idx` ON `promo_redemptions` (`customer_user_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `promo_redemptions_status_curr_idx` ON `promo_redemptions` (`status`,`currency`);--> statement-breakpoint
CREATE INDEX `cmp_pol_acc_accepted_pub_idx` ON `policy_acceptances` (`accepted_at`,`public_id`);--> statement-breakpoint
CREATE INDEX `cmp_pol_ver_st_pub_idx` ON `policy_versions` (`status`,`published_at`);--> statement-breakpoint
CREATE INDEX `cmp_ord_acc_time_idx` ON `order_policy_acceptances` (`accepted_at`,`public_id`);