CREATE TABLE `identity_session_restrictions` (
	`id` int NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`max_concurrent_per_user` int,
	`idle_minutes_customer` int,
	`idle_minutes_staff` int,
	`idle_minutes_admin` int,
	`absolute_hours_customer` int,
	`absolute_hours_staff` int,
	`absolute_hours_admin` int,
	`console_ip_allow_list` text,
	`country_mode` enum('off','allow','deny') NOT NULL DEFAULT 'off',
	`country_scope` enum('all','customers','console') NOT NULL DEFAULT 'all',
	`countries` varchar(750),
	`allow_unknown_country` boolean NOT NULL DEFAULT true,
	`version` int unsigned NOT NULL DEFAULT 1,
	`updated_by` bigint unsigned,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `identity_session_restrictions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `identity_sign_in_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`occurred_at` datetime(3) NOT NULL,
	`kind` enum('success','failure','lock','sign_out','forced_end','expiry','refused') NOT NULL,
	`reason_code` varchar(40),
	`user_id` bigint unsigned,
	`role` enum('admin','staff','customer'),
	`auth_method` enum('local','saml','entra'),
	`session_public_id` char(26),
	`ip_address_enc` text,
	`ip_index` char(64),
	`country` char(2),
	`device_summary` varchar(80),
	`actor_user_id` bigint unsigned,
	`request_id` char(26),
	CONSTRAINT `identity_sign_in_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `identity_sign_in_events_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `order_acknowledgements` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`workflow_version_id` bigint unsigned NOT NULL,
	`status_key` varchar(48) NOT NULL,
	`ack_key` varchar(48) NOT NULL,
	`acceptor_side` enum('customer','staff') NOT NULL,
	`text_sha256` char(64) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`user_role` varchar(16) NOT NULL,
	`session_id` varchar(64) NOT NULL,
	`typed_name_enc` text,
	`accepted_at` datetime(3) NOT NULL,
	CONSTRAINT `order_acknowledgements_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_acknowledgements_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_acknowledgements_once_uq` UNIQUE(`order_id`,`workflow_version_id`,`status_key`,`ack_key`,`acceptor_side`)
);
--> statement-breakpoint
CREATE TABLE `order_customer_grants` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`owner_user_id` bigint unsigned NOT NULL,
	`grantee_user_id` bigint unsigned NOT NULL,
	`role` enum('viewer','contributor') NOT NULL,
	`status` enum('active','revoked') NOT NULL DEFAULT 'active',
	`live_key` varchar(48),
	`granted_by_user_id` bigint unsigned,
	`ended_at` datetime(3),
	`ended_by_user_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_customer_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_customer_grants_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_customer_grants_live_uq` UNIQUE(`live_key`)
);
--> statement-breakpoint
CREATE TABLE `order_phase_locks` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`workflow_version_id` bigint unsigned NOT NULL,
	`phase_key` varchar(48) NOT NULL,
	`state` enum('locked','unlocked') NOT NULL,
	`locked_at` datetime(3) NOT NULL,
	`locked_from_status` varchar(48) NOT NULL,
	`unlocked_at` datetime(3),
	`unlocked_by_user_id` bigint unsigned,
	`unlock_note_public_id` varchar(26),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_phase_locks_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_phase_locks_order_phase_uq` UNIQUE(`order_id`,`phase_key`)
);
--> statement-breakpoint
CREATE TABLE `platform_consent_records` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`consent_id` char(22) NOT NULL,
	`user_public_id` varchar(32),
	`policy_version` int unsigned NOT NULL,
	`preferences` boolean NOT NULL,
	`analytics` boolean NOT NULL,
	`session_replay` boolean NOT NULL,
	`action` varchar(12) NOT NULL,
	`source` varchar(12) NOT NULL,
	`gpc` boolean NOT NULL,
	`ip_index` char(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `platform_consent_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_consent_records_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `customer_maintenance` (
	`id` int unsigned NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`message` varchar(500) NOT NULL DEFAULT '',
	`starts_at` datetime(3),
	`ends_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 0,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `customer_maintenance_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mail_manual_resends` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`mail_id` bigint unsigned NOT NULL,
	`generation` int unsigned NOT NULL,
	`queued_at` datetime(3) NOT NULL,
	CONSTRAINT `mail_manual_resends_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_manual_resends_generation_uq` UNIQUE(`mail_id`,`generation`)
);
--> statement-breakpoint
CREATE TABLE `integration_webhook_deliveries` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`direction` varchar(16) NOT NULL,
	`subscription_id` bigint unsigned,
	`subscription_public_id` varchar(26),
	`inbound_endpoint_id` bigint unsigned,
	`inbound_endpoint_public_id` varchar(26),
	`target_label` varchar(255) NOT NULL,
	`event_key` varchar(120) NOT NULL,
	`external_event_id` varchar(128),
	`deduplication_key` varchar(160) NOT NULL,
	`status` varchar(24) NOT NULL,
	`http_method` varchar(10) NOT NULL DEFAULT 'POST',
	`http_path` varchar(255) NOT NULL,
	`http_status` int unsigned,
	`duration_ms` int unsigned,
	`request_bytes` int unsigned NOT NULL DEFAULT 0,
	`response_bytes` int unsigned NOT NULL DEFAULT 0,
	`attempt_count` int unsigned NOT NULL DEFAULT 0,
	`max_attempts` int unsigned NOT NULL DEFAULT 5,
	`next_attempt_at` datetime(3),
	`job_public_id` varchar(36),
	`active_fencing_token` bigint unsigned NOT NULL DEFAULT 0,
	`reason_code` varchar(64),
	`correlation_id` varchar(64) NOT NULL,
	`actor_label` varchar(96) NOT NULL,
	`payload_sha256` char(64) NOT NULL,
	`tap_event_enc` text,
	`payload_enc` text,
	`body_truncated` boolean NOT NULL DEFAULT false,
	`body_purged` boolean NOT NULL DEFAULT false,
	`is_replay` boolean NOT NULL DEFAULT false,
	`replay_of_public_id` varchar(26),
	`is_test` boolean NOT NULL DEFAULT false,
	`search_text` varchar(512) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`completed_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `integration_webhook_deliveries_id` PRIMARY KEY(`id`),
	CONSTRAINT `integration_webhook_deliveries_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `uq_webhook_delivery_dedupe` UNIQUE(`direction`,`deduplication_key`)
);
--> statement-breakpoint
CREATE TABLE `integration_webhook_delivery_attempts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`delivery_id` bigint unsigned NOT NULL,
	`attempt_number` int unsigned NOT NULL,
	`outcome` varchar(24) NOT NULL,
	`http_status` int unsigned,
	`duration_ms` int unsigned NOT NULL DEFAULT 0,
	`reason_code` varchar(64),
	`response_bytes` int unsigned NOT NULL DEFAULT 0,
	`response_enc` text,
	`occurred_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `integration_webhook_delivery_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `integration_webhook_delivery_attempts_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `uq_webhook_attempt_num` UNIQUE(`delivery_id`,`attempt_number`)
);
--> statement-breakpoint
CREATE TABLE `integration_webhook_inbound_endpoints` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`name` varchar(120) NOT NULL,
	`endpoint_key` varchar(64) NOT NULL,
	`description` varchar(280),
	`enabled` boolean NOT NULL DEFAULT false,
	`signing_secret_enc` text NOT NULL,
	`signing_secret_last4` varchar(4) NOT NULL,
	`previous_secret_enc` text,
	`previous_secret_expires_at` datetime(3),
	`tolerance_seconds` int unsigned NOT NULL DEFAULT 300,
	`last_received_at` datetime(3),
	`created_by_user_id` bigint unsigned,
	`updated_by_user_id` bigint unsigned,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `integration_webhook_inbound_endpoints_id` PRIMARY KEY(`id`),
	CONSTRAINT `integration_webhook_inbound_endpoints_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `uq_webhook_inbound_key` UNIQUE(`endpoint_key`)
);
--> statement-breakpoint
CREATE TABLE `integration_webhook_subscriptions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` varchar(280),
	`target_url_enc` text NOT NULL,
	`target_url_host` varchar(253) NOT NULL,
	`target_url_masked` varchar(320) NOT NULL,
	`events_json` text NOT NULL,
	`status` varchar(24) NOT NULL,
	`signing_secret_enc` text NOT NULL,
	`signing_secret_last4` varchar(4) NOT NULL,
	`previous_secret_enc` text,
	`previous_secret_expires_at` datetime(3),
	`consecutive_failures` int unsigned NOT NULL DEFAULT 0,
	`last_delivered_at` datetime(3),
	`last_failed_at` datetime(3),
	`last_failure_reason` varchar(64),
	`auto_disabled_at` datetime(3),
	`created_by_user_id` bigint unsigned,
	`updated_by_user_id` bigint unsigned,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `integration_webhook_subscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `integration_webhook_subscriptions_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `storage_copy_attempts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`kind` enum('order_file','backup_archive','sharepoint_order') NOT NULL,
	`source_public_id` char(26) NOT NULL,
	`connection_public_id` char(26) NOT NULL,
	`job_public_id` varchar(64) NOT NULL,
	`attempt` int unsigned NOT NULL,
	`correlation_id` varchar(64),
	`bytes` bigint unsigned,
	`state` enum('queued','written','verified','failed','not_written') NOT NULL DEFAULT 'queued',
	`verification` enum('checksum','provider_readback'),
	`error_code` varchar(64),
	`started_at` datetime(3),
	`finished_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `storage_copy_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `storage_copy_attempts_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `storage_copy_attempt_job_uq` UNIQUE(`job_public_id`,`attempt`)
);
--> statement-breakpoint
CREATE TABLE `protection_blocks` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`bucket` int unsigned NOT NULL,
	`address_key` char(64) NOT NULL,
	`address_enc` text NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `protection_blocks_id` PRIMARY KEY(`id`),
	CONSTRAINT `protection_blocks_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `protection_blocks_public_uidx` UNIQUE(`public_id`),
	CONSTRAINT `protection_blocks_bucket_uidx` UNIQUE(`bucket`)
);
--> statement-breakpoint
CREATE TABLE `protection_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`minute` int unsigned NOT NULL,
	`slot` int unsigned NOT NULL,
	`action` enum('detect','block') NOT NULL,
	`rule` varchar(80) NOT NULL,
	`method` varchar(12) NOT NULL,
	`route` varchar(80) NOT NULL,
	`country` char(2),
	`address_enc` text,
	`agent` varchar(20) NOT NULL,
	`correlation_id` varchar(80) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `protection_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `protection_events_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `protection_events_public_uidx` UNIQUE(`public_id`),
	CONSTRAINT `protection_events_sample_uidx` UNIQUE(`minute`,`slot`)
);
--> statement-breakpoint
CREATE TABLE `protection_policies` (
	`id` int unsigned NOT NULL,
	`policy` json NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `protection_policies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `api_idempotency` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`key_id` bigint unsigned NOT NULL,
	`idempotency_key` varchar(160) NOT NULL,
	`request_hash` char(64) NOT NULL,
	`state` enum('in_progress','completed') NOT NULL,
	`status` smallint unsigned,
	`response_enc` mediumtext,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `api_idempotency_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_idempotency_uq` UNIQUE(`key_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`name` varchar(120) NOT NULL,
	`prefix` char(12) NOT NULL,
	`secret_hash` varchar(128) NOT NULL,
	`scopes` json NOT NULL,
	`ip_allow_list` json NOT NULL,
	`expires_at` datetime(3),
	`rate_limit_per_minute` smallint unsigned NOT NULL DEFAULT 60,
	`require_signing` boolean NOT NULL DEFAULT false,
	`signing_secret_enc` varchar(512),
	`state` enum('active','revoked') NOT NULL DEFAULT 'active',
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_by_user_id` bigint unsigned NOT NULL,
	`last_used_at` datetime(3),
	`rotated_at` datetime(3),
	`revoked_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_keys_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `api_keys_prefix_uq` UNIQUE(`prefix`)
);
--> statement-breakpoint
CREATE TABLE `api_rate_windows` (
	`key_id` bigint unsigned NOT NULL,
	`window_start` datetime(3) NOT NULL,
	`count` int unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `api_rate_windows_pk` PRIMARY KEY(`key_id`,`window_start`)
);
--> statement-breakpoint
CREATE TABLE `api_request_log` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`key_id` bigint unsigned,
	`key_public_id` char(26),
	`method` varchar(8) NOT NULL,
	`route` varchar(128) NOT NULL,
	`path` varchar(512) NOT NULL,
	`status` smallint unsigned NOT NULL,
	`duration_ms` int unsigned NOT NULL,
	`correlation_id` varchar(64) NOT NULL,
	`error_code` varchar(64),
	`request_bytes` int unsigned NOT NULL,
	`response_bytes` int unsigned NOT NULL,
	`request_view_enc` mediumtext,
	`response_view_enc` mediumtext,
	`replay_enc` mediumtext,
	`body_truncated` boolean NOT NULL DEFAULT false,
	`ip_enc` varchar(255),
	`idempotency_key` varchar(128),
	`replay_of` char(26),
	`replayed_by_user_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `api_request_log_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_request_log_public_uq` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `api_settings` (
	`id` tinyint unsigned NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`retention_days` smallint unsigned NOT NULL DEFAULT 30,
	`version` int unsigned NOT NULL DEFAULT 1,
	`updated_by_user_id` bigint unsigned,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `api_settings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `api_signature_nonces` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`key_id` bigint unsigned NOT NULL,
	`signature_hash` char(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `api_signature_nonces_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_signature_nonces_uq` UNIQUE(`key_id`,`signature_hash`)
);
--> statement-breakpoint
CREATE TABLE `community_categories` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`slug` varchar(48) NOT NULL,
	`name` varchar(80) NOT NULL,
	`description` varchar(300) NOT NULL DEFAULT '',
	`sort_order` int unsigned NOT NULL DEFAULT 0,
	`staff_only_posting` boolean NOT NULL DEFAULT false,
	`archived` boolean NOT NULL DEFAULT false,
	`topic_count` int unsigned NOT NULL DEFAULT 0,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `community_categories_id` PRIMARY KEY(`id`),
	CONSTRAINT `community_categories_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `community_categories_slug_uq` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `community_moderation_log` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`actor_user_id` bigint unsigned,
	`action` enum('approve','hide','unhide','remove','lock','unlock','pin','unpin','move','suspend','unsuspend','report_dismissed','report_actioned','auto_hide') NOT NULL,
	`target_type` enum('post','topic','member','report') NOT NULL,
	`target_public_id` char(26) NOT NULL,
	`reason` varchar(200),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `community_moderation_log_id` PRIMARY KEY(`id`),
	CONSTRAINT `community_moderation_log_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `community_posts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`topic_id` bigint unsigned NOT NULL,
	`author_user_id` bigint unsigned NOT NULL,
	`author_role` enum('admin','staff','customer') NOT NULL,
	`is_opening` boolean NOT NULL DEFAULT false,
	`body_text` text NOT NULL,
	`body_hash` char(64) NOT NULL,
	`link_count` int unsigned NOT NULL DEFAULT 0,
	`quote_post_id` bigint unsigned,
	`state` enum('published','pending','hidden','removed','deleted') NOT NULL DEFAULT 'published',
	`held_reason` varchar(40),
	`edited_at` datetime(3),
	`edit_count` int unsigned NOT NULL DEFAULT 0,
	`helpful_count` int unsigned NOT NULL DEFAULT 0,
	`open_report_count` int unsigned NOT NULL DEFAULT 0,
	`idempotency_key` varchar(64) NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `community_posts_id` PRIMARY KEY(`id`),
	CONSTRAINT `community_posts_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `community_posts_idem_uq` UNIQUE(`author_user_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `community_profiles` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`display_name` varchar(32) NOT NULL,
	`display_name_key` varchar(64) NOT NULL,
	`anonymised` boolean NOT NULL DEFAULT false,
	`suspended_until` datetime(3),
	`suspended_indefinitely` boolean NOT NULL DEFAULT false,
	`suspension_reason` varchar(200),
	`suspended_by_user_id` bigint unsigned,
	`post_count` int unsigned NOT NULL DEFAULT 0,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `community_profiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `community_profiles_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `community_profiles_user_uq` UNIQUE(`user_id`),
	CONSTRAINT `community_profiles_name_uq` UNIQUE(`display_name_key`)
);
--> statement-breakpoint
CREATE TABLE `community_reactions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`post_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `community_reactions_id` PRIMARY KEY(`id`),
	CONSTRAINT `community_reactions_uq` UNIQUE(`post_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `community_reports` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`post_id` bigint unsigned NOT NULL,
	`reporter_user_id` bigint unsigned NOT NULL,
	`reason` enum('spam','abuse','off_topic','personal_info','other') NOT NULL,
	`note` varchar(500),
	`state` enum('open','actioned','dismissed') NOT NULL DEFAULT 'open',
	`open_reporter_user_id` bigint unsigned,
	`resolved_by_user_id` bigint unsigned,
	`resolved_at` datetime(3),
	`resolution_note` varchar(500),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `community_reports_id` PRIMARY KEY(`id`),
	CONSTRAINT `community_reports_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `community_reports_open_uq` UNIQUE(`post_id`,`open_reporter_user_id`)
);
--> statement-breakpoint
CREATE TABLE `community_subscriptions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`topic_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `community_subscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `community_subscriptions_uq` UNIQUE(`topic_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `community_topics` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`category_id` bigint unsigned NOT NULL,
	`author_user_id` bigint unsigned NOT NULL,
	`title` varchar(140) NOT NULL,
	`state` enum('open','hidden','removed') NOT NULL DEFAULT 'open',
	`visible` boolean NOT NULL DEFAULT false,
	`pinned` boolean NOT NULL DEFAULT false,
	`locked` boolean NOT NULL DEFAULT false,
	`reply_count` int unsigned NOT NULL DEFAULT 0,
	`last_post_at` datetime(3) NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `community_topics_id` PRIMARY KEY(`id`),
	CONSTRAINT `community_topics_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `referral_codes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`code` char(10) NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `referral_codes_id` PRIMARY KEY(`id`),
	CONSTRAINT `referral_codes_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `ref_codes_user_uq` UNIQUE(`user_id`),
	CONSTRAINT `ref_codes_code_uq` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `referral_email_invites` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`sender_user_id` bigint unsigned NOT NULL,
	`referral_code_id` bigint unsigned NOT NULL,
	`recipient_email_index` char(64) NOT NULL,
	`outcome` enum('enqueued','suppressed_existing_user') NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `referral_email_invites_id` PRIMARY KEY(`id`),
	CONSTRAINT `referral_email_invites_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `referral_reward_ledger` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`referral_id` bigint unsigned NOT NULL,
	`referrer_user_id` bigint unsigned NOT NULL,
	`entry_type` enum('reward_approved','credit_applied') NOT NULL,
	`amount_minor` bigint NOT NULL,
	`currency` char(3) NOT NULL,
	`payout_method` enum('account_credit','manual_payout'),
	`reference` varchar(160),
	`note` varchar(500),
	`actor_user_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `referral_reward_ledger_id` PRIMARY KEY(`id`),
	CONSTRAINT `referral_reward_ledger_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `ref_ledger_ref_type_uq` UNIQUE(`referral_id`,`entry_type`)
);
--> statement-breakpoint
CREATE TABLE `referrals` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`referral_code_id` bigint unsigned NOT NULL,
	`referrer_user_id` bigint unsigned NOT NULL,
	`referred_user_id` bigint unsigned NOT NULL,
	`code_snapshot` char(10) NOT NULL,
	`status` enum('attributed','qualified_pending_approval','approved','rejected','credited') NOT NULL DEFAULT 'attributed',
	`reward_mode` enum('fixed','percent'),
	`reward_percent_bps` int unsigned,
	`reward_cap_minor` bigint,
	`reward_amount_minor` bigint NOT NULL DEFAULT 0,
	`currency` char(3) NOT NULL DEFAULT 'USD',
	`qualifying_invoice_public_id` char(26),
	`qualifying_order_public_id` char(26),
	`invoice_subtotal_minor` bigint,
	`invoice_discount_minor` bigint,
	`invoice_total_minor` bigint,
	`invoice_currency` char(3),
	`qualification_note_code` varchar(64),
	`attributed_at` datetime(3) NOT NULL,
	`qualified_at` datetime(3),
	`reviewed_at` datetime(3),
	`reviewed_by_user_id` bigint unsigned,
	`review_reason` varchar(500),
	`credited_at` datetime(3),
	`credited_by_user_id` bigint unsigned,
	`payout_method` enum('account_credit','manual_payout'),
	`payout_reference` varchar(160),
	`payout_note` varchar(500),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `referrals_id` PRIMARY KEY(`id`),
	CONSTRAINT `referrals_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `ref_attr_referred_uq` UNIQUE(`referred_user_id`),
	CONSTRAINT `ref_attr_qual_inv_uq` UNIQUE(`qualifying_invoice_public_id`)
);
--> statement-breakpoint
CREATE TABLE `cart_items` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`cart_id` bigint unsigned NOT NULL,
	`product_public_id` char(26) NOT NULL,
	`packet_number` int unsigned,
	`quantity` int unsigned NOT NULL DEFAULT 1,
	`position` int unsigned NOT NULL DEFAULT 0,
	`snapshot_name` varchar(160),
	`snapshot_tier` varchar(32),
	`snapshot_unit_price_minor` bigint,
	`snapshot_currency` char(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `cart_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `cart_items_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cart_item_cart_prod_uq` UNIQUE(`cart_id`,`product_public_id`),
	CONSTRAINT `cart_item_cart_pkt_uq` UNIQUE(`cart_id`,`packet_number`)
);
--> statement-breakpoint
CREATE TABLE `carts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`owner_user_id` bigint unsigned NOT NULL,
	`active_owner_slot` bigint unsigned,
	`status` enum('open','awaiting_payment','checked_out','restored','expired') NOT NULL DEFAULT 'open',
	`project_name` varchar(160),
	`note_enc` text,
	`billing_enc` text,
	`billing_country` char(2),
	`billing_region` varchar(64),
	`checkout_idempotency_key` varchar(128),
	`checkout_order_id` bigint unsigned,
	`checkout_order_public_id` char(26),
	`checkout_order_reference` varchar(48),
	`checkout_invoice_id` bigint unsigned,
	`checkout_invoice_public_id` char(26),
	`checkout_invoice_number` varchar(48),
	`payment_mode` enum('invoice','redirect'),
	`payment_attempt_public_id` char(26),
	`checked_out_currency` char(3),
	`checked_out_subtotal_minor` bigint,
	`checked_out_discount_minor` bigint,
	`checked_out_discount_label` varchar(120),
	`checked_out_tax_rate_bps` int unsigned,
	`checked_out_tax_minor` bigint,
	`checked_out_total_minor` bigint,
	`restored_into_cart_public_id` char(26),
	`last_activity_at` datetime(3) NOT NULL,
	`checked_out_at` datetime(3),
	`restored_at` datetime(3),
	`expired_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `carts_id` PRIMARY KEY(`id`),
	CONSTRAINT `carts_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cart_active_owner_uq` UNIQUE(`active_owner_slot`),
	CONSTRAINT `cart_owner_idem_uq` UNIQUE(`owner_user_id`,`checkout_idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `payment_attempts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`invoice_id` bigint unsigned NOT NULL,
	`invoice_public_id` char(26) NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`cart_public_id` char(26),
	`customer_user_id` bigint unsigned NOT NULL,
	`provider` enum('stripe','square') NOT NULL,
	`environment` enum('test','live') NOT NULL,
	`status` enum('created','redirected','paid','failed','expired','cancelled') NOT NULL DEFAULT 'created',
	`amount_minor` bigint NOT NULL,
	`currency` char(3) NOT NULL,
	`idempotency_key` varchar(128) NOT NULL,
	`success_path` varchar(200) NOT NULL,
	`cancel_path` varchar(200) NOT NULL,
	`provider_ref` varchar(128),
	`provider_order_ref` varchar(128),
	`provider_payment_ref` varchar(128),
	`redirect_url_enc` text,
	`verified_webhook_event_id` varchar(128),
	`compliance_payment_public_id` char(26),
	`reconciliation_note` varchar(120),
	`failure_reason_code` varchar(64),
	`redirected_at` datetime(3),
	`expires_at` datetime(3),
	`paid_at` datetime(3),
	`cancelled_at` datetime(3),
	`last_reconciled_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payment_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_attempts_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `pmt_att_inv_idem_uq` UNIQUE(`invoice_id`,`idempotency_key`),
	CONSTRAINT `pmt_att_prov_ref_uq` UNIQUE(`provider`,`provider_ref`)
);
--> statement-breakpoint
CREATE TABLE `payment_webhook_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`provider` enum('stripe','square') NOT NULL,
	`environment` enum('test','live') NOT NULL,
	`external_event_id` varchar(128) NOT NULL,
	`event_type` varchar(96) NOT NULL,
	`payload_sha256` char(64) NOT NULL,
	`attempt_id` bigint unsigned,
	`attempt_public_id` char(26),
	`provider_ref` varchar(128),
	`provider_order_ref` varchar(128),
	`provider_payment_ref` varchar(128),
	`status` enum('processed','ignored','retry_pending','verification_mismatch') NOT NULL,
	`reason_code` varchar(64),
	`occurred_at` datetime(3) NOT NULL,
	`received_at` datetime(3) NOT NULL,
	`processed_at` datetime(3),
	CONSTRAINT `payment_webhook_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_webhook_events_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `pmt_wh_prov_ext_uq` UNIQUE(`provider`,`external_event_id`)
);
--> statement-breakpoint
ALTER TABLE `user_sessions` ADD `ip_address_enc` text;--> statement-breakpoint
ALTER TABLE `user_sessions` ADD `country` char(2);--> statement-breakpoint
ALTER TABLE `order_grants` ADD `customer_grant_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `order_files` ADD `slot_key` varchar(64);--> statement-breakpoint
ALTER TABLE `order_files` ADD `derived_from_public_id` char(26);--> statement-breakpoint
ALTER TABLE `order_files` ADD `conversion_state` enum('converting','converted','failed');--> statement-breakpoint
ALTER TABLE `order_files` ADD `conversion_reason` varchar(64);--> statement-breakpoint
ALTER TABLE `order_files` ADD `duration_ms` int unsigned;--> statement-breakpoint
ALTER TABLE `order_files` ADD `transcript_enc` text;--> statement-breakpoint
ALTER TABLE `http_rate_limit_counters` ADD `block_public_id` char(26);--> statement-breakpoint
ALTER TABLE `order_files` ADD CONSTRAINT `order_files_audio_source_uq` UNIQUE(`derived_from_public_id`);--> statement-breakpoint
ALTER TABLE `http_rate_limit_counters` ADD CONSTRAINT `http_rate_limit_block_uidx` UNIQUE(`block_public_id`);--> statement-breakpoint
ALTER TABLE `identity_session_restrictions` ADD CONSTRAINT `identity_session_restrictions_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `identity_sign_in_events` ADD CONSTRAINT `identity_sign_in_events_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `identity_sign_in_events` ADD CONSTRAINT `identity_sign_in_events_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_acknowledgements` ADD CONSTRAINT `order_acknowledgements_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_customer_grants` ADD CONSTRAINT `order_customer_grants_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_customer_grants` ADD CONSTRAINT `order_customer_grants_grantee_user_id_users_id_fk` FOREIGN KEY (`grantee_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_customer_grants` ADD CONSTRAINT `order_customer_grants_granted_by_user_id_users_id_fk` FOREIGN KEY (`granted_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_customer_grants` ADD CONSTRAINT `order_customer_grants_ended_by_user_id_users_id_fk` FOREIGN KEY (`ended_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_phase_locks` ADD CONSTRAINT `order_phase_locks_unlocked_by_user_id_users_id_fk` FOREIGN KEY (`unlocked_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_manual_resends` ADD CONSTRAINT `mail_manual_resends_mail_id_mail_outbox_id_fk` FOREIGN KEY (`mail_id`) REFERENCES `mail_outbox`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `community_posts` ADD CONSTRAINT `community_posts_author_user_id_users_id_fk` FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `community_profiles` ADD CONSTRAINT `community_profiles_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `community_reactions` ADD CONSTRAINT `community_reactions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `community_reports` ADD CONSTRAINT `community_reports_reporter_user_id_users_id_fk` FOREIGN KEY (`reporter_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `community_subscriptions` ADD CONSTRAINT `community_subscriptions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `community_topics` ADD CONSTRAINT `community_topics_author_user_id_users_id_fk` FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referral_codes` ADD CONSTRAINT `ref_codes_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referral_email_invites` ADD CONSTRAINT `ref_invites_sender_fk` FOREIGN KEY (`sender_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referral_email_invites` ADD CONSTRAINT `ref_invites_code_fk` FOREIGN KEY (`referral_code_id`) REFERENCES `referral_codes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referral_reward_ledger` ADD CONSTRAINT `ref_ledger_referral_fk` FOREIGN KEY (`referral_id`) REFERENCES `referrals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referral_reward_ledger` ADD CONSTRAINT `ref_ledger_referrer_fk` FOREIGN KEY (`referrer_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referral_reward_ledger` ADD CONSTRAINT `ref_ledger_actor_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referrals` ADD CONSTRAINT `ref_attr_code_fk` FOREIGN KEY (`referral_code_id`) REFERENCES `referral_codes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referrals` ADD CONSTRAINT `ref_attr_referrer_fk` FOREIGN KEY (`referrer_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referrals` ADD CONSTRAINT `ref_attr_referred_fk` FOREIGN KEY (`referred_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referrals` ADD CONSTRAINT `ref_attr_reviewer_fk` FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referrals` ADD CONSTRAINT `ref_attr_creditor_fk` FOREIGN KEY (`credited_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cart_items` ADD CONSTRAINT `cart_item_cart_fk` FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `carts` ADD CONSTRAINT `cart_owner_user_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD CONSTRAINT `pmt_att_cust_user_fk` FOREIGN KEY (`customer_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_webhook_events` ADD CONSTRAINT `pmt_wh_att_fk` FOREIGN KEY (`attempt_id`) REFERENCES `payment_attempts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `identity_sign_in_events_time_idx` ON `identity_sign_in_events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `identity_sign_in_events_user_idx` ON `identity_sign_in_events` (`user_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `identity_sign_in_events_kind_idx` ON `identity_sign_in_events` (`kind`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `identity_sign_in_events_ip_idx` ON `identity_sign_in_events` (`ip_index`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `order_acknowledgements_order_idx` ON `order_acknowledgements` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_customer_grants_owner_idx` ON `order_customer_grants` (`owner_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `platform_consent_records_consent_idx` ON `platform_consent_records` (`consent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `platform_consent_records_user_idx` ON `platform_consent_records` (`user_public_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `platform_consent_records_created_idx` ON `platform_consent_records` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_delivery_dir_created` ON `integration_webhook_deliveries` (`direction`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_delivery_sub_created` ON `integration_webhook_deliveries` (`subscription_public_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_delivery_inb_created` ON `integration_webhook_deliveries` (`inbound_endpoint_public_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_delivery_event_created` ON `integration_webhook_deliveries` (`event_key`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_delivery_status_next` ON `integration_webhook_deliveries` (`status`,`next_attempt_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_delivery_corr` ON `integration_webhook_deliveries` (`correlation_id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_delivery_expiry` ON `integration_webhook_deliveries` (`body_purged`,`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_delivery_created_id` ON `integration_webhook_deliveries` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_attempt_delivery` ON `integration_webhook_delivery_attempts` (`delivery_id`,`attempt_number`);--> statement-breakpoint
CREATE INDEX `idx_webhook_inbound_enabled_id` ON `integration_webhook_inbound_endpoints` (`enabled`,`id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_sub_status_id` ON `integration_webhook_subscriptions` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_sub_updated_id` ON `integration_webhook_subscriptions` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `storage_copy_attempt_time_idx` ON `storage_copy_attempts` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `storage_copy_attempt_conn_idx` ON `storage_copy_attempts` (`connection_public_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `storage_copy_attempt_kind_idx` ON `storage_copy_attempts` (`kind`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `storage_copy_attempt_state_idx` ON `storage_copy_attempts` (`state`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `protection_blocks_expiry_idx` ON `protection_blocks` (`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `protection_events_time_idx` ON `protection_events` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `protection_events_action_idx` ON `protection_events` (`action`,`id`);--> statement-breakpoint
CREATE INDEX `protection_events_country_idx` ON `protection_events` (`country`,`id`);--> statement-breakpoint
CREATE INDEX `api_idempotency_exp_idx` ON `api_idempotency` (`expires_at`);--> statement-breakpoint
CREATE INDEX `api_keys_state_idx` ON `api_keys` (`state`,`id`);--> statement-breakpoint
CREATE INDEX `api_rate_windows_ws_idx` ON `api_rate_windows` (`window_start`);--> statement-breakpoint
CREATE INDEX `api_request_log_created_idx` ON `api_request_log` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `api_request_log_key_idx` ON `api_request_log` (`key_id`,`id`);--> statement-breakpoint
CREATE INDEX `api_request_log_status_idx` ON `api_request_log` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `api_request_log_corr_idx` ON `api_request_log` (`correlation_id`);--> statement-breakpoint
CREATE INDEX `api_signature_nonces_exp_idx` ON `api_signature_nonces` (`expires_at`);--> statement-breakpoint
CREATE INDEX `community_categories_sort_idx` ON `community_categories` (`archived`,`sort_order`);--> statement-breakpoint
CREATE INDEX `community_modlog_created_idx` ON `community_moderation_log` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `community_modlog_target_idx` ON `community_moderation_log` (`target_type`,`target_public_id`);--> statement-breakpoint
CREATE INDEX `community_posts_topic_idx` ON `community_posts` (`topic_id`,`id`);--> statement-breakpoint
CREATE INDEX `community_posts_author_idx` ON `community_posts` (`author_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `community_posts_state_idx` ON `community_posts` (`state`,`id`);--> statement-breakpoint
CREATE INDEX `community_reports_state_idx` ON `community_reports` (`state`,`id`);--> statement-breakpoint
CREATE INDEX `community_subscriptions_user_idx` ON `community_subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `community_topics_list_idx` ON `community_topics` (`category_id`,`pinned`,`last_post_at`);--> statement-breakpoint
CREATE INDEX `community_topics_recent_idx` ON `community_topics` (`visible`,`last_post_at`);--> statement-breakpoint
CREATE INDEX `ref_invites_sender_time_idx` ON `referral_email_invites` (`sender_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ref_invites_rcpt_time_idx` ON `referral_email_invites` (`recipient_email_index`,`created_at`);--> statement-breakpoint
CREATE INDEX `ref_ledger_referrer_id_idx` ON `referral_reward_ledger` (`referrer_user_id`,`id`);--> statement-breakpoint
CREATE INDEX `ref_attr_referrer_id_idx` ON `referrals` (`referrer_user_id`,`id`);--> statement-breakpoint
CREATE INDEX `ref_attr_status_id_idx` ON `referrals` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `ref_attr_code_snap_idx` ON `referrals` (`code_snapshot`,`id`);--> statement-breakpoint
CREATE INDEX `ref_attr_created_id_idx` ON `referrals` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `cart_item_cart_pos_idx` ON `cart_items` (`cart_id`,`position`,`id`);--> statement-breakpoint
CREATE INDEX `cart_st_activity_idx` ON `carts` (`status`,`last_activity_at`);--> statement-breakpoint
CREATE INDEX `cart_owner_st_idx` ON `carts` (`owner_user_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `cart_attempt_pub_idx` ON `carts` (`payment_attempt_public_id`);--> statement-breakpoint
CREATE INDEX `cart_inv_pub_idx` ON `carts` (`checkout_invoice_public_id`);--> statement-breakpoint
CREATE INDEX `pmt_att_inv_pub_idx` ON `payment_attempts` (`invoice_public_id`,`id`);--> statement-breakpoint
CREATE INDEX `pmt_att_cust_idx` ON `payment_attempts` (`customer_user_id`,`id`);--> statement-breakpoint
CREATE INDEX `pmt_att_st_exp_idx` ON `payment_attempts` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `pmt_att_prov_ord_idx` ON `payment_attempts` (`provider`,`provider_order_ref`);--> statement-breakpoint
CREATE INDEX `pmt_wh_st_rec_idx` ON `payment_webhook_events` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `pmt_wh_att_idx` ON `payment_webhook_events` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `user_sessions_live_idx` ON `user_sessions` (`revoked_at`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `order_grants_customer_grant_idx` ON `order_grants` (`customer_grant_id`);--> statement-breakpoint
CREATE INDEX `order_files_slot_idx` ON `order_files` (`order_id`,`slot_key`,`status_key`);