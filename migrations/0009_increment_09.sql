CREATE TABLE `trash_cleanup_sweeps` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`status` enum('running','completed','failed') NOT NULL DEFAULT 'running',
	`active_slot` int unsigned,
	`fencing_token` int unsigned NOT NULL DEFAULT 1,
	`lease_owner` varchar(64),
	`lease_expires_at` datetime(3),
	`purged_count` int unsigned NOT NULL DEFAULT 0,
	`failed_count` int unsigned NOT NULL DEFAULT 0,
	`error_code` varchar(64),
	`correlation_id` varchar(64),
	`started_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `trash_cleanup_sweeps_id` PRIMARY KEY(`id`),
	CONSTRAINT `trash_cleanup_sweeps_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `trash_cleanup_sweep_active_uq` UNIQUE(`active_slot`)
);
--> statement-breakpoint
CREATE TABLE `trash_idempotency_keys` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`actor_user_id` bigint unsigned NOT NULL,
	`action` varchar(48) NOT NULL,
	`key_hash` char(64) NOT NULL,
	`fingerprint_hash` char(64) NOT NULL,
	`status` enum('in_progress','claimed','completed','failed') NOT NULL DEFAULT 'in_progress',
	`claimed_run_public_id` char(26),
	`response_json` mediumtext NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `trash_idempotency_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `trash_idem_actor_act_key_uq` UNIQUE(`actor_user_id`,`action`,`key_hash`)
);
--> statement-breakpoint
CREATE TABLE `trash_purge_run_targets` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`run_id` bigint unsigned NOT NULL,
	`entity_kind` enum('order','customer') NOT NULL,
	`entity_id` bigint unsigned NOT NULL,
	`entity_public_id` char(26) NOT NULL,
	`target_reference` varchar(64),
	`batch_id` char(26) NOT NULL,
	`position` int unsigned NOT NULL,
	`status` enum('pending','running','completed') NOT NULL DEFAULT 'pending',
	`checkpoint_json` mediumtext NOT NULL,
	`leave_external_copies_approved_at` datetime(3),
	`leave_external_copies_actor_user_id` bigint unsigned,
	`leave_external_copies_proof_json` mediumtext,
	`tombstoned_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `trash_purge_run_targets_id` PRIMARY KEY(`id`),
	CONSTRAINT `trash_purge_target_entity_uq` UNIQUE(`entity_kind`,`entity_id`)
);
--> statement-breakpoint
CREATE TABLE `trash_purge_runs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`entity_kind` enum('order','customer') NOT NULL,
	`entity_id` bigint unsigned NOT NULL,
	`entity_public_id` char(26) NOT NULL,
	`batch_id` char(26) NOT NULL,
	`sweep_public_id` char(26),
	`trigger` enum('manual','retention') NOT NULL,
	`actor_user_id` bigint unsigned,
	`status` enum('running','completed','failed') NOT NULL DEFAULT 'running',
	`fencing_token` int unsigned NOT NULL DEFAULT 1,
	`lease_owner` varchar(64),
	`lease_expires_at` datetime(3),
	`targets_json` mediumtext NOT NULL,
	`checkpoint_json` mediumtext NOT NULL,
	`counts_json` mediumtext NOT NULL,
	`attempt_count` int unsigned NOT NULL DEFAULT 1,
	`error_code` varchar(64),
	`failed_module` varchar(64),
	`failed_target_public_id` char(26),
	`next_retry_at` datetime(3),
	`correlation_id` varchar(64),
	`started_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `trash_purge_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `trash_purge_runs_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `trash_purge_run_entity_batch_uq` UNIQUE(`entity_kind`,`entity_public_id`,`batch_id`)
);
--> statement-breakpoint
CREATE TABLE `trash_retention_deferrals` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`entity_kind` enum('order','customer') NOT NULL,
	`entity_id` bigint unsigned NOT NULL,
	`entity_public_id` char(26) NOT NULL,
	`batch_id` char(26) NOT NULL,
	`reason_code` varchar(64) NOT NULL,
	`attempt_count` int unsigned NOT NULL DEFAULT 1,
	`next_attempt_at` datetime(3) NOT NULL,
	`alerted_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `trash_retention_deferrals_id` PRIMARY KEY(`id`),
	CONSTRAINT `trash_ret_deferral_entity_batch_uq` UNIQUE(`entity_kind`,`entity_id`,`batch_id`)
);
--> statement-breakpoint
CREATE TABLE `trash_retention_state` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`singleton_key` int unsigned NOT NULL DEFAULT 1,
	`version` int unsigned NOT NULL DEFAULT 1,
	`updated_by_user_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `trash_retention_state_id` PRIMARY KEY(`id`),
	CONSTRAINT `trash_retention_singleton_uq` UNIQUE(`singleton_key`)
);
--> statement-breakpoint
ALTER TABLE `operational_alerts` MODIFY COLUMN `source` enum('stage_bundle','completion_job','automation','webhook','graph','file_sync','payment','certificate','attention','trash') NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `trashed_at` datetime(3);--> statement-breakpoint
ALTER TABLE `users` ADD `trashed_by_user_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `users` ADD `trash_batch_id` char(26);--> statement-breakpoint
ALTER TABLE `users` ADD `trash_reason` varchar(200);--> statement-breakpoint
ALTER TABLE `users` ADD `purge_started_at` datetime(3);--> statement-breakpoint
ALTER TABLE `users` ADD `purged_at` datetime(3);--> statement-breakpoint
ALTER TABLE `orders` ADD `trashed_at` datetime(3);--> statement-breakpoint
ALTER TABLE `orders` ADD `trashed_by_user_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `orders` ADD `trash_batch_id` char(26);--> statement-breakpoint
ALTER TABLE `orders` ADD `trash_reason` varchar(200);--> statement-breakpoint
ALTER TABLE `orders` ADD `purge_started_at` datetime(3);--> statement-breakpoint
ALTER TABLE `orders` ADD `purged_at` datetime(3);--> statement-breakpoint
ALTER TABLE `engagement_notifications` ADD `order_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `engagement_notifications` ADD `ticket_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `compliance_invoices` ADD `issuer_contact_snapshot` varchar(160);--> statement-breakpoint
ALTER TABLE `compliance_invoices` ADD `order_reference_snapshot` varchar(48);--> statement-breakpoint
ALTER TABLE `compliance_invoices` ADD `customer_ref_snapshot` varchar(32);--> statement-breakpoint
ALTER TABLE `compliance_invoices` ADD `buyer_snapshot_enc` text;--> statement-breakpoint
ALTER TABLE `mail_outbox` ADD `order_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `mail_outbox` ADD `recipient_account_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `subject_user_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD `trash_cancelled_at` datetime(3);--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD `provider_cancelled_at` datetime(3);--> statement-breakpoint
ALTER TABLE `trash_purge_run_targets` ADD CONSTRAINT `trash_purge_target_run_fk` FOREIGN KEY (`run_id`) REFERENCES `trash_purge_runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `trash_cleanup_sweep_status_ix` ON `trash_cleanup_sweeps` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `trash_cleanup_sweep_fin_ix` ON `trash_cleanup_sweeps` (`finished_at`,`id`);--> statement-breakpoint
CREATE INDEX `trash_idem_status_created_ix` ON `trash_idempotency_keys` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `trash_idem_run_ix` ON `trash_idempotency_keys` (`claimed_run_public_id`);--> statement-breakpoint
CREATE INDEX `trash_purge_target_run_pos_ix` ON `trash_purge_run_targets` (`run_id`,`position`);--> statement-breakpoint
CREATE INDEX `trash_purge_target_pub_ix` ON `trash_purge_run_targets` (`entity_kind`,`entity_public_id`);--> statement-breakpoint
CREATE INDEX `trash_purge_run_entity_ix` ON `trash_purge_runs` (`entity_kind`,`entity_public_id`,`id`);--> statement-breakpoint
CREATE INDEX `trash_purge_run_status_ix` ON `trash_purge_runs` (`status`,`lease_expires_at`,`started_at`);--> statement-breakpoint
CREATE INDEX `trash_purge_run_retry_ix` ON `trash_purge_runs` (`status`,`next_retry_at`,`id`);--> statement-breakpoint
CREATE INDEX `trash_purge_run_sweep_ix` ON `trash_purge_runs` (`sweep_public_id`);--> statement-breakpoint
CREATE INDEX `trash_ret_deferral_next_ix` ON `trash_retention_deferrals` (`entity_kind`,`next_attempt_at`,`entity_id`);--> statement-breakpoint
CREATE INDEX `users_trashed_idx` ON `users` (`trashed_at`,`id`);--> statement-breakpoint
CREATE INDEX `orders_trashed_idx` ON `orders` (`trashed_at`,`id`);--> statement-breakpoint
CREATE INDEX `orders_trash_batch_idx` ON `orders` (`trash_batch_id`);--> statement-breakpoint
CREATE INDEX `eng_notif_order_id_idx` ON `engagement_notifications` (`order_id`,`id`);--> statement-breakpoint
CREATE INDEX `eng_notif_ticket_id_idx` ON `engagement_notifications` (`ticket_id`,`id`);--> statement-breakpoint
CREATE INDEX `eng_tickets_order_id_idx` ON `engagement_support_tickets` (`related_order_id`,`id`);--> statement-breakpoint
CREATE INDEX `mail_outbox_order_state_ix` ON `mail_outbox` (`order_id`,`state`);--> statement-breakpoint
CREATE INDEX `mail_outbox_account_state_ix` ON `mail_outbox` (`recipient_account_id`,`state`);--> statement-breakpoint
CREATE INDEX `automation_runs_subject_user_idx` ON `automation_runs` (`subject_user_id`);--> statement-breakpoint
CREATE INDEX `automation_runs_triggered_by_idx` ON `automation_runs` (`triggered_by_user_id`);--> statement-breakpoint
CREATE INDEX `api_keys_creator_idx` ON `api_keys` (`created_by_user_id`);--> statement-breakpoint
CREATE INDEX `community_reports_reporter_idx` ON `community_reports` (`reporter_user_id`,`id`);--> statement-breakpoint
CREATE INDEX `community_topics_author_idx` ON `community_topics` (`author_user_id`,`id`);--> statement-breakpoint
CREATE INDEX `pmt_att_ord_pub_idx` ON `payment_attempts` (`order_public_id`,`id`);