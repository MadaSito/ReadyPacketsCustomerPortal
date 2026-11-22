CREATE TABLE `order_name_history` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`old_name` varchar(160) NOT NULL,
	`new_name` varchar(160) NOT NULL,
	`actor_user_id` bigint unsigned,
	`actor_role` varchar(16) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `order_name_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `order_policy_acceptances` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`gate_key` varchar(64) NOT NULL,
	`workflow_version_id` bigint unsigned NOT NULL,
	`policy_document_id` bigint unsigned NOT NULL,
	`policy_version_id` bigint unsigned NOT NULL,
	`policy_public_id` char(26) NOT NULL,
	`policy_version_number` int unsigned NOT NULL,
	`text_sha256` char(64) NOT NULL,
	`signature_mode` enum('checkbox','typed_name') NOT NULL,
	`typed_name_enc` text,
	`accepted_at` datetime(3) NOT NULL,
	`source_address_enc` text,
	`user_agent` varchar(512),
	`request_id` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_policy_acceptances_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_policy_acceptances_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cmp_ord_acc_once_uq` UNIQUE(`order_id`,`user_id`,`policy_version_id`,`gate_key`,`workflow_version_id`)
);
--> statement-breakpoint
CREATE TABLE `payment_refunds` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`invoice_id` bigint unsigned NOT NULL,
	`invoice_public_id` char(26) NOT NULL,
	`compliance_payment_id` bigint unsigned NOT NULL,
	`compliance_payment_public_id` char(26) NOT NULL,
	`attempt_id` bigint unsigned,
	`provider` enum('stripe','square') NOT NULL,
	`environment` enum('test','live') NOT NULL,
	`provider_payment_ref` varchar(128) NOT NULL,
	`provider_refund_ref` varchar(128),
	`status` enum('pending','succeeded','failed','unknown') NOT NULL DEFAULT 'pending',
	`amount_minor` bigint NOT NULL,
	`currency` char(3) NOT NULL,
	`reason_code` varchar(64) NOT NULL,
	`reason_enc` text NOT NULL,
	`send_customer_notice` boolean NOT NULL DEFAULT false,
	`customer_notice_sent_at` datetime(3),
	`compliance_refund_public_id` char(26),
	`idempotency_key` varchar(128) NOT NULL,
	`provider_idempotency_key` varchar(64) NOT NULL,
	`failure_reason_code` varchar(64),
	`requested_by_user_id` bigint unsigned NOT NULL,
	`verified_webhook_event_id` varchar(128),
	`reconcile_job_id` varchar(64),
	`settled_at` datetime(3),
	`last_reconciled_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payment_refunds_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_refunds_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `pmt_rfd_pmt_idem_uq` UNIQUE(`compliance_payment_id`,`idempotency_key`),
	CONSTRAINT `pmt_rfd_prov_idem_uq` UNIQUE(`provider_idempotency_key`),
	CONSTRAINT `pmt_rfd_prov_ref_uq` UNIQUE(`provider`,`provider_refund_ref`)
);
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `order_public_id` varchar(64);--> statement-breakpoint
ALTER TABLE `integration_production_dispatches` ADD `retry_of_public_id` varchar(26);--> statement-breakpoint
ALTER TABLE `integration_production_dispatches` ADD `redelivery_of_public_id` varchar(26);--> statement-breakpoint
ALTER TABLE `storage_copy_attempts` ADD `order_public_id` char(26);--> statement-breakpoint
ALTER TABLE `storage_copy_attempts` ADD `target_path_enc` text;--> statement-breakpoint
ALTER TABLE `storage_copy_attempts` ADD `phase_label_enc` text;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `order_public_id` char(26);--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `stage_step_key` varchar(48);--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `triggered_by_user_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `payment_webhook_events` ADD `refund_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `payment_webhook_events` ADD `refund_public_id` char(26);--> statement-breakpoint
ALTER TABLE `payment_webhook_events` ADD `provider_refund_ref` varchar(128);--> statement-breakpoint
ALTER TABLE `order_name_history` ADD CONSTRAINT `order_name_history_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_policy_acceptances` ADD CONSTRAINT `cmp_ord_acc_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_refunds` ADD CONSTRAINT `pmt_rfd_att_fk` FOREIGN KEY (`attempt_id`) REFERENCES `payment_attempts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_refunds` ADD CONSTRAINT `pmt_rfd_req_user_fk` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `order_name_history_order_idx` ON `order_name_history` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `cmp_ord_acc_order_idx` ON `order_policy_acceptances` (`order_id`,`accepted_at`);--> statement-breakpoint
CREATE INDEX `cmp_ord_acc_user_idx` ON `order_policy_acceptances` (`user_id`);--> statement-breakpoint
CREATE INDEX `pmt_rfd_ord_pub_idx` ON `payment_refunds` (`order_public_id`,`id`);--> statement-breakpoint
CREATE INDEX `pmt_rfd_inv_id_idx` ON `payment_refunds` (`invoice_id`,`id`);--> statement-breakpoint
CREATE INDEX `pmt_rfd_cmp_pmt_idx` ON `payment_refunds` (`compliance_payment_id`,`status`);--> statement-breakpoint
CREATE INDEX `pmt_rfd_st_upd_idx` ON `payment_refunds` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `pmt_rfd_prov_pmt_idx` ON `payment_refunds` (`provider`,`provider_payment_ref`);--> statement-breakpoint
CREATE INDEX `ix_audit_order_time` ON `audit_events` (`order_public_id`,`occurred_at`,`event_id`);--> statement-breakpoint
CREATE INDEX `idx_prod_dispatch_redelivery_of` ON `integration_production_dispatches` (`redelivery_of_public_id`);--> statement-breakpoint
CREATE INDEX `storage_copy_attempt_order_idx` ON `storage_copy_attempts` (`order_public_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `automation_runs_order_queued_idx` ON `automation_runs` (`order_public_id`,`queued_at`,`id`);--> statement-breakpoint
CREATE INDEX `pmt_wh_rfd_idx` ON `payment_webhook_events` (`refund_id`);