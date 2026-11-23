CREATE TABLE `order_task_notes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`workflow_version_id` bigint unsigned NOT NULL,
	`status_key` varchar(48) NOT NULL,
	`ack_key` varchar(48) NOT NULL,
	`body_enc` text NOT NULL,
	`text_sha256` char(64) NOT NULL,
	`author_user_id` bigint unsigned NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_task_notes_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_task_notes_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_task_notes_task_uq` UNIQUE(`order_id`,`workflow_version_id`,`status_key`,`ack_key`)
);
--> statement-breakpoint
CREATE TABLE `order_task_waivers` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`workflow_version_id` bigint unsigned NOT NULL,
	`status_key` varchar(48) NOT NULL,
	`task_key` varchar(48) NOT NULL,
	`task_kind` enum('upload','record','acknowledge','respond_document') NOT NULL,
	`reason_note_public_id` varchar(26) NOT NULL,
	`waived_by_user_id` bigint unsigned NOT NULL,
	`waived_at` datetime(3) NOT NULL,
	CONSTRAINT `order_task_waivers_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_task_waivers_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_task_waivers_task_uq` UNIQUE(`order_id`,`workflow_version_id`,`status_key`,`task_key`)
);
--> statement-breakpoint
CREATE TABLE `compliance_payment_receipts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`receipt_number` varchar(32) NOT NULL,
	`sequence_number` int unsigned NOT NULL,
	`settlement_key` varchar(96) NOT NULL,
	`settlement_kind` enum('provider_online','manual_payment','waived_small_total','zero_total') NOT NULL,
	`invoice_id` bigint unsigned NOT NULL,
	`invoice_public_id` char(26) NOT NULL,
	`payment_id` bigint unsigned,
	`payment_public_id` char(26),
	`order_id` bigint unsigned NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`order_reference` varchar(48) NOT NULL,
	`customer_user_id` bigint unsigned NOT NULL,
	`customer_ref_snapshot` varchar(32),
	`currency` char(3) NOT NULL,
	`subtotal_minor` bigint NOT NULL,
	`discount_minor` bigint NOT NULL DEFAULT 0,
	`bundle_discount_minor` bigint NOT NULL DEFAULT 0,
	`promo_discount_minor` bigint NOT NULL DEFAULT 0,
	`promo_label_snapshot` varchar(160),
	`tax_minor` bigint NOT NULL DEFAULT 0,
	`amount_waived_minor` bigint NOT NULL DEFAULT 0,
	`amount_paid_minor` bigint NOT NULL,
	`refunded_minor` bigint NOT NULL DEFAULT 0,
	`refund_state` enum('none','partially_refunded','refunded') NOT NULL DEFAULT 'none',
	`payment_method` enum('bank_transfer','wire','ach','check','card_manual','waiver','provider_online','imported_historical','other') NOT NULL,
	`payment_method_brand` varchar(32),
	`payment_method_last4` varchar(4),
	`provider` varchar(32),
	`provider_reference` varchar(128),
	`issued_at` datetime(3) NOT NULL,
	`emailed_at` datetime(3),
	`last_resent_at` datetime(3),
	`resend_count` int unsigned NOT NULL DEFAULT 0,
	`snapshot_enc` mediumtext NOT NULL,
	`pdf_enc` mediumtext NOT NULL,
	`pdf_sha256` char(64) NOT NULL,
	`pdf_byte_size` int unsigned NOT NULL,
	`origin` enum('portal','import') NOT NULL DEFAULT 'portal',
	`import_id` varchar(64),
	`source_installation_id` varchar(128),
	`source_public_id` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `compliance_payment_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `compliance_payment_receipts_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cmp_rcpt_number_uq` UNIQUE(`receipt_number`),
	CONSTRAINT `cmp_rcpt_settle_uq` UNIQUE(`settlement_key`),
	CONSTRAINT `cmp_rcpt_pmt_uq` UNIQUE(`payment_id`),
	CONSTRAINT `cmp_rcpt_imp_uq` UNIQUE(`source_installation_id`,`source_public_id`)
);
--> statement-breakpoint
CREATE TABLE `compliance_receipt_refund_notes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`note_number` varchar(32) NOT NULL,
	`sequence_number` int unsigned NOT NULL,
	`receipt_id` bigint unsigned NOT NULL,
	`receipt_public_id` char(26) NOT NULL,
	`refund_id` bigint unsigned NOT NULL,
	`refund_public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`customer_user_id` bigint unsigned NOT NULL,
	`currency` char(3) NOT NULL,
	`refund_amount_minor` bigint NOT NULL,
	`cumulative_refunded_minor` bigint NOT NULL,
	`resulting_refund_state` enum('partially_refunded','refunded') NOT NULL,
	`reason_code` varchar(64) NOT NULL,
	`reference` varchar(128) NOT NULL,
	`issued_at` datetime(3) NOT NULL,
	`snapshot_enc` mediumtext NOT NULL,
	`pdf_enc` mediumtext NOT NULL,
	`pdf_sha256` char(64) NOT NULL,
	`pdf_byte_size` int unsigned NOT NULL,
	`origin` enum('portal','import') NOT NULL DEFAULT 'portal',
	`import_id` varchar(64),
	`source_installation_id` varchar(128),
	`source_public_id` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `compliance_receipt_refund_notes_id` PRIMARY KEY(`id`),
	CONSTRAINT `compliance_receipt_refund_notes_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cmp_rrn_number_uq` UNIQUE(`note_number`),
	CONSTRAINT `cmp_rrn_rfd_uq` UNIQUE(`refund_id`),
	CONSTRAINT `cmp_rrn_imp_uq` UNIQUE(`source_installation_id`,`source_public_id`)
);
--> statement-breakpoint
CREATE TABLE `policy_notice_preferences` (
	`document_id` bigint unsigned NOT NULL,
	`delay_hours` int unsigned NOT NULL DEFAULT 24,
	`version` int unsigned NOT NULL DEFAULT 1,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `policy_notice_preferences_document_id` PRIMARY KEY(`document_id`)
);
--> statement-breakpoint
CREATE TABLE `policy_notice_recipients` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`notice_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`delivery_round` int unsigned NOT NULL DEFAULT 0,
	`reminder_public_id` char(26),
	`mail_state` enum('queued','sent','failed') NOT NULL DEFAULT 'queued',
	`next_mail_check_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `policy_notice_recipients_id` PRIMARY KEY(`id`),
	CONSTRAINT `cmp_notice_recipient_round_uq` UNIQUE(`notice_id`,`delivery_round`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `policy_notices` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`policy_version_id` bigint unsigned NOT NULL,
	`scheduled_at` datetime(3) NOT NULL,
	`state` enum('scheduled','dispatching','completed','cancelled') NOT NULL DEFAULT 'scheduled',
	`revision` int unsigned NOT NULL DEFAULT 1,
	`reminder_public_id` char(26),
	`last_reminder_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `policy_notices_id` PRIMARY KEY(`id`),
	CONSTRAINT `policy_notices_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cmp_notice_policy_ver_uq` UNIQUE(`policy_version_id`)
);
--> statement-breakpoint
CREATE TABLE `policy_enforcement_actions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`policy_version_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`enforcement_version` int unsigned NOT NULL,
	`reason` enum('declined','deadline','admin') NOT NULL,
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `policy_enforcement_actions_id` PRIMARY KEY(`id`),
	CONSTRAINT `cmp_enforce_user_version_uq` UNIQUE(`policy_version_id`,`enforcement_version`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `policy_enforcement_preferences` (
	`document_id` bigint unsigned NOT NULL,
	`mode` enum('none','required_to_continue') NOT NULL DEFAULT 'none',
	`grace_hours` int unsigned NOT NULL DEFAULT 24,
	`warning_text` varchar(1000),
	`enabled_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `policy_enforcement_preferences_document_id` PRIMARY KEY(`document_id`)
);
--> statement-breakpoint
CREATE TABLE `security_correlation_state` (
	`id` tinyint unsigned NOT NULL,
	`last_run_at` datetime(3),
	`last_run_events` int unsigned NOT NULL DEFAULT 0,
	`last_run_findings` int unsigned NOT NULL DEFAULT 0,
	`last_run_truncated` boolean NOT NULL DEFAULT false,
	`last_run_reason` varchar(64),
	CONSTRAINT `security_correlation_state_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `security_incident_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`incident_id` bigint unsigned NOT NULL,
	`event_id` char(26) NOT NULL,
	`event_name` varchar(96) NOT NULL,
	`occurred_at` datetime(3) NOT NULL,
	`added_at` datetime(3) NOT NULL,
	CONSTRAINT `security_incident_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `ux_sec_inc_event` UNIQUE(`incident_id`,`event_id`)
);
--> statement-breakpoint
CREATE TABLE `security_incident_timeline` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`incident_id` bigint unsigned NOT NULL,
	`at` datetime(3) NOT NULL,
	`kind` varchar(24) NOT NULL,
	`actor_user_id` bigint unsigned,
	`detail` json NOT NULL,
	CONSTRAINT `security_incident_timeline_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `security_incidents` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`rule_key` varchar(40) NOT NULL,
	`severity` varchar(8) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'open',
	`dedupe_key` char(64) NOT NULL,
	`subject_kind` varchar(12) NOT NULL,
	`subject_ref` varchar(64),
	`user_public_id` varchar(64),
	`address_event_id` char(26),
	`first_event_at` datetime(3) NOT NULL,
	`last_event_at` datetime(3) NOT NULL,
	`event_count` int unsigned NOT NULL DEFAULT 0,
	`account_count` int unsigned NOT NULL DEFAULT 0,
	`address_count` int unsigned NOT NULL DEFAULT 0,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`acknowledged_at` datetime(3),
	`acknowledged_by` bigint unsigned,
	`closed_at` datetime(3),
	`closed_by` bigint unsigned,
	`close_reason` varchar(24),
	CONSTRAINT `security_incidents_id` PRIMARY KEY(`id`),
	CONSTRAINT `security_incidents_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `protection_signin_bans` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`address_key` char(64) NOT NULL,
	`address_enc` text NOT NULL,
	`source` enum('automatic','manual') NOT NULL,
	`reason` varchar(240) NOT NULL,
	`strikes` int unsigned NOT NULL DEFAULT 0,
	`expires_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `protection_signin_bans_id` PRIMARY KEY(`id`),
	CONSTRAINT `protection_signin_bans_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `protection_signin_bans_public_uidx` UNIQUE(`public_id`),
	CONSTRAINT `protection_signin_bans_address_uidx` UNIQUE(`address_key`)
);
--> statement-breakpoint
CREATE TABLE `protection_signin_strikes` (
	`slot` int unsigned NOT NULL,
	`address_key` char(64) NOT NULL,
	`failures` json NOT NULL,
	`ban_count` int unsigned NOT NULL DEFAULT 0,
	`last_ban_at` datetime(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `protection_signin_strikes_slot` PRIMARY KEY(`slot`)
);
--> statement-breakpoint
CREATE TABLE `report_definitions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` varchar(500) NOT NULL DEFAULT '',
	`dataset` varchar(64) NOT NULL,
	`spec` json NOT NULL,
	`spec_hash` char(64) NOT NULL,
	`visibility` enum('private','shared') NOT NULL DEFAULT 'private',
	`owner_user_id` bigint unsigned NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `report_definitions_id` PRIMARY KEY(`id`),
	CONSTRAINT `report_definitions_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `report_runs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`active_user_id` bigint unsigned,
	`kind` enum('builtin','custom','export') NOT NULL,
	`report_key` varchar(64) NOT NULL,
	`definition_id` bigint unsigned,
	`spec_hash` char(64) NOT NULL,
	`state` enum('running','completed','failed','timed_out') NOT NULL DEFAULT 'running',
	`row_count` int unsigned,
	`lease_until` datetime(3) NOT NULL,
	`started_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	CONSTRAINT `report_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `report_runs_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `report_runs_active_user_uq` UNIQUE(`active_user_id`)
);
--> statement-breakpoint
ALTER TABLE `promo_batches` MODIFY COLUMN `discount_type` enum('percent','fixed','set_total') NOT NULL;--> statement-breakpoint
ALTER TABLE `compliance_invoice_payments` ADD `waived_minor` bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `compliance_invoice_payments` ADD `payment_method_brand` varchar(32);--> statement-breakpoint
ALTER TABLE `compliance_invoice_payments` ADD `payment_method_last4` varchar(4);--> statement-breakpoint
ALTER TABLE `policy_acceptances` ADD `signer_name_match` enum('exact','first_last','mismatch_warn','skipped_off');--> statement-breakpoint
ALTER TABLE `order_policy_acceptances` ADD `typed_name_match` enum('exact','first_last','mismatch_warn','skipped_off');--> statement-breakpoint
ALTER TABLE `cart_upsell_offers` ADD `seed_key` varchar(96);--> statement-breakpoint
ALTER TABLE `cart_upsell_offers` ADD `rule_type` varchar(32) DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `carts` ADD `checked_out_waived_minor` bigint;--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD `payment_method_brand` varchar(32);--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD `payment_method_last4` varchar(4);--> statement-breakpoint
ALTER TABLE `promo_batches` ADD `set_total_minor` bigint;--> statement-breakpoint
ALTER TABLE `http_rate_limit_counters` ADD `backoff_level` int unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `http_rate_limit_counters` ADD `last_exceeded_at` datetime(3);--> statement-breakpoint
ALTER TABLE `cart_upsell_offers` ADD CONSTRAINT `cart_upsell_offer_seed_key_uq` UNIQUE(`seed_key`);--> statement-breakpoint
ALTER TABLE `order_task_notes` ADD CONSTRAINT `order_task_notes_author_user_id_users_id_fk` FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_task_waivers` ADD CONSTRAINT `order_task_waivers_waived_by_user_id_users_id_fk` FOREIGN KEY (`waived_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_payment_receipts` ADD CONSTRAINT `cmp_rcpt_inv_fk` FOREIGN KEY (`invoice_id`) REFERENCES `compliance_invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_payment_receipts` ADD CONSTRAINT `cmp_rcpt_pmt_fk` FOREIGN KEY (`payment_id`) REFERENCES `compliance_invoice_payments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_payment_receipts` ADD CONSTRAINT `cmp_rcpt_cust_fk` FOREIGN KEY (`customer_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_receipt_refund_notes` ADD CONSTRAINT `cmp_rrn_rcpt_fk` FOREIGN KEY (`receipt_id`) REFERENCES `compliance_payment_receipts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_receipt_refund_notes` ADD CONSTRAINT `cmp_rrn_rfd_fk` FOREIGN KEY (`refund_id`) REFERENCES `compliance_invoice_refunds`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_receipt_refund_notes` ADD CONSTRAINT `cmp_rrn_cust_fk` FOREIGN KEY (`customer_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policy_notice_preferences` ADD CONSTRAINT `cmp_notice_preference_document_fk` FOREIGN KEY (`document_id`) REFERENCES `policy_documents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policy_notice_recipients` ADD CONSTRAINT `cmp_notice_recipient_notice_fk` FOREIGN KEY (`notice_id`) REFERENCES `policy_notices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policy_notice_recipients` ADD CONSTRAINT `cmp_notice_recipient_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policy_notices` ADD CONSTRAINT `cmp_notice_version_fk` FOREIGN KEY (`policy_version_id`) REFERENCES `policy_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policy_enforcement_actions` ADD CONSTRAINT `cmp_enforce_action_version_fk` FOREIGN KEY (`policy_version_id`) REFERENCES `policy_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policy_enforcement_actions` ADD CONSTRAINT `cmp_enforce_action_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policy_enforcement_preferences` ADD CONSTRAINT `cmp_enforce_preference_document_fk` FOREIGN KEY (`document_id`) REFERENCES `policy_documents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `order_task_waivers_order_idx` ON `order_task_waivers` (`order_id`);--> statement-breakpoint
CREATE INDEX `cmp_rcpt_cust_issued_idx` ON `compliance_payment_receipts` (`customer_user_id`,`issued_at`,`id`);--> statement-breakpoint
CREATE INDEX `cmp_rcpt_ord_pub_idx` ON `compliance_payment_receipts` (`order_public_id`,`issued_at`);--> statement-breakpoint
CREATE INDEX `cmp_rcpt_inv_idx` ON `compliance_payment_receipts` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `cmp_rcpt_issued_idx` ON `compliance_payment_receipts` (`issued_at`,`id`);--> statement-breakpoint
CREATE INDEX `cmp_rrn_rcpt_idx` ON `compliance_receipt_refund_notes` (`receipt_id`,`issued_at`);--> statement-breakpoint
CREATE INDEX `cmp_rrn_ord_pub_idx` ON `compliance_receipt_refund_notes` (`order_public_id`,`issued_at`);--> statement-breakpoint
CREATE INDEX `cmp_rrn_cust_idx` ON `compliance_receipt_refund_notes` (`customer_user_id`,`issued_at`);--> statement-breakpoint
CREATE INDEX `cmp_notice_recipient_progress_idx` ON `policy_notice_recipients` (`notice_id`,`delivery_round`,`mail_state`);--> statement-breakpoint
CREATE INDEX `cmp_notice_recipient_mail_check_idx` ON `policy_notice_recipients` (`mail_state`,`next_mail_check_at`);--> statement-breakpoint
CREATE INDEX `cmp_notice_state_schedule_idx` ON `policy_notices` (`state`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `cmp_enforce_user_completed_idx` ON `policy_enforcement_actions` (`user_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `cmp_policy_enforcement_mode_idx` ON `policy_enforcement_preferences` (`mode`);--> statement-breakpoint
CREATE INDEX `ix_sec_inc_event_event` ON `security_incident_events` (`event_id`);--> statement-breakpoint
CREATE INDEX `ix_sec_inc_event_time` ON `security_incident_events` (`incident_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ix_sec_inc_timeline` ON `security_incident_timeline` (`incident_id`,`at`,`id`);--> statement-breakpoint
CREATE INDEX `ix_sec_inc_status_last` ON `security_incidents` (`status`,`last_event_at`);--> statement-breakpoint
CREATE INDEX `ix_sec_inc_dedupe` ON `security_incidents` (`dedupe_key`,`status`);--> statement-breakpoint
CREATE INDEX `ix_sec_inc_rule_last` ON `security_incidents` (`rule_key`,`last_event_at`);--> statement-breakpoint
CREATE INDEX `ix_sec_inc_last` ON `security_incidents` (`last_event_at`,`id`);--> statement-breakpoint
CREATE INDEX `protection_signin_bans_expiry_idx` ON `protection_signin_bans` (`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `protection_signin_strikes_updated_idx` ON `protection_signin_strikes` (`updated_at`);--> statement-breakpoint
CREATE INDEX `report_definitions_owner_idx` ON `report_definitions` (`owner_user_id`,`id`);--> statement-breakpoint
CREATE INDEX `report_definitions_visibility_idx` ON `report_definitions` (`visibility`,`id`);--> statement-breakpoint
CREATE INDEX `report_runs_user_started_idx` ON `report_runs` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `report_runs_started_idx` ON `report_runs` (`started_at`);