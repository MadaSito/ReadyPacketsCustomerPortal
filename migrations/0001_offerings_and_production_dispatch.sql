-- Increment 02: offerings matrix fields (packet number, tier, outcome, timeline, deliverables), order
-- subtotal / discount, and the production pipeline dispatch outbox (P101 / P201).
-- Existing rows are backfilled: deliverables = [], subtotal = total (no discount existed before).
CREATE TABLE `integration_production_dispatches` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`order_reference` varchar(64) NOT NULL,
	`expected_owner_user_id` bigint unsigned NOT NULL,
	`destination_fingerprint` char(64) NOT NULL,
	`job_public_id` varchar(36) NOT NULL,
	`active_fencing_token` bigint unsigned NOT NULL DEFAULT 0,
	`expires_at` datetime(3) NOT NULL,
	`phase` varchar(8) NOT NULL,
	`state` varchar(16) NOT NULL,
	`attempt_count` int unsigned NOT NULL DEFAULT 0,
	`idempotency_key` varchar(96) NOT NULL,
	`payload_sha256` char(64) NOT NULL,
	`payload_enc` text,
	`sent_customer_id` varchar(120) NOT NULL,
	`sent_order_id` varchar(120) NOT NULL,
	`sent_run_mode` varchar(32) NOT NULL,
	`packet` varchar(8),
	`tier` varchar(16),
	`bundle_scope_manifest` varchar(512),
	`release_status` varchar(120),
	`http_status` int unsigned,
	`response_summary` varchar(200),
	`last_reason_code` varchar(64),
	`is_resend` boolean NOT NULL DEFAULT false,
	`resend_reason` varchar(64),
	`phase1_artifacts_confirmed` boolean NOT NULL DEFAULT false,
	`requested_by_user_id` bigint unsigned,
	`requested_by_public_id` varchar(26),
	`correlation_id` varchar(64) NOT NULL,
	`delivered_at` datetime(3),
	`finalized_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `integration_production_dispatches_id` PRIMARY KEY(`id`),
	CONSTRAINT `integration_production_dispatches_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `uq_prod_dispatch_idempotency` UNIQUE(`idempotency_key`)
);
--> statement-breakpoint
ALTER TABLE `catalog_groups` ADD `group_key` varchar(64);--> statement-breakpoint
ALTER TABLE `catalog_groups` ADD `packet_number` tinyint unsigned;--> statement-breakpoint
ALTER TABLE `catalog_product_versions` ADD `outcome` varchar(1000) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `catalog_product_versions` ADD `timeline` varchar(120) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `catalog_product_versions` ADD `deliverables` json;--> statement-breakpoint
UPDATE `catalog_product_versions` SET `deliverables` = JSON_ARRAY() WHERE `deliverables` IS NULL;--> statement-breakpoint
ALTER TABLE `catalog_product_versions` MODIFY `deliverables` json NOT NULL;--> statement-breakpoint
ALTER TABLE `catalog_products` ADD `packet_number` tinyint unsigned;--> statement-breakpoint
ALTER TABLE `catalog_products` ADD `tier` enum('Basic','Standard','Premium');--> statement-breakpoint
ALTER TABLE `order_line_items` ADD `packet_number` tinyint unsigned;--> statement-breakpoint
ALTER TABLE `order_line_items` ADD `tier` enum('Basic','Standard','Premium');--> statement-breakpoint
ALTER TABLE `order_line_items` ADD `outcome` varchar(1000) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `order_line_items` ADD `timeline` varchar(120) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `order_line_items` ADD `deliverables` json;--> statement-breakpoint
UPDATE `order_line_items` SET `deliverables` = JSON_ARRAY() WHERE `deliverables` IS NULL;--> statement-breakpoint
ALTER TABLE `order_line_items` MODIFY `deliverables` json NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `subtotal_minor` bigint NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE `orders` SET `subtotal_minor` = `total_minor`;--> statement-breakpoint
ALTER TABLE `orders` ALTER COLUMN `subtotal_minor` DROP DEFAULT;--> statement-breakpoint
ALTER TABLE `orders` ADD `discount_minor` bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `discount_label` varchar(120);--> statement-breakpoint
ALTER TABLE `catalog_groups` ADD CONSTRAINT `catalog_groups_group_key_uq` UNIQUE(`group_key`);--> statement-breakpoint
ALTER TABLE `catalog_groups` ADD CONSTRAINT `catalog_groups_packet_number_uq` UNIQUE(`packet_number`);--> statement-breakpoint
ALTER TABLE `catalog_products` ADD CONSTRAINT `catalog_products_packet_tier_uq` UNIQUE(`packet_number`,`tier`);--> statement-breakpoint
CREATE INDEX `idx_prod_dispatch_order_phase` ON `integration_production_dispatches` (`order_id`,`phase`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_prod_dispatch_order_pub` ON `integration_production_dispatches` (`order_public_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_prod_dispatch_state_created` ON `integration_production_dispatches` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_prod_dispatch_state_updated` ON `integration_production_dispatches` (`state`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_prod_dispatch_state_expiry` ON `integration_production_dispatches` (`state`,`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_prod_dispatch_job` ON `integration_production_dispatches` (`job_public_id`);--> statement-breakpoint
CREATE INDEX `idx_prod_dispatch_order_ref` ON `integration_production_dispatches` (`order_reference`,`created_at`);