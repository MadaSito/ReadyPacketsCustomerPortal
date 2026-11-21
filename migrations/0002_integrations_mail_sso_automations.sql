CREATE TABLE `sso_auth_requests` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`purpose` enum('sign_in','link','step_up','test') NOT NULL,
	`status` enum('prepared','pending','verified','refused','completed') NOT NULL,
	`state_hash` char(64),
	`nonce_hash` char(64),
	`verifier_enc` text,
	`ticket_hash` char(64),
	`browser_hash` char(64),
	`session_public_id` char(26),
	`user_id` bigint unsigned,
	`config_epoch` int unsigned NOT NULL,
	`next_path` varchar(512),
	`code_enc` text,
	`result_enc` text,
	`refusal_code` varchar(40),
	`requested_at` datetime(3) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`callback_at` datetime(3),
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sso_auth_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `sso_auth_requests_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `sso_auth_requests_state_uq` UNIQUE(`state_hash`),
	CONSTRAINT `sso_auth_requests_ticket_uq` UNIQUE(`ticket_hash`)
);
--> statement-breakpoint
CREATE TABLE `sso_configuration` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`tenant_id` char(36),
	`client_id` char(36),
	`client_secret_enc` text,
	`client_secret_last4` varchar(4),
	`button_label` varchar(40),
	`allowed_domains` text,
	`trust_entra_mfa` boolean NOT NULL DEFAULT false,
	`jit_mode` enum('off','customers','staff') NOT NULL DEFAULT 'off',
	`jit_staff_app_role` varchar(120),
	`jit_daily_limit` int unsigned NOT NULL DEFAULT 25,
	`epoch` int unsigned NOT NULL DEFAULT 1,
	`updated_by_user_id` bigint unsigned,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sso_configuration_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sso_identities` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`provider` varchar(16) NOT NULL DEFAULT 'entra',
	`tenant_id` char(36) NOT NULL,
	`object_id` char(36) NOT NULL,
	`link_method` enum('self','admin','jit') NOT NULL,
	`linked_by_user_id` bigint unsigned,
	`linked_at` datetime(3) NOT NULL,
	`verified_at` datetime(3),
	`last_sign_in_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sso_identities_id` PRIMARY KEY(`id`),
	CONSTRAINT `sso_identities_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `sso_identities_subject_uq` UNIQUE(`provider`,`tenant_id`,`object_id`),
	CONSTRAINT `sso_identities_user_uq` UNIQUE(`user_id`,`provider`)
);
--> statement-breakpoint
CREATE TABLE `assurance_local_admin_policy` (
	`id` int unsigned NOT NULL,
	CONSTRAINT `assurance_local_admin_policy_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `order_workflow_drafts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`workflow_id` bigint unsigned,
	`workflow_key` varchar(64) NOT NULL,
	`name` varchar(120) NOT NULL,
	`source` enum('standard','copy','blank') NOT NULL,
	`base_version_id` bigint unsigned,
	`definition` json NOT NULL,
	`layout` json,
	`created_by_user_id` bigint unsigned,
	`updated_by_user_id` bigint unsigned,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_workflow_drafts_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_workflow_drafts_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_workflow_drafts_workflow_uq` UNIQUE(`workflow_id`),
	CONSTRAINT `order_workflow_drafts_key_uq` UNIQUE(`workflow_key`)
);
--> statement-breakpoint
CREATE TABLE `order_workflow_version_layouts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`version_id` bigint unsigned NOT NULL,
	`layout` json,
	`change_note` varchar(500),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_workflow_version_layouts_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_workflow_version_layouts_uq` UNIQUE(`version_id`)
);
--> statement-breakpoint
CREATE TABLE `mail_audit_verification` (
	`id` int unsigned NOT NULL,
	`address_hash` char(64) NOT NULL,
	`code_hash` char(64),
	`expires_at` datetime(3),
	`verified_at` datetime(3),
	CONSTRAINT `mail_audit_verification_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mail_transport_attempts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`mail_id` bigint unsigned NOT NULL,
	`generation` int unsigned NOT NULL,
	`purpose` enum('primary','secondary','audit_copy') NOT NULL,
	`transport` enum('smtp','graph') NOT NULL,
	`state` enum('sending','accepted','held','captured','failed','unknown') NOT NULL,
	`reason_code` varchar(64),
	`started_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	CONSTRAINT `mail_transport_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_transport_attempts_slot_uq` UNIQUE(`mail_id`,`generation`,`purpose`)
);
--> statement-breakpoint
CREATE TABLE `backup_remote_copies` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`backup_id` bigint unsigned NOT NULL,
	`connection_public_id` varchar(64) NOT NULL,
	`provider_kind` varchar(32) NOT NULL,
	`connection_name` varchar(120) NOT NULL,
	`destination_version` int unsigned NOT NULL DEFAULT 1,
	`state` enum('queued','running','completed','failed','canceled','refused','unknown') NOT NULL DEFAULT 'queued',
	`object_name` varchar(160) NOT NULL,
	`verified_bytes` bigint unsigned,
	`archive_sha256` char(64) NOT NULL,
	`digest_verified` boolean NOT NULL DEFAULT false,
	`verified_digest_kind` varchar(16),
	`attempt_count` int unsigned NOT NULL DEFAULT 0,
	`job_public_id` varchar(64),
	`reason_code` varchar(64),
	`started_at` datetime(3),
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `backup_remote_copies_id` PRIMARY KEY(`id`),
	CONSTRAINT `backup_remote_copies_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `backup_remote_copies_archive_conn_uq` UNIQUE(`backup_id`,`connection_public_id`)
);
--> statement-breakpoint
CREATE TABLE `storage_google_drive_folders` (
	`locator` char(64) NOT NULL,
	`provider_id_enc` text NOT NULL,
	CONSTRAINT `storage_google_drive_folders_locator` PRIMARY KEY(`locator`)
);
--> statement-breakpoint
CREATE TABLE `storage_oauth_attempts` (
	`connection_public_id` char(26) NOT NULL,
	`attempt_id` char(26) NOT NULL,
	`provider` varchar(24) NOT NULL,
	`expected_version` int unsigned NOT NULL,
	`redirect_uri` varchar(1024) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`phase` varchar(12) NOT NULL,
	`state_hash` char(64),
	`binder_hash` char(64),
	`payload_enc` text,
	CONSTRAINT `storage_oauth_attempts_connection_public_id` PRIMARY KEY(`connection_public_id`),
	CONSTRAINT `storage_oauth_attempts_state_hash_unique` UNIQUE(`state_hash`)
);
--> statement-breakpoint
CREATE TABLE `storage_assignments` (
	`purpose` enum('order_files','backups','order_data') NOT NULL,
	`connection_public_ids` json NOT NULL,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `storage_assignments_purpose` PRIMARY KEY(`purpose`)
);
--> statement-breakpoint
CREATE TABLE `storage_connections` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`kind` enum('s3','azure_blob','dropbox','google_drive','sharepoint','onedrive') NOT NULL,
	`name` varchar(120) NOT NULL,
	`config` json NOT NULL,
	`credentials_enc` text,
	`oauth_connected` boolean NOT NULL DEFAULT false,
	`enabled` boolean NOT NULL DEFAULT false,
	`version` int unsigned NOT NULL DEFAULT 1,
	`destination_version` int unsigned NOT NULL DEFAULT 1,
	`last_test_code` varchar(32),
	`last_test_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `storage_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `storage_connections_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `storage_file_copies` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`file_public_id` char(26) NOT NULL,
	`connection_public_id` char(26) NOT NULL,
	`destination_version` int unsigned NOT NULL,
	`state` enum('queued','copying','copied','failed','skipped') NOT NULL DEFAULT 'queued',
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`reason_code` varchar(64),
	`target_enc` text,
	`remote_id_enc` text,
	`digest_verified` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`finished_at` datetime(3),
	CONSTRAINT `storage_file_copies_id` PRIMARY KEY(`id`),
	CONSTRAINT `storage_file_copies_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `storage_file_copies_file_connection_uq` UNIQUE(`file_public_id`,`connection_public_id`)
);
--> statement-breakpoint
CREATE TABLE `sharepoint_order_sync` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`list_id` varchar(200),
	`remote_item_id` varchar(200),
	`desired_version` int unsigned NOT NULL DEFAULT 1,
	`synced_version` int unsigned NOT NULL DEFAULT 0,
	`content_hash` char(64),
	`state` enum('pending','synced','failed','unknown') NOT NULL DEFAULT 'pending',
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`reason_code` varchar(64),
	`last_synced_at` datetime(3),
	`claim_job_id` varchar(64),
	`claim_token` char(26),
	`claimed_until` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sharepoint_order_sync_id` PRIMARY KEY(`id`),
	CONSTRAINT `sharepoint_order_sync_order_uq` UNIQUE(`order_public_id`)
);
--> statement-breakpoint
CREATE TABLE `sharepoint_sync_config` (
	`id` tinyint unsigned NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`list_id` varchar(200),
	`list_label` varchar(255),
	`include_portal_link` boolean NOT NULL DEFAULT false,
	`version` int unsigned NOT NULL DEFAULT 1,
	`updated_by_user_id` bigint unsigned,
	`last_error_code` varchar(64),
	`last_error_at` datetime(3),
	`backfill_run_id` char(26),
	`backfill_state` enum('running','completed','failed'),
	`backfill_cursor` char(26),
	`backfill_scope` varchar(96),
	`backfill_enqueued` int unsigned NOT NULL DEFAULT 0,
	`backfill_reason_code` varchar(64),
	`backfill_started_at` datetime(3),
	`backfill_finished_at` datetime(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sharepoint_sync_config_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mail_template_versions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`template_id` bigint unsigned NOT NULL,
	`version_number` int unsigned NOT NULL,
	`state` enum('draft','published') NOT NULL DEFAULT 'draft',
	`format` enum('html','text') NOT NULL DEFAULT 'html',
	`subject` varchar(255) NOT NULL,
	`body_html` mediumtext,
	`body_text` mediumtext NOT NULL,
	`content_hash` char(64) NOT NULL,
	`change_note` varchar(500) NOT NULL DEFAULT '',
	`restored_from_version_number` int unsigned,
	`created_by_user_id` bigint unsigned,
	`published_at` datetime(3),
	`published_by_user_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `mail_template_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_template_versions_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `mt_versions_tpl_num_uq` UNIQUE(`template_id`,`version_number`)
);
--> statement-breakpoint
CREATE TABLE `mail_templates` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`template_key` varchar(100) NOT NULL,
	`kind` enum('system','custom') NOT NULL,
	`category` enum('auth','orders','compliance','engagement','operations','automation') NOT NULL,
	`name` varchar(160) NOT NULL,
	`description` varchar(500) NOT NULL DEFAULT '',
	`declared_vars_json` json NOT NULL,
	`active_published_version_id` bigint unsigned,
	`working_draft_version_id` bigint unsigned,
	`latest_version_number` int unsigned NOT NULL DEFAULT 0,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_by_user_id` bigint unsigned,
	`updated_by_user_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `mail_templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_templates_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `mt_templates_key_uq` UNIQUE(`template_key`)
);
--> statement-breakpoint
CREATE TABLE `automation_run_steps` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`run_id` bigint unsigned NOT NULL,
	`step_index` int unsigned NOT NULL,
	`step_key` varchar(40) NOT NULL,
	`action_key` varchar(80) NOT NULL,
	`state` enum('pending','dispatching','completed','skipped','failed','unknown') NOT NULL DEFAULT 'pending',
	`attempt_count` int unsigned NOT NULL DEFAULT 0,
	`reason_code` varchar(64),
	`safe_summary` varchar(255),
	`safe_counts_json` text,
	`external_ref` varchar(120),
	`started_at` datetime(3),
	`finished_at` datetime(3),
	`duration_ms` int unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `automation_run_steps_id` PRIMARY KEY(`id`),
	CONSTRAINT `automation_run_steps_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `automation_run_steps_run_idx_uq` UNIQUE(`run_id`,`step_index`)
);
--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`automation_id` bigint unsigned NOT NULL,
	`automation_public_id` char(26) NOT NULL,
	`automation_name` varchar(160) NOT NULL,
	`automation_version` int unsigned NOT NULL,
	`trigger_mode` enum('event','manual','schedule') NOT NULL,
	`trigger_key` varchar(80),
	`trigger_event_id` varchar(64),
	`dedup_key` varchar(120) NOT NULL,
	`correlation_id` varchar(64) NOT NULL,
	`is_test` boolean NOT NULL DEFAULT false,
	`state` enum('queued','running','completed','skipped_conditions','rate_limited','failed','partial_unknown','canceled') NOT NULL,
	`reason_code` varchar(64),
	`evaluated_fields_json` text NOT NULL,
	`context_snapshot_enc` text,
	`job_public_id` varchar(40),
	`queued_at` datetime(3) NOT NULL,
	`started_at` datetime(3),
	`finished_at` datetime(3),
	`duration_ms` int unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `automation_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `automation_runs_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `automation_runs_auto_dedup_uq` UNIQUE(`automation_id`,`dedup_key`)
);
--> statement-breakpoint
CREATE TABLE `automation_secrets` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`automation_id` bigint unsigned NOT NULL,
	`step_key` varchar(40) NOT NULL,
	`field_key` varchar(64) NOT NULL,
	`secret_enc` text NOT NULL,
	`last4` varchar(4) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `automation_secrets_id` PRIMARY KEY(`id`),
	CONSTRAINT `automation_secrets_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `automation_secrets_step_field_uq` UNIQUE(`automation_id`,`step_key`,`field_key`)
);
--> statement-breakpoint
CREATE TABLE `automation_versions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`automation_id` bigint unsigned NOT NULL,
	`version` int unsigned NOT NULL,
	`trigger_json` text NOT NULL,
	`conditions_json` text NOT NULL,
	`actions_json` text NOT NULL,
	`canvas_layout_json` text,
	`created_by_user_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `automation_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `automation_versions_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `automation_versions_auto_ver_uq` UNIQUE(`automation_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `automations` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`name` varchar(160) NOT NULL,
	`description` varchar(500),
	`enabled` boolean NOT NULL DEFAULT false,
	`version` int unsigned NOT NULL DEFAULT 1,
	`trigger_mode` enum('event','manual','schedule') NOT NULL,
	`trigger_key` varchar(80),
	`trigger_event_name` varchar(120),
	`schedule_every_minutes` int unsigned,
	`next_scheduled_at` datetime(3),
	`manual_require_order` boolean NOT NULL DEFAULT false,
	`max_runs_per_hour` int unsigned NOT NULL DEFAULT 60,
	`conditions_json` text NOT NULL,
	`actions_json` text NOT NULL,
	`canvas_layout_json` text,
	`created_by_user_id` bigint unsigned,
	`updated_by_user_id` bigint unsigned,
	`last_run_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `automations_id` PRIMARY KEY(`id`),
	CONSTRAINT `automations_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
ALTER TABLE `user_sessions` MODIFY COLUMN `auth_method` enum('local','saml','entra') NOT NULL DEFAULT 'local';--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `auth_source` enum('local','saml','entra') NOT NULL DEFAULT 'local';--> statement-breakpoint
ALTER TABLE `engagement_notifications` ADD `staff_only` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mail_outbox` ADD `content_enc` mediumtext;--> statement-breakpoint
ALTER TABLE `mail_outbox` ADD `content_expires_at` datetime(3);--> statement-breakpoint
ALTER TABLE `sso_identities` ADD CONSTRAINT `sso_identities_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_workflow_drafts` ADD CONSTRAINT `order_workflow_drafts_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_workflow_drafts` ADD CONSTRAINT `order_workflow_drafts_updated_by_user_id_users_id_fk` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_transport_attempts` ADD CONSTRAINT `mail_transport_attempts_mail_id_mail_outbox_id_fk` FOREIGN KEY (`mail_id`) REFERENCES `mail_outbox`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `backup_remote_copies` ADD CONSTRAINT `backup_remote_copies_backup_id_backup_archives_id_fk` FOREIGN KEY (`backup_id`) REFERENCES `backup_archives`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_template_versions` ADD CONSTRAINT `mt_versions_tpl_fk` FOREIGN KEY (`template_id`) REFERENCES `mail_templates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_template_versions` ADD CONSTRAINT `mt_versions_created_by_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_template_versions` ADD CONSTRAINT `mt_versions_published_by_fk` FOREIGN KEY (`published_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_templates` ADD CONSTRAINT `mt_templates_created_by_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_templates` ADD CONSTRAINT `mt_templates_updated_by_fk` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `sso_auth_requests_browser_idx` ON `sso_auth_requests` (`browser_hash`,`status`);--> statement-breakpoint
CREATE INDEX `sso_auth_requests_expiry_idx` ON `sso_auth_requests` (`expires_at`);--> statement-breakpoint
CREATE INDEX `sso_identities_created_idx` ON `sso_identities` (`link_method`,`created_at`);--> statement-breakpoint
CREATE INDEX `backup_remote_copies_state_updated_idx` ON `backup_remote_copies` (`state`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `backup_remote_copies_conn_idx` ON `backup_remote_copies` (`connection_public_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_storage_oauth_expiry` ON `storage_oauth_attempts` (`expires_at`);--> statement-breakpoint
CREATE INDEX `storage_connections_enabled_idx` ON `storage_connections` (`enabled`,`id`);--> statement-breakpoint
CREATE INDEX `storage_file_copies_state_idx` ON `storage_file_copies` (`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `sharepoint_order_sync_state_idx` ON `sharepoint_order_sync` (`state`,`id`);--> statement-breakpoint
CREATE INDEX `mt_versions_tpl_state_idx` ON `mail_template_versions` (`template_id`,`state`);--> statement-breakpoint
CREATE INDEX `mt_templates_kind_cat_idx` ON `mail_templates` (`kind`,`category`);--> statement-breakpoint
CREATE INDEX `automation_run_steps_state_idx` ON `automation_run_steps` (`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `automation_runs_auto_queued_idx` ON `automation_runs` (`automation_id`,`queued_at`,`id`);--> statement-breakpoint
CREATE INDEX `automation_runs_state_queued_idx` ON `automation_runs` (`state`,`queued_at`,`id`);--> statement-breakpoint
CREATE INDEX `automation_runs_queued_idx` ON `automation_runs` (`queued_at`,`id`);--> statement-breakpoint
CREATE INDEX `automation_versions_auto_created_idx` ON `automation_versions` (`automation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `automations_enabled_event_idx` ON `automations` (`enabled`,`trigger_mode`,`trigger_event_name`);--> statement-breakpoint
CREATE INDEX `automations_schedule_due_idx` ON `automations` (`enabled`,`trigger_mode`,`next_scheduled_at`);--> statement-breakpoint
CREATE INDEX `automations_updated_id_idx` ON `automations` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `orders_workflow_version_idx` ON `orders` (`workflow_version_id`);--> statement-breakpoint
CREATE INDEX `mail_outbox_content_expiry_ix` ON `mail_outbox` (`content_expires_at`,`id`);