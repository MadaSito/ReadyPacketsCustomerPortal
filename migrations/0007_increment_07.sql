CREATE TABLE `sso_role_mappings` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`app_role_value` varchar(120) NOT NULL,
	`role` enum('staff','customer') NOT NULL,
	`created_by_user_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sso_role_mappings_id` PRIMARY KEY(`id`),
	CONSTRAINT `sso_role_mappings_value_uq` UNIQUE(`app_role_value`)
);
--> statement-breakpoint
CREATE TABLE `sso_saml_certificates` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`fingerprint_sha256` char(64) NOT NULL,
	`certificate_pem` text NOT NULL,
	`subject` varchar(255),
	`not_before` datetime(3) NOT NULL,
	`not_after` datetime(3) NOT NULL,
	`source` enum('manual','metadata') NOT NULL,
	`added_by_user_id` bigint unsigned,
	`last_used_at` datetime(3),
	`retired_at` datetime(3),
	`retired_by_user_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sso_saml_certificates_id` PRIMARY KEY(`id`),
	CONSTRAINT `sso_saml_certificates_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `sso_saml_certificates_fp_uq` UNIQUE(`fingerprint_sha256`)
);
--> statement-breakpoint
CREATE TABLE `order_admin_tasks` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`workflow_version_id` bigint unsigned NOT NULL,
	`stage_key` varchar(48) NOT NULL,
	`task_key` varchar(48) NOT NULL,
	`checked_by_user_id` bigint unsigned,
	`checked_at` datetime(3),
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `order_admin_tasks_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_admin_tasks_task_uq` UNIQUE(`order_id`,`workflow_version_id`,`stage_key`,`task_key`)
);
--> statement-breakpoint
CREATE TABLE `order_question_answers` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`question_id` bigint unsigned NOT NULL,
	`version` int unsigned NOT NULL,
	`body_enc` text NOT NULL,
	`answered_by_user_id` bigint unsigned NOT NULL,
	`answered_at` datetime(3) NOT NULL,
	CONSTRAINT `order_question_answers_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_question_answers_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_question_answers_public_uq` UNIQUE(`public_id`),
	CONSTRAINT `order_question_answers_version_uq` UNIQUE(`question_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `order_questions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`workflow_version_id` bigint unsigned NOT NULL,
	`stage_key` varchar(48) NOT NULL,
	`prompt_enc` text NOT NULL,
	`required` boolean NOT NULL DEFAULT false,
	`asked_by_user_id` bigint unsigned NOT NULL,
	`asked_at` datetime(3) NOT NULL,
	`withdrawn_by_user_id` bigint unsigned,
	`withdrawn_at` datetime(3),
	CONSTRAINT `order_questions_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_questions_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_questions_public_uq` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `order_stage_progress` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`workflow_version_id` bigint unsigned NOT NULL,
	`stage_key` varchar(48) NOT NULL,
	`state` enum('open','submitted','in_review','accepted','reopened') NOT NULL DEFAULT 'open',
	`opened_at` datetime(3) NOT NULL,
	`completed_at` datetime(3),
	`completed_how` enum('next','submit','review','payment','status'),
	`submitted_at` datetime(3),
	`submitted_by_user_id` bigint unsigned,
	`ack_policy` enum('required','optional','none'),
	`ack_text_sha256` char(64),
	`ack_at` datetime(3),
	`ack_by_user_id` bigint unsigned,
	`review_outcome` enum('accepted','changes_requested'),
	`reviewed_at` datetime(3),
	`reviewed_by_user_id` bigint unsigned,
	`review_note_public_id` varchar(26),
	`reopened_at` datetime(3),
	`reopened_by_user_id` bigint unsigned,
	`reopen_note_public_id` varchar(26),
	`reopen_count` int unsigned NOT NULL DEFAULT 0,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_stage_progress_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_stage_progress_uq` UNIQUE(`order_id`,`workflow_version_id`,`stage_key`)
);
--> statement-breakpoint
CREATE TABLE `order_status_catalog` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`key` varchar(48) NOT NULL,
	`staff_label` varchar(60) NOT NULL,
	`customer_label` varchar(60) NOT NULL,
	`tone` enum('neutral','info','success','warning','danger') NOT NULL DEFAULT 'neutral',
	`category` enum('start','working','waiting','done','canceled') NOT NULL,
	`attention` enum('none','staff_review','customer_response') NOT NULL DEFAULT 'none',
	`position` int unsigned NOT NULL DEFAULT 0,
	`retired` boolean NOT NULL DEFAULT false,
	`retired_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_status_catalog_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_status_catalog_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_status_catalog_key_uq` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `file_playback_grants` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`file_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`session_id` varchar(80) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`redeemed_at` datetime(3),
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `file_playback_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `file_playback_grants_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `file_playback_grants_public_uq` UNIQUE(`public_id`),
	CONSTRAINT `file_playback_grants_hash_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `storage_managed_file_copies` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`source_public_id` char(26) NOT NULL,
	`connection_public_id` char(26) NOT NULL,
	`destination_version` int unsigned NOT NULL,
	`role` enum('originals','conversionStaging','intakeDelivery','receipt') NOT NULL,
	`state` enum('queued','copying','copied','failed','blocked','unknown') NOT NULL DEFAULT 'queued',
	`target_enc` text NOT NULL,
	`remote_id_enc` text,
	`reason_code` varchar(64),
	`job_public_id` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`finished_at` datetime(3),
	CONSTRAINT `storage_managed_file_copies_id` PRIMARY KEY(`id`),
	CONSTRAINT `storage_managed_file_copies_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `storage_managed_file_source_role_uq` UNIQUE(`source_public_id`,`connection_public_id`,`role`)
);
--> statement-breakpoint
CREATE TABLE `storage_managed_order_roots` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`root_enc` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `storage_managed_order_roots_id` PRIMARY KEY(`id`),
	CONSTRAINT `storage_managed_order_roots_order_uq` UNIQUE(`order_public_id`)
);
--> statement-breakpoint
CREATE TABLE `order_completion_jobs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`workflow_version_id` bigint unsigned NOT NULL,
	`stage_key` varchar(48),
	`source_kind` enum('stage_run','automation_run') NOT NULL,
	`source_public_id` char(26) NOT NULL,
	`idempotency_key` varchar(120) NOT NULL,
	`correlation_id` varchar(64) NOT NULL,
	`policy_kind` enum('fixed','range') NOT NULL,
	`min_percent` int unsigned NOT NULL,
	`max_percent` int unsigned NOT NULL,
	`resolved_percent` int unsigned NOT NULL,
	`delay_minutes` int unsigned NOT NULL DEFAULT 0,
	`due_at` datetime(3) NOT NULL,
	`expected_revision` int unsigned NOT NULL,
	`applied_revision` int unsigned,
	`job_public_id` varchar(40),
	`state` enum('scheduled','applied','superseded','canceled','failed') NOT NULL,
	`attempt_count` int unsigned NOT NULL DEFAULT 0,
	`reason_code` varchar(64),
	`created_by_user_id` bigint unsigned,
	`canceled_by_user_id` bigint unsigned,
	`canceled_at` datetime(3),
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_completion_jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_completion_jobs_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_completion_jobs_idem_uq` UNIQUE(`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `order_stage_runs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`workflow_version_id` bigint unsigned NOT NULL,
	`stage_key` varchar(48) NOT NULL,
	`stage_label` varchar(60) NOT NULL,
	`triggered_by_user_id` bigint unsigned NOT NULL,
	`idempotency_key` varchar(64) NOT NULL,
	`correlation_id` varchar(64) NOT NULL,
	`state` enum('completed','partial_failed','failed') NOT NULL,
	`reason_code` varchar(64),
	`bundle_snapshot_json` text NOT NULL,
	`results_json` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`finished_at` datetime(3) NOT NULL,
	CONSTRAINT `order_stage_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_stage_runs_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_stage_runs_order_idem_uq` UNIQUE(`order_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `payment_webhook_rejections` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`provider` enum('stripe','square') NOT NULL,
	`environment_hint` enum('test','live','unknown') NOT NULL DEFAULT 'unknown',
	`reason_code` varchar(64) NOT NULL,
	`http_status` int unsigned NOT NULL,
	`skew_seconds` int,
	`received_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payment_webhook_rejections_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_webhook_rejections_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `operational_alerts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`source` enum('stage_bundle','completion_job','automation','webhook','graph','file_sync','payment','certificate','attention') NOT NULL,
	`severity` enum('warning','error','critical') NOT NULL,
	`state` enum('open','acknowledged','resolved') NOT NULL DEFAULT 'open',
	`dedup_hash` char(64) NOT NULL,
	`code` varchar(64) NOT NULL,
	`title` varchar(120) NOT NULL,
	`text` varchar(500),
	`order_public_id` char(26),
	`run_public_id` char(26),
	`correlation_id` varchar(64) NOT NULL,
	`acknowledged_at` datetime(3),
	`acknowledged_by_user_id` bigint unsigned,
	`resolved_at` datetime(3),
	`resolved_by_user_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `operational_alerts_id` PRIMARY KEY(`id`),
	CONSTRAINT `operational_alerts_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `ops_alert_source_key_uq` UNIQUE(`source`,`dedup_hash`)
);
--> statement-breakpoint
CREATE TABLE `file_archive_tickets` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`token_hash` char(64) NOT NULL,
	`archive_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`session_id` varchar(80) NOT NULL,
	`issued_at` datetime(3) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	CONSTRAINT `file_archive_tickets_id` PRIMARY KEY(`id`),
	CONSTRAINT `file_archive_tickets_hash_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `file_archives` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`scope` enum('stage','order') NOT NULL,
	`stage_key` varchar(64),
	`requested_by_user_id` bigint unsigned NOT NULL,
	`session_id` varchar(80) NOT NULL,
	`active_user_id` bigint unsigned,
	`state` enum('queued','building','ready','failed','expired','revoked') NOT NULL DEFAULT 'queued',
	`reason_code` varchar(64),
	`manifest` json NOT NULL,
	`file_count` int unsigned NOT NULL,
	`total_bytes` bigint unsigned NOT NULL,
	`zip_bytes` bigint unsigned,
	`zip_sha256` char(64),
	`object_key_enc` text,
	`job_id` varchar(64),
	`expires_at` datetime(3) NOT NULL,
	`built_at` datetime(3),
	`download_count` int unsigned NOT NULL DEFAULT 0,
	`last_downloaded_at` datetime(3),
	`purged_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `file_archives_id` PRIMARY KEY(`id`),
	CONSTRAINT `file_archives_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `file_archives_active_user_uq` UNIQUE(`active_user_id`)
);
--> statement-breakpoint
ALTER TABLE `payment_webhook_events` MODIFY COLUMN `status` enum('processed','ignored','retry_pending','verification_mismatch','awaiting_settlement','attention_required') NOT NULL;--> statement-breakpoint
ALTER TABLE `sso_auth_requests` ADD `protocol` enum('oidc','saml') DEFAULT 'oidc' NOT NULL;--> statement-breakpoint
ALTER TABLE `sso_auth_requests` ADD `force_authn` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sso_auth_requests` ADD `assertion_id_hash` char(64);--> statement-breakpoint
ALTER TABLE `sso_configuration` ADD `protocol` enum('oidc','saml') DEFAULT 'oidc' NOT NULL;--> statement-breakpoint
ALTER TABLE `sso_configuration` ADD `saml_entity_id` varchar(255);--> statement-breakpoint
ALTER TABLE `sso_configuration` ADD `saml_metadata_url` varchar(512);--> statement-breakpoint
ALTER TABLE `sso_configuration` ADD `saml_metadata_refreshed_at` datetime(3);--> statement-breakpoint
ALTER TABLE `sso_configuration` ADD `saml_metadata_status` varchar(40);--> statement-breakpoint
ALTER TABLE `sso_configuration` ADD `entra_mfa_mode` enum('claim','entra','portal');--> statement-breakpoint
ALTER TABLE `sso_configuration` ADD `accepted_authn_contexts` text;--> statement-breakpoint
ALTER TABLE `sso_configuration` ADD `sso_allowed_roles` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `progress_percent` tinyint unsigned;--> statement-breakpoint
ALTER TABLE `orders` ADD `completion_percent` tinyint unsigned;--> statement-breakpoint
ALTER TABLE `orders` ADD `completion_revision` int unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `attention` enum('none','staff_review','customer_response') DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `attention_since` datetime(3);--> statement-breakpoint
ALTER TABLE `orders` ADD `payment_state` enum('not_required','unpaid','pending_async','paid','partially_refunded','refunded') DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `paid_at` datetime(3);--> statement-breakpoint
ALTER TABLE `file_access_log` ADD `order_public_id` char(26);--> statement-breakpoint
ALTER TABLE `file_access_log` ADD `action` varchar(32);--> statement-breakpoint
ALTER TABLE `order_files` ADD `stage_key` varchar(64);--> statement-breakpoint
ALTER TABLE `integration_production_dispatches` ADD `trigger_source` varchar(32) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `integration_production_dispatches` ADD `stage_key` varchar(64);--> statement-breakpoint
ALTER TABLE `integration_production_dispatches` ADD `stopped_at` datetime(3);--> statement-breakpoint
ALTER TABLE `integration_production_dispatches` ADD `stopped_by_user_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `integration_production_dispatches` ADD `stopped_by_public_id` varchar(26);--> statement-breakpoint
ALTER TABLE `integration_production_dispatches` ADD `stop_reason` varchar(280);--> statement-breakpoint
ALTER TABLE `integration_webhook_deliveries` ADD `order_public_id` varchar(26);--> statement-breakpoint
ALTER TABLE `integration_webhook_deliveries` ADD `stage_key` varchar(64);--> statement-breakpoint
ALTER TABLE `integration_webhook_deliveries` ADD `manual_retry_count` int unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `integration_webhook_deliveries` ADD `stopped_at` datetime(3);--> statement-breakpoint
ALTER TABLE `integration_webhook_deliveries` ADD `stopped_by_user_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `integration_webhook_deliveries` ADD `stopped_by_public_id` varchar(26);--> statement-breakpoint
ALTER TABLE `integration_webhook_deliveries` ADD `stop_reason` varchar(280);--> statement-breakpoint
ALTER TABLE `integration_webhook_subscriptions` ADD `signing_enabled` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `storage_connections` ADD `file_sync_mode` enum('phase_files','receipts');--> statement-breakpoint
ALTER TABLE `storage_connections` ADD `file_sync_write_test_version` int unsigned;--> statement-breakpoint
ALTER TABLE `automations` ADD `sort_order` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_webhook_events` ADD `last_error_code` varchar(64);--> statement-breakpoint
ALTER TABLE `payment_webhook_events` ADD `attempt_count` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sso_auth_requests` ADD CONSTRAINT `sso_auth_requests_assertion_uq` UNIQUE(`assertion_id_hash`);--> statement-breakpoint
ALTER TABLE `order_admin_tasks` ADD CONSTRAINT `oat_actor_fk` FOREIGN KEY (`checked_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_question_answers` ADD CONSTRAINT `oqa_question_fk` FOREIGN KEY (`question_id`) REFERENCES `order_questions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_question_answers` ADD CONSTRAINT `oqa_actor_fk` FOREIGN KEY (`answered_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_questions` ADD CONSTRAINT `oq_asker_fk` FOREIGN KEY (`asked_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_questions` ADD CONSTRAINT `oq_withdrawer_fk` FOREIGN KEY (`withdrawn_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_stage_progress` ADD CONSTRAINT `order_stage_progress_submitted_by_user_id_users_id_fk` FOREIGN KEY (`submitted_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_stage_progress` ADD CONSTRAINT `order_stage_progress_ack_by_user_id_users_id_fk` FOREIGN KEY (`ack_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_stage_progress` ADD CONSTRAINT `order_stage_progress_reviewed_by_user_id_users_id_fk` FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_stage_progress` ADD CONSTRAINT `order_stage_progress_reopened_by_user_id_users_id_fk` FOREIGN KEY (`reopened_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `sso_saml_certificates_active_idx` ON `sso_saml_certificates` (`retired_at`,`not_after`);--> statement-breakpoint
CREATE INDEX `order_questions_stage_idx` ON `order_questions` (`order_id`,`workflow_version_id`,`stage_key`,`withdrawn_at`,`id`);--> statement-breakpoint
CREATE INDEX `order_stage_progress_state_idx` ON `order_stage_progress` (`state`,`order_id`);--> statement-breakpoint
CREATE INDEX `order_status_catalog_pos_idx` ON `order_status_catalog` (`retired`,`position`,`id`);--> statement-breakpoint
CREATE INDEX `file_playback_grants_order_idx` ON `file_playback_grants` (`order_id`);--> statement-breakpoint
CREATE INDEX `file_playback_grants_file_idx` ON `file_playback_grants` (`file_id`);--> statement-breakpoint
CREATE INDEX `file_playback_grants_exp_idx` ON `file_playback_grants` (`expires_at`);--> statement-breakpoint
CREATE INDEX `storage_managed_file_order_idx` ON `storage_managed_file_copies` (`order_public_id`,`id`);--> statement-breakpoint
CREATE INDEX `storage_managed_file_health_idx` ON `storage_managed_file_copies` (`connection_public_id`,`state`,`finished_at`);--> statement-breakpoint
CREATE INDEX `order_completion_jobs_order_created_idx` ON `order_completion_jobs` (`order_public_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `order_completion_jobs_order_state_idx` ON `order_completion_jobs` (`order_id`,`state`,`due_at`);--> statement-breakpoint
CREATE INDEX `order_completion_jobs_stage_idx` ON `order_completion_jobs` (`order_public_id`,`stage_key`,`id`);--> statement-breakpoint
CREATE INDEX `order_stage_runs_order_created_idx` ON `order_stage_runs` (`order_public_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `order_stage_runs_stage_idx` ON `order_stage_runs` (`order_public_id`,`stage_key`,`id`);--> statement-breakpoint
CREATE INDEX `pmt_wh_rej_rec_idx` ON `payment_webhook_rejections` (`received_at`,`id`);--> statement-breakpoint
CREATE INDEX `pmt_wh_rej_prov_rec_idx` ON `payment_webhook_rejections` (`provider`,`received_at`,`id`);--> statement-breakpoint
CREATE INDEX `ops_alert_state_severity_ix` ON `operational_alerts` (`state`,`severity`,`public_id`);--> statement-breakpoint
CREATE INDEX `ops_alert_source_public_ix` ON `operational_alerts` (`source`,`public_id`);--> statement-breakpoint
CREATE INDEX `file_archive_tickets_archive_idx` ON `file_archive_tickets` (`archive_id`);--> statement-breakpoint
CREATE INDEX `file_archive_tickets_exp_idx` ON `file_archive_tickets` (`expires_at`);--> statement-breakpoint
CREATE INDEX `file_archives_order_idx` ON `file_archives` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `file_archives_user_idx` ON `file_archives` (`requested_by_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `file_archives_expiry_idx` ON `file_archives` (`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `orders_attention_idx` ON `orders` (`attention`,`attention_since`,`id`);--> statement-breakpoint
CREATE INDEX `orders_payment_state_idx` ON `orders` (`payment_state`,`id`);--> statement-breakpoint
CREATE INDEX `file_access_log_order_idx` ON `file_access_log` (`order_public_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_files_stage_idx` ON `order_files` (`order_id`,`stage_key`,`superseded_at`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_delivery_order_created` ON `integration_webhook_deliveries` (`order_public_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `automations_sort_order_idx` ON `automations` (`enabled`,`trigger_mode`,`sort_order`,`id`);