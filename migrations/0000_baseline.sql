CREATE TABLE `customer_ref_history` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`previous_reference` varchar(32),
	`new_reference` varchar(32) NOT NULL,
	`changed_by_user_id` bigint unsigned,
	`reason_code` varchar(40) NOT NULL,
	`changed_at` datetime(3) NOT NULL,
	CONSTRAINT `customer_ref_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `customer_ref_reservations` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`reference` varchar(32) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`retired_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `customer_ref_reservations_id` PRIMARY KEY(`id`),
	CONSTRAINT `customer_ref_reservations_ref_uq` UNIQUE(`reference`)
);
--> statement-breakpoint
CREATE TABLE `identity_tokens` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`purpose` enum('verify_email','password_reset','invitation','admin_set_password') NOT NULL,
	`token_hash` char(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`consumed_at` datetime(3),
	`retired_reason` varchar(24),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `identity_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `identity_tokens_hash_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`token_hash` char(64) NOT NULL,
	`csrf_secret_enc` text NOT NULL,
	`auth_method` enum('local','saml') NOT NULL DEFAULT 'local',
	`authenticated_at` datetime(3) NOT NULL,
	`last_seen_at` datetime(3) NOT NULL,
	`absolute_expires_at` datetime(3) NOT NULL,
	`mfa_verified_at` datetime(3),
	`step_up_at` datetime(3),
	`rotated_at` datetime(3),
	`revoked_at` datetime(3),
	`revoke_reason` varchar(40),
	`device_summary` varchar(80),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `user_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_sessions_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `user_sessions_token_hash_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`customer_ref` varchar(32),
	`role` enum('admin','staff','customer') NOT NULL DEFAULT 'customer',
	`status` enum('pending_activation','active','suspended','deactivated') NOT NULL DEFAULT 'pending_activation',
	`email_enc` text NOT NULL,
	`email_index` char(64) NOT NULL,
	`email_verified_at` datetime(3),
	`name_enc` text NOT NULL,
	`password_hash` varchar(255),
	`password_changed_at` datetime(3),
	`must_change_password` boolean NOT NULL DEFAULT false,
	`auth_source` enum('local','saml') NOT NULL DEFAULT 'local',
	`name_first_prefix_index` char(64),
	`name_last_prefix_index` char(64),
	`origin` varchar(16) NOT NULL DEFAULT 'register',
	`status_reason_code` varchar(40),
	`status_changed_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `users_customer_ref_unique` UNIQUE(`customer_ref`),
	CONSTRAINT `users_email_index_uq` UNIQUE(`email_index`)
);
--> statement-breakpoint
CREATE TABLE `assurance_accounts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`totp_secret_enc` text,
	`last_totp_step` bigint unsigned,
	`totp_failures` int unsigned NOT NULL DEFAULT 0,
	`totp_locked_until` datetime(3),
	`pending_totp_secret_enc` text,
	`pending_totp_session_id` char(26),
	`pending_totp_expires_at` datetime(3),
	`recovery_set_id` char(26),
	`recovery_acknowledged_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `assurance_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `assurance_accounts_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `uq_assurance_accounts_user` UNIQUE(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `assurance_challenges` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`session_id` char(26) NOT NULL,
	`purpose` enum('challenge','step_up','register','recovery_reissue') NOT NULL,
	`challenge_hash` varchar(128) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `assurance_challenges_id` PRIMARY KEY(`id`),
	CONSTRAINT `assurance_challenges_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `uq_assurance_challenge_session_purpose` UNIQUE(`user_id`,`session_id`,`purpose`)
);
--> statement-breakpoint
CREATE TABLE `assurance_passkeys` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`credential_id` varchar(1400) NOT NULL,
	`credential_index` char(64) NOT NULL,
	`public_key` text NOT NULL,
	`counter` int unsigned NOT NULL,
	`name_enc` text NOT NULL,
	`last_used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `assurance_passkeys_id` PRIMARY KEY(`id`),
	CONSTRAINT `assurance_passkeys_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `uq_assurance_passkey_credential` UNIQUE(`credential_index`)
);
--> statement-breakpoint
CREATE TABLE `assurance_recovery_codes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`code_hash` varchar(128) NOT NULL,
	`used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `assurance_recovery_codes_id` PRIMARY KEY(`id`),
	CONSTRAINT `assurance_recovery_codes_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `uq_assurance_recovery_user_hash` UNIQUE(`user_id`,`code_hash`)
);
--> statement-breakpoint
CREATE TABLE `catalog_groups` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` varchar(1000) NOT NULL DEFAULT '',
	`sort_order` int NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `catalog_groups_id` PRIMARY KEY(`id`),
	CONSTRAINT `catalog_groups_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `catalog_product_versions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`product_id` bigint unsigned NOT NULL,
	`version_number` int unsigned NOT NULL,
	`name` varchar(160) NOT NULL,
	`description` varchar(2000) NOT NULL DEFAULT '',
	`features` json NOT NULL,
	`price_minor` bigint NOT NULL,
	`currency` char(3) NOT NULL,
	`created_by_user_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `catalog_product_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `catalog_product_versions_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `catalog_product_versions_uq` UNIQUE(`product_id`,`version_number`)
);
--> statement-breakpoint
CREATE TABLE `catalog_products` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`group_id` bigint unsigned NOT NULL,
	`product_key` varchar(64) NOT NULL,
	`current_version_id` bigint unsigned,
	`sort_order` int NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `catalog_products_id` PRIMARY KEY(`id`),
	CONSTRAINT `catalog_products_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `catalog_products_key_uq` UNIQUE(`product_key`)
);
--> statement-breakpoint
CREATE TABLE `order_grants` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`invitee_email_index` char(64) NOT NULL,
	`invitee_email_enc` text NOT NULL,
	`grantee_user_id` bigint unsigned,
	`role` enum('viewer','contributor') NOT NULL,
	`status` enum('pending','active','declined','revoked') NOT NULL DEFAULT 'pending',
	`live_key` varchar(96),
	`granted_by_user_id` bigint unsigned,
	`accepted_at` datetime(3),
	`ended_at` datetime(3),
	`ended_by_user_id` bigint unsigned,
	`end_reason_code` varchar(48),
	`expires_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_grants_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_grants_live_uq` UNIQUE(`live_key`)
);
--> statement-breakpoint
CREATE TABLE `order_import_provenance` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`import_id` varchar(64) NOT NULL,
	`source_installation_id` varchar(64) NOT NULL,
	`source_order_public_id` varchar(64) NOT NULL,
	`source_reference` varchar(64),
	`source_status_key` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_import_provenance_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_import_provenance_source_uq` UNIQUE(`source_installation_id`,`source_order_public_id`)
);
--> statement-breakpoint
CREATE TABLE `order_line_items` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`product_id` bigint unsigned,
	`product_version_id` bigint unsigned,
	`product_public_id` char(26),
	`product_version_number` int unsigned,
	`name` varchar(160) NOT NULL,
	`description` varchar(2000) NOT NULL DEFAULT '',
	`features` json NOT NULL,
	`unit_price_minor` bigint NOT NULL,
	`currency` char(3) NOT NULL,
	`quantity` int unsigned NOT NULL,
	`line_total_minor` bigint NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_line_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_line_items_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `order_lock_history` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`from_state` enum('none','review','finalized','legal_hold','imported_read_only') NOT NULL,
	`to_state` enum('none','review','finalized','legal_hold','imported_read_only') NOT NULL,
	`reason_code` varchar(48) NOT NULL,
	`actor_user_id` bigint unsigned,
	`occurred_at` datetime(3) NOT NULL,
	CONSTRAINT `order_lock_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `order_notes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`author_user_id` bigint unsigned,
	`author_role` varchar(16) NOT NULL,
	`visibility` enum('customer','internal') NOT NULL,
	`body_enc` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_notes_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_notes_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `order_reassignments` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`operation_id` varchar(64) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`from_user_id` bigint unsigned NOT NULL,
	`to_user_id` bigint unsigned NOT NULL,
	`actor_user_id` bigint unsigned,
	`reason_code` varchar(48) NOT NULL,
	`revoked_grants` int unsigned NOT NULL,
	`occurred_at` datetime(3) NOT NULL,
	CONSTRAINT `order_reassignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_reassignments_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_reassignments_operation_uq` UNIQUE(`operation_id`)
);
--> statement-breakpoint
CREATE TABLE `order_reference_counters` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`scope` varchar(16) NOT NULL,
	`next_value` int unsigned NOT NULL,
	CONSTRAINT `order_reference_counters_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_reference_counters_scope_unique` UNIQUE(`scope`)
);
--> statement-breakpoint
CREATE TABLE `order_references` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`reference` varchar(32) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`status` enum('active','retired') NOT NULL,
	`reason_code` varchar(48) NOT NULL,
	`actor_user_id` bigint unsigned,
	`assigned_at` datetime(3) NOT NULL,
	`retired_at` datetime(3),
	CONSTRAINT `order_references_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_references_reference_uq` UNIQUE(`reference`)
);
--> statement-breakpoint
CREATE TABLE `order_status_history` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`from_status` varchar(48),
	`to_status` varchar(48) NOT NULL,
	`actor_user_id` bigint unsigned,
	`actor_role` varchar(16) NOT NULL,
	`reason_code` varchar(48) NOT NULL DEFAULT 'TRANSITION',
	`note_id` bigint unsigned,
	`occurred_at` datetime(3) NOT NULL,
	CONSTRAINT `order_status_history_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_status_history_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `order_workflow_versions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`workflow_id` bigint unsigned NOT NULL,
	`version_number` int unsigned NOT NULL,
	`definition` json NOT NULL,
	`created_by_user_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_workflow_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_workflow_versions_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_workflow_versions_uq` UNIQUE(`workflow_id`,`version_number`)
);
--> statement-breakpoint
CREATE TABLE `order_workflows` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`workflow_key` varchar(64) NOT NULL,
	`name` varchar(120) NOT NULL,
	`current_version_id` bigint unsigned,
	`is_default` boolean NOT NULL DEFAULT false,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_workflows_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_workflows_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_workflows_key_uq` UNIQUE(`workflow_key`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`reference` varchar(32) NOT NULL,
	`owner_user_id` bigint unsigned NOT NULL,
	`project_name` varchar(160) NOT NULL,
	`workflow_version_id` bigint unsigned NOT NULL,
	`status_key` varchar(48) NOT NULL,
	`lock_state` enum('none','review','finalized','legal_hold','imported_read_only') NOT NULL DEFAULT 'none',
	`lock_reason_code` varchar(48),
	`locked_at` datetime(3),
	`total_minor` bigint NOT NULL,
	`currency` char(3) NOT NULL,
	`origin` enum('portal','import') NOT NULL DEFAULT 'portal',
	`created_by_user_id` bigint unsigned,
	`create_key` varchar(80),
	`submitted_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `orders_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `orders_reference_uq` UNIQUE(`reference`),
	CONSTRAINT `orders_create_key_uq` UNIQUE(`owner_user_id`,`create_key`)
);
--> statement-breakpoint
CREATE TABLE `file_access_log` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`file_public_id` char(26),
	`user_id` bigint unsigned,
	`request_id` char(26),
	`trace_id` char(32),
	`correlation_id` varchar(64),
	`outcome` enum('attempted','completed','failed','denied','unknown') NOT NULL,
	`reason_code` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `file_access_log_id` PRIMARY KEY(`id`),
	CONSTRAINT `file_access_log_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `file_download_tickets` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`token_hash` char(64) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`file_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`session_id` varchar(80) NOT NULL,
	`issued_at` datetime(3) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `file_download_tickets_id` PRIMARY KEY(`id`),
	CONSTRAINT `file_download_tickets_hash_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `order_files` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`logical_public_id` char(26) NOT NULL,
	`previous_version_id` bigint unsigned,
	`order_id` bigint unsigned NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`owner_user_id` bigint unsigned NOT NULL,
	`phase_public_id` char(26),
	`status_key` varchar(64),
	`uploaded_by_user_id` bigint unsigned NOT NULL,
	`storage_key` varchar(48) NOT NULL,
	`display_name_enc` text NOT NULL,
	`category` enum('supporting','intake_attachment','deliverable') NOT NULL,
	`visibility` enum('customer_visible','staff_only') NOT NULL,
	`byte_size` bigint unsigned NOT NULL,
	`sha256` char(64) NOT NULL,
	`content_type` varchar(80) NOT NULL,
	`extension` varchar(16) NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`superseded_at` datetime(3),
	`deleted_at` datetime(3),
	`purge_after` datetime(3),
	`purged_at` datetime(3),
	CONSTRAINT `order_files_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_files_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `order_files_storage_key_uq` UNIQUE(`storage_key`),
	CONSTRAINT `order_files_logical_version_uq` UNIQUE(`logical_public_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `engagement_import_provenance` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`entity_type` enum('order_message','ticket','ticket_message') NOT NULL,
	`source_installation_id` varchar(64) NOT NULL,
	`source_public_id` char(26) NOT NULL,
	`source_reference` varchar(64),
	`target_id` bigint unsigned NOT NULL,
	`target_public_id` char(26) NOT NULL,
	`import_id` varchar(64) NOT NULL,
	`imported_at` datetime(3) NOT NULL,
	CONSTRAINT `engagement_import_provenance_id` PRIMARY KEY(`id`),
	CONSTRAINT `eng_imp_prov_src_uq` UNIQUE(`entity_type`,`source_installation_id`,`source_public_id`)
);
--> statement-breakpoint
CREATE TABLE `engagement_notification_preferences` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`category` enum('security','order','message','ticket','file','invoice','compliance','system') NOT NULL,
	`in_app` boolean NOT NULL DEFAULT true,
	`email` boolean NOT NULL DEFAULT false,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `engagement_notification_preferences_id` PRIMARY KEY(`id`),
	CONSTRAINT `eng_notif_pref_user_cat_uq` UNIQUE(`user_id`,`category`)
);
--> statement-breakpoint
CREATE TABLE `engagement_notifications` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`kind` varchar(64) NOT NULL,
	`category` enum('security','order','message','ticket','file','invoice','compliance','system') NOT NULL,
	`title` varchar(160) NOT NULL,
	`body` varchar(500) NOT NULL,
	`link` varchar(255),
	`read_at` datetime(3),
	`idempotency_key` varchar(128),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `engagement_notifications_id` PRIMARY KEY(`id`),
	CONSTRAINT `engagement_notifications_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `eng_notif_idem_uq` UNIQUE(`user_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `engagement_order_message_attachments` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`message_id` bigint unsigned NOT NULL,
	`file_public_id` char(26) NOT NULL,
	`sort_order` int unsigned NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `engagement_order_message_attachments_id` PRIMARY KEY(`id`),
	CONSTRAINT `eng_msg_att_msg_file_uq` UNIQUE(`message_id`,`file_public_id`)
);
--> statement-breakpoint
CREATE TABLE `engagement_order_message_reads` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`message_id` bigint unsigned NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`read_at` datetime(3) NOT NULL,
	CONSTRAINT `engagement_order_message_reads_id` PRIMARY KEY(`id`),
	CONSTRAINT `eng_msg_reads_msg_user_uq` UNIQUE(`message_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `engagement_order_messages` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`order_reference` varchar(64) NOT NULL,
	`author_user_id` bigint unsigned NOT NULL,
	`author_user_public_id` char(26) NOT NULL,
	`author_role` enum('admin','staff','customer') NOT NULL,
	`visibility` enum('customer','internal') NOT NULL DEFAULT 'customer',
	`body_enc` text NOT NULL,
	`idempotency_key` varchar(128),
	`origin` enum('portal','import') NOT NULL DEFAULT 'portal',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `engagement_order_messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `engagement_order_messages_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `eng_order_msg_idem_uq` UNIQUE(`author_user_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `engagement_search_tokens` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`domain` enum('order_message','ticket') NOT NULL,
	`record_id` bigint unsigned NOT NULL,
	`customer_visible` boolean NOT NULL DEFAULT true,
	`token_hash` char(64) NOT NULL,
	CONSTRAINT `engagement_search_tokens_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `engagement_support_ticket_history` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`ticket_id` bigint unsigned NOT NULL,
	`actor_user_id` bigint unsigned,
	`actor_role` varchar(16) NOT NULL,
	`from_status` enum('open','pending_customer','pending_staff','resolved','closed'),
	`to_status` enum('open','pending_customer','pending_staff','resolved','closed') NOT NULL,
	`reason_code` varchar(64),
	`occurred_at` datetime(3) NOT NULL,
	CONSTRAINT `engagement_support_ticket_history_id` PRIMARY KEY(`id`),
	CONSTRAINT `engagement_support_ticket_history_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `engagement_support_ticket_messages` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`ticket_id` bigint unsigned NOT NULL,
	`author_user_id` bigint unsigned NOT NULL,
	`author_user_public_id` char(26) NOT NULL,
	`author_role` enum('admin','staff','customer') NOT NULL,
	`internal_only` boolean NOT NULL DEFAULT false,
	`body_enc` text NOT NULL,
	`idempotency_key` varchar(128),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `engagement_support_ticket_messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `engagement_support_ticket_messages_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `eng_ticket_msg_idem_uq` UNIQUE(`ticket_id`,`author_user_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `engagement_support_tickets` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`ticket_number` varchar(32) NOT NULL,
	`requester_user_id` bigint unsigned NOT NULL,
	`requester_user_public_id` char(26) NOT NULL,
	`related_order_id` bigint unsigned,
	`related_order_public_id` char(26),
	`related_order_reference` varchar(64),
	`assignee_user_id` bigint unsigned,
	`assignee_user_public_id` char(26),
	`category` enum('general','order','billing','technical','deliverable','account') NOT NULL DEFAULT 'general',
	`status` enum('open','pending_customer','pending_staff','resolved','closed') NOT NULL DEFAULT 'open',
	`priority` enum('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
	`subject_enc` text NOT NULL,
	`idempotency_key` varchar(128),
	`origin` enum('portal','import') NOT NULL DEFAULT 'portal',
	`last_message_at` datetime(3) NOT NULL,
	`resolved_at` datetime(3),
	`closed_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `engagement_support_tickets_id` PRIMARY KEY(`id`),
	CONSTRAINT `engagement_support_tickets_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `eng_tickets_number_uq` UNIQUE(`ticket_number`),
	CONSTRAINT `eng_tickets_idem_uq` UNIQUE(`requester_user_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `compliance_invoice_lines` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`invoice_id` bigint unsigned NOT NULL,
	`position` int unsigned NOT NULL,
	`description` varchar(240) NOT NULL,
	`quantity` int unsigned NOT NULL,
	`unit_amount_minor` bigint NOT NULL,
	`line_total_minor` bigint NOT NULL,
	CONSTRAINT `compliance_invoice_lines_id` PRIMARY KEY(`id`),
	CONSTRAINT `compliance_invoice_lines_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cmp_inv_line_inv_pos_uq` UNIQUE(`invoice_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `compliance_invoice_payments` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`invoice_id` bigint unsigned NOT NULL,
	`method` enum('bank_transfer','wire','ach','check','card_manual','waiver','provider_online','imported_historical','other') NOT NULL,
	`status` enum('succeeded','failed') NOT NULL DEFAULT 'succeeded',
	`amount_minor` bigint NOT NULL,
	`currency` char(3) NOT NULL,
	`reference` varchar(128) NOT NULL,
	`notes_enc` text,
	`received_at` datetime(3) NOT NULL,
	`recorded_by_user_id` bigint unsigned,
	`idempotency_key` varchar(128) NOT NULL,
	`provider` varchar(32),
	`provider_event_id` varchar(128),
	`origin` enum('portal','import') NOT NULL DEFAULT 'portal',
	`import_id` varchar(64),
	`source_installation_id` varchar(128),
	`source_public_id` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `compliance_invoice_payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `compliance_invoice_payments_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cmp_pmt_idemp_uq` UNIQUE(`invoice_id`,`idempotency_key`),
	CONSTRAINT `cmp_pmt_prov_evt_uq` UNIQUE(`provider`,`provider_event_id`),
	CONSTRAINT `cmp_pmt_imp_uq` UNIQUE(`source_installation_id`,`source_public_id`)
);
--> statement-breakpoint
CREATE TABLE `compliance_invoice_refunds` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`invoice_id` bigint unsigned NOT NULL,
	`payment_id` bigint unsigned NOT NULL,
	`amount_minor` bigint NOT NULL,
	`currency` char(3) NOT NULL,
	`reason_code` varchar(64) NOT NULL,
	`reference` varchar(128) NOT NULL,
	`notes_enc` text,
	`refunded_at` datetime(3) NOT NULL,
	`recorded_by_user_id` bigint unsigned,
	`idempotency_key` varchar(128) NOT NULL,
	`provider` varchar(32),
	`provider_event_id` varchar(128),
	`origin` enum('portal','import') NOT NULL DEFAULT 'portal',
	`import_id` varchar(64),
	`source_installation_id` varchar(128),
	`source_public_id` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `compliance_invoice_refunds_id` PRIMARY KEY(`id`),
	CONSTRAINT `compliance_invoice_refunds_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cmp_rfd_idemp_uq` UNIQUE(`invoice_id`,`idempotency_key`),
	CONSTRAINT `cmp_rfd_prov_evt_uq` UNIQUE(`provider`,`provider_event_id`),
	CONSTRAINT `cmp_rfd_imp_uq` UNIQUE(`source_installation_id`,`source_public_id`)
);
--> statement-breakpoint
CREATE TABLE `compliance_invoices` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`sequence_number` int unsigned,
	`invoice_number` varchar(48),
	`status` enum('draft','issued','paid','void') NOT NULL DEFAULT 'draft',
	`currency` char(3) NOT NULL,
	`subtotal_minor` bigint NOT NULL,
	`discount_minor` bigint NOT NULL DEFAULT 0,
	`tax_minor` bigint NOT NULL DEFAULT 0,
	`total_minor` bigint NOT NULL,
	`issued_at` datetime(3),
	`due_at` datetime(3),
	`voided_at` datetime(3),
	`void_reason` varchar(500),
	`memo` varchar(1000),
	`issuer_name_snapshot` varchar(160),
	`issuer_address_snapshot` varchar(500),
	`created_by_user_id` bigint unsigned,
	`issued_by_user_id` bigint unsigned,
	`voided_by_user_id` bigint unsigned,
	`origin` enum('portal','import') NOT NULL DEFAULT 'portal',
	`import_id` varchar(64),
	`source_installation_id` varchar(128),
	`source_public_id` varchar(64),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `compliance_invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `compliance_invoices_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cmp_inv_number_uq` UNIQUE(`invoice_number`),
	CONSTRAINT `cmp_inv_imp_uq` UNIQUE(`source_installation_id`,`source_public_id`)
);
--> statement-breakpoint
CREATE TABLE `compliance_provider_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`provider` varchar(32) NOT NULL,
	`provider_event_id` varchar(128) NOT NULL,
	`invoice_id` bigint unsigned,
	`payment_public_id` char(26),
	`refund_public_id` char(26),
	`processed_at` datetime(3) NOT NULL,
	CONSTRAINT `compliance_provider_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `cmp_pevt_prov_evt_uq` UNIQUE(`provider`,`provider_event_id`)
);
--> statement-breakpoint
CREATE TABLE `compliance_sequences` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`seq_key` varchar(32) NOT NULL,
	`next_val` int unsigned NOT NULL DEFAULT 1,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `compliance_sequences_id` PRIMARY KEY(`id`),
	CONSTRAINT `cmp_seq_key_uq` UNIQUE(`seq_key`)
);
--> statement-breakpoint
CREATE TABLE `intake_questionnaire_versions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`questionnaire_id` bigint unsigned NOT NULL,
	`version_number` int unsigned NOT NULL,
	`status` enum('draft','published') NOT NULL DEFAULT 'draft',
	`fields_json` json NOT NULL,
	`schema_hash` char(64) NOT NULL,
	`published_at` datetime(3),
	`published_by_user_id` bigint unsigned,
	`origin` enum('portal','import') NOT NULL DEFAULT 'portal',
	`import_id` varchar(64),
	`source_installation_id` varchar(128),
	`source_public_id` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `intake_questionnaire_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `intake_questionnaire_versions_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cmp_iqv_qid_num_uq` UNIQUE(`questionnaire_id`,`version_number`),
	CONSTRAINT `cmp_iqv_imp_uq` UNIQUE(`source_installation_id`,`source_public_id`)
);
--> statement-breakpoint
CREATE TABLE `intake_questionnaires` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`slug` varchar(64) NOT NULL,
	`title` varchar(160) NOT NULL,
	`description` varchar(1000),
	`scope_kind` enum('default','catalog_item','workflow') NOT NULL DEFAULT 'default',
	`scope_ref` varchar(64),
	`active` boolean NOT NULL DEFAULT true,
	`current_published_version_id` bigint unsigned,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `intake_questionnaires_id` PRIMARY KEY(`id`),
	CONSTRAINT `intake_questionnaires_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cmp_int_q_slug_uq` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `intake_submission_revisions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`submission_id` bigint unsigned NOT NULL,
	`revision_number` int unsigned NOT NULL,
	`event_kind` enum('draft_saved','submitted','returned_for_changes','accepted','imported') NOT NULL,
	`actor_user_id` bigint unsigned,
	`actor_role` enum('customer','staff','admin','system') NOT NULL,
	`answers_enc` mediumtext NOT NULL,
	`note_enc` text,
	`occurred_at` datetime(3) NOT NULL,
	CONSTRAINT `intake_submission_revisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `intake_submission_revisions_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cmp_irev_sub_rev_uq` UNIQUE(`submission_id`,`revision_number`)
);
--> statement-breakpoint
CREATE TABLE `intake_submissions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`order_id` bigint unsigned NOT NULL,
	`order_public_id` char(26) NOT NULL,
	`questionnaire_id` bigint unsigned NOT NULL,
	`questionnaire_version_id` bigint unsigned NOT NULL,
	`status` enum('draft','submitted','returned_for_changes','accepted') NOT NULL DEFAULT 'draft',
	`revision_number` int unsigned NOT NULL DEFAULT 1,
	`current_answers_enc` mediumtext NOT NULL,
	`submitted_at` datetime(3),
	`submitted_by_user_id` bigint unsigned,
	`reviewed_at` datetime(3),
	`reviewed_by_user_id` bigint unsigned,
	`origin` enum('portal','import') NOT NULL DEFAULT 'portal',
	`import_id` varchar(64),
	`source_installation_id` varchar(128),
	`source_public_id` varchar(64),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `intake_submissions_id` PRIMARY KEY(`id`),
	CONSTRAINT `intake_submissions_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cmp_isub_order_q_uq` UNIQUE(`order_id`,`questionnaire_id`),
	CONSTRAINT `cmp_isub_imp_uq` UNIQUE(`source_installation_id`,`source_public_id`)
);
--> statement-breakpoint
CREATE TABLE `policy_acceptances` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`document_id` bigint unsigned NOT NULL,
	`policy_version_id` bigint unsigned NOT NULL,
	`version_content_hash` char(64) NOT NULL,
	`accepted_at` datetime(3) NOT NULL,
	`request_id` varchar(64) NOT NULL,
	`source_address_pseudonym` varchar(64),
	`method` enum('portal_checkbox','registration','typed_signature','imported_historical') NOT NULL,
	`signer_name_enc` text,
	`order_id` bigint unsigned,
	`order_public_id` char(26),
	`origin` enum('portal','import') NOT NULL DEFAULT 'portal',
	`import_id` varchar(64),
	`source_installation_id` varchar(128),
	`source_public_id` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `policy_acceptances_id` PRIMARY KEY(`id`),
	CONSTRAINT `policy_acceptances_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cmp_pol_acc_usr_ver_orig_uq` UNIQUE(`user_id`,`policy_version_id`,`origin`),
	CONSTRAINT `cmp_pol_acc_imp_uq` UNIQUE(`source_installation_id`,`source_public_id`)
);
--> statement-breakpoint
CREATE TABLE `policy_documents` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`slug` varchar(64) NOT NULL,
	`title` varchar(160) NOT NULL,
	`audience` enum('all','customer','staff') NOT NULL DEFAULT 'customer',
	`requires_acceptance` boolean NOT NULL DEFAULT true,
	`requires_typed_signature` boolean NOT NULL DEFAULT false,
	`active` boolean NOT NULL DEFAULT true,
	`current_published_version_id` bigint unsigned,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `policy_documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `policy_documents_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cmp_pol_docs_slug_uq` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `policy_versions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`document_id` bigint unsigned NOT NULL,
	`version_number` int unsigned NOT NULL,
	`version_label` varchar(32) NOT NULL,
	`status` enum('draft','published') NOT NULL DEFAULT 'draft',
	`content_format` enum('plain_text','safe_markdown') NOT NULL DEFAULT 'safe_markdown',
	`body_text` mediumtext NOT NULL,
	`content_hash` char(64) NOT NULL,
	`change_summary` varchar(500),
	`effective_at` datetime(3) NOT NULL,
	`published_at` datetime(3),
	`published_by_user_id` bigint unsigned,
	`origin` enum('portal','import') NOT NULL DEFAULT 'portal',
	`import_id` varchar(64),
	`source_installation_id` varchar(128),
	`source_public_id` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `policy_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `policy_versions_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `cmp_pol_ver_doc_num_uq` UNIQUE(`document_id`,`version_number`),
	CONSTRAINT `cmp_pol_ver_doc_lbl_uq` UNIQUE(`document_id`,`version_label`),
	CONSTRAINT `cmp_pol_ver_imp_uq` UNIQUE(`source_installation_id`,`source_public_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_case_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`case_id` bigint unsigned NOT NULL,
	`event_id` char(26) NOT NULL,
	`added_by` bigint unsigned NOT NULL,
	`added_at` datetime(3) NOT NULL,
	CONSTRAINT `audit_case_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `ux_audit_case_event` UNIQUE(`case_id`,`event_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_case_notes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`case_id` bigint unsigned NOT NULL,
	`author_user_id` bigint unsigned NOT NULL,
	`body_enc` text NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `audit_case_notes_id` PRIMARY KEY(`id`),
	CONSTRAINT `audit_case_notes_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_cases` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`title_enc` text NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'open',
	`severity` varchar(8) NOT NULL DEFAULT 'WARN',
	`created_by` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`closed_at` datetime(3),
	CONSTRAINT `audit_cases_id` PRIMARY KEY(`id`),
	CONSTRAINT `audit_cases_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_chain` (
	`seq` bigint unsigned NOT NULL,
	`event_row_id` bigint unsigned NOT NULL,
	`event_id` char(26) NOT NULL,
	`event_digest` char(64) NOT NULL,
	`prev_hash` char(64) NOT NULL,
	`link_hash` char(64) NOT NULL,
	`key_ref` char(16) NOT NULL,
	`sealed_at` datetime(3) NOT NULL,
	CONSTRAINT `audit_chain_seq` PRIMARY KEY(`seq`),
	CONSTRAINT `ux_audit_chain_event_row` UNIQUE(`event_row_id`),
	CONSTRAINT `ux_audit_chain_event_id` UNIQUE(`event_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_chain_head` (
	`id` tinyint unsigned NOT NULL,
	`head_seq` bigint unsigned NOT NULL DEFAULT 0,
	`head_hash` char(64) NOT NULL,
	`key_ref` char(16),
	`scan_watermark` bigint unsigned NOT NULL DEFAULT 0,
	`watermark_candidate_id` bigint unsigned NOT NULL DEFAULT 0,
	`watermark_candidate_at` datetime(3),
	`last_sealed_at` datetime(3),
	`last_verified_at` datetime(3),
	`last_verify_ok` boolean,
	`last_verify_break_seq` bigint unsigned,
	CONSTRAINT `audit_chain_head_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_checkpoints` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`seq` bigint unsigned NOT NULL,
	`head_hash` char(64) NOT NULL,
	`installation_ref` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`signed_at` datetime(3) NOT NULL,
	`algorithm` varchar(16) NOT NULL,
	`key_ref` char(16) NOT NULL,
	`public_key` varchar(128) NOT NULL,
	`signature` varchar(128) NOT NULL,
	`reason` varchar(24) NOT NULL,
	CONSTRAINT `audit_checkpoints_id` PRIMARY KEY(`id`),
	CONSTRAINT `audit_checkpoints_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`event_id` char(26) NOT NULL,
	`schema_version` varchar(16) NOT NULL,
	`occurred_at` datetime(3) NOT NULL,
	`observed_at` datetime(3) NOT NULL,
	`severity_text` varchar(8) NOT NULL,
	`severity_number` tinyint unsigned NOT NULL,
	`category` varchar(24) NOT NULL,
	`event_name` varchar(96) NOT NULL,
	`action` varchar(32) NOT NULL,
	`outcome` varchar(12) NOT NULL,
	`reason_code` varchar(64),
	`durability` varchar(12) NOT NULL,
	`actor_user_id` bigint unsigned,
	`actor_ref` char(32),
	`actor_role` varchar(12) NOT NULL,
	`session_ref` char(32),
	`resource_type` varchar(48),
	`resource_public_id` varchar(64),
	`resource_ref` char(32),
	`request_id` varchar(64),
	`trace_id` char(32),
	`span_id` char(16),
	`correlation_id` varchar(64),
	`parent_correlation_id` varchar(64),
	`job_id` varchar(64),
	`package_id` varchar(64),
	`import_id` varchar(64),
	`delivery_id` varchar(64),
	`provider` varchar(32),
	`duration_ms` int unsigned,
	`origin` varchar(12) NOT NULL,
	`service` varchar(40) NOT NULL,
	`installation_ref` varchar(64) NOT NULL,
	`release_ref` varchar(80) NOT NULL,
	`deployment_profile` varchar(16) NOT NULL,
	`source_address_class` varchar(12) NOT NULL,
	`source_address_ref` char(32),
	`source_address_enc` varchar(255),
	`safe_counts` json NOT NULL,
	`attributes` json NOT NULL,
	`dropped_attributes` smallint unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `audit_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `ux_audit_event_id` UNIQUE(`event_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_exports` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`requested_by` bigint unsigned NOT NULL,
	`format` varchar(8) NOT NULL,
	`query` json NOT NULL,
	`status` varchar(12) NOT NULL DEFAULT 'queued',
	`reason_code` varchar(64),
	`job_id` varchar(64),
	`object_key` varchar(200),
	`row_count` int unsigned,
	`byte_size` bigint unsigned,
	`sha256` char(64),
	`manifest` json,
	`truncated` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`completed_at` datetime(3),
	`expires_at` datetime(3),
	`download_count` int unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `audit_exports_id` PRIMARY KEY(`id`),
	CONSTRAINT `audit_exports_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_legal_holds` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`label_enc` text NOT NULL,
	`categories` json,
	`from_at` datetime(3) NOT NULL,
	`to_at` datetime(3) NOT NULL,
	`created_by` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`released_at` datetime(3),
	`released_by` bigint unsigned,
	CONSTRAINT `audit_legal_holds_id` PRIMARY KEY(`id`),
	CONSTRAINT `audit_legal_holds_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_retention_policies` (
	`category` varchar(24) NOT NULL,
	`retain_days` int unsigned NOT NULL,
	`updated_by` bigint unsigned NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `audit_retention_policies_category` PRIMARY KEY(`category`)
);
--> statement-breakpoint
CREATE TABLE `audit_retention_runs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`dry_run` boolean NOT NULL,
	`status` varchar(12) NOT NULL,
	`requested_by` bigint unsigned,
	`counts` json NOT NULL,
	`started_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	`checkpoint_public_id` char(26),
	CONSTRAINT `audit_retention_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `audit_retention_runs_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_saved_queries` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`owner_user_id` bigint unsigned NOT NULL,
	`name` varchar(80) NOT NULL,
	`shared` boolean NOT NULL DEFAULT false,
	`query` json NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `audit_saved_queries_id` PRIMARY KEY(`id`),
	CONSTRAINT `audit_saved_queries_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_tombstones` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`event_row_id` bigint unsigned NOT NULL,
	`event_id` char(26) NOT NULL,
	`seq` bigint unsigned NOT NULL,
	`event_digest` char(64) NOT NULL,
	`category` varchar(24) NOT NULL,
	`occurred_at` datetime(3) NOT NULL,
	`retention_run_id` char(26) NOT NULL,
	`removed_at` datetime(3) NOT NULL,
	`receipt` char(64) NOT NULL,
	CONSTRAINT `audit_tombstones_id` PRIMARY KEY(`id`),
	CONSTRAINT `ux_audit_tomb_event` UNIQUE(`event_id`),
	CONSTRAINT `ux_audit_tomb_seq` UNIQUE(`seq`)
);
--> statement-breakpoint
CREATE TABLE `siem_destinations` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`name` varchar(120) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`format` varchar(24) NOT NULL,
	`host` varchar(255) NOT NULL,
	`port` int unsigned NOT NULL DEFAULT 6514,
	`otlp_path` varchar(255),
	`allow_private_network` boolean NOT NULL DEFAULT false,
	`endpoint_generation` int unsigned NOT NULL DEFAULT 1,
	`facility` int unsigned NOT NULL DEFAULT 16,
	`app_name` varchar(48) NOT NULL DEFAULT 'readypackets',
	`hostname_override` varchar(255),
	`enterprise_number` int unsigned,
	`sd_id_name` varchar(16) NOT NULL DEFAULT 'rp',
	`include_bom` boolean NOT NULL DEFAULT true,
	`max_message_bytes` int unsigned NOT NULL DEFAULT 8192,
	`connect_timeout_ms` int unsigned NOT NULL DEFAULT 5000,
	`write_timeout_ms` int unsigned NOT NULL DEFAULT 10000,
	`min_severity` varchar(16) NOT NULL DEFAULT 'INFO',
	`categories_json` json NOT NULL,
	`auth_header_name` varchar(64),
	`ca_enc` mediumtext,
	`client_cert_enc` mediumtext,
	`client_key_enc` mediumtext,
	`auth_secret_enc` text,
	`has_custom_ca` boolean NOT NULL DEFAULT false,
	`has_client_cert` boolean NOT NULL DEFAULT false,
	`has_client_key` boolean NOT NULL DEFAULT false,
	`has_auth_secret` boolean NOT NULL DEFAULT false,
	`ca_cert_expires_at` datetime(3),
	`client_cert_expires_at` datetime(3),
	`secret_updated_at` datetime(3),
	`audit_cursor` varchar(255),
	`last_projected_seq` bigint unsigned NOT NULL DEFAULT 0,
	`last_cursor_progress_at` datetime(3),
	`pruned_audit_count` bigint unsigned NOT NULL DEFAULT 0,
	`missing_audit_gap_count` bigint unsigned NOT NULL DEFAULT 0,
	`circuit_state` varchar(16) NOT NULL DEFAULT 'closed',
	`consecutive_failures` int unsigned NOT NULL DEFAULT 0,
	`circuit_open_until` datetime(3),
	`last_attempt_at` datetime(3),
	`last_success_at` datetime(3),
	`last_failure_at` datetime(3),
	`last_failure_reason` varchar(64),
	`delivered_count` bigint unsigned NOT NULL DEFAULT 0,
	`failed_attempt_count` bigint unsigned NOT NULL DEFAULT 0,
	`dead_lettered_count` bigint unsigned NOT NULL DEFAULT 0,
	`uncertain_count` bigint unsigned NOT NULL DEFAULT 0,
	`last_test_at` datetime(3),
	`last_test_outcome` varchar(16),
	`last_test_reason` varchar(64),
	`receipt_confirmation` varchar(24) NOT NULL DEFAULT 'none',
	`lease_owner_job_id` varchar(64),
	`lease_expires_at` datetime(3),
	`last_fencing_token` bigint unsigned NOT NULL DEFAULT 0,
	`created_by_user_id` bigint unsigned,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `siem_destinations_id` PRIMARY KEY(`id`),
	CONSTRAINT `siem_destinations_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `siem_destinations_name_uq` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `siem_outbox` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`destination_id` bigint unsigned NOT NULL,
	`destination_version` int unsigned NOT NULL,
	`endpoint_generation` int unsigned NOT NULL DEFAULT 1,
	`event_id` varchar(64) NOT NULL,
	`chain_seq` bigint unsigned,
	`event_occurred_at` datetime(3) NOT NULL,
	`category` varchar(32) NOT NULL,
	`severity` varchar(16) NOT NULL,
	`event_name` varchar(96) NOT NULL,
	`projected_json` json NOT NULL,
	`state` varchar(16) NOT NULL DEFAULT 'queued',
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`max_attempts` int unsigned NOT NULL DEFAULT 8,
	`uncertain_delivery` boolean NOT NULL DEFAULT false,
	`next_attempt_at` datetime(3) NOT NULL,
	`last_attempt_at` datetime(3),
	`last_reason_code` varchar(64),
	`dead_lettered_at` datetime(3),
	`correlation_id` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `siem_outbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `siem_outbox_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `siem_outbox_dest_event_uq` UNIQUE(`destination_id`,`event_id`)
);
--> statement-breakpoint
CREATE TABLE `platform_presentation_images` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`storage_key` varchar(128) NOT NULL,
	`mime_type` varchar(16) NOT NULL,
	`byte_size` int unsigned NOT NULL,
	`sha256` char(64) NOT NULL,
	`width` int unsigned NOT NULL,
	`height` int unsigned NOT NULL,
	`uploaded_by_user_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`object_purged_at` datetime(3),
	CONSTRAINT `platform_presentation_images_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_presentation_images_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `platform_presentation_images_storage_key_uq` UNIQUE(`storage_key`)
);
--> statement-breakpoint
CREATE TABLE `platform_reencrypt_checkpoints` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`target` varchar(96) NOT NULL,
	`target_key_id` varchar(32) NOT NULL,
	`last_id` bigint unsigned NOT NULL DEFAULT 0,
	`rewritten` int unsigned NOT NULL DEFAULT 0,
	`skipped` int unsigned NOT NULL DEFAULT 0,
	`failed` int unsigned NOT NULL DEFAULT 0,
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `platform_reencrypt_checkpoints_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_reencrypt_target_uq` UNIQUE(`target`,`target_key_id`)
);
--> statement-breakpoint
CREATE TABLE `platform_settings` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`setting_key` varchar(96) NOT NULL,
	`kind` varchar(8) NOT NULL,
	`value_json` json,
	`secret_enc` text,
	`version` int unsigned NOT NULL DEFAULT 1,
	`updated_by_user_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `platform_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_settings_key_uq` UNIQUE(`setting_key`)
);
--> statement-breakpoint
CREATE TABLE `job_attempts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`job_id` bigint unsigned NOT NULL,
	`attempt` int unsigned NOT NULL,
	`fencing_token` bigint unsigned NOT NULL,
	`state` enum('running','completed','failed','canceled','unknown','interrupted') NOT NULL,
	`reason_code` varchar(64),
	`safe_counts` json,
	`started_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	CONSTRAINT `job_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `job_attempts_fence_uq` UNIQUE(`job_id`,`fencing_token`)
);
--> statement-breakpoint
CREATE TABLE `job_maintenance` (
	`id` int unsigned NOT NULL,
	`active` boolean NOT NULL DEFAULT false,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `job_maintenance_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`type` varchar(100) NOT NULL,
	`idempotency_hash` char(64),
	`payload_enc` mediumtext,
	`state` enum('queued','running','completed','failed','canceled','unknown') NOT NULL DEFAULT 'queued',
	`correlation_id` varchar(64) NOT NULL,
	`attempt` int unsigned NOT NULL DEFAULT 0,
	`max_attempts` int unsigned NOT NULL,
	`retry_safe` boolean NOT NULL DEFAULT false,
	`allow_retry` boolean NOT NULL DEFAULT false,
	`interruption_pending` boolean NOT NULL DEFAULT false,
	`reconciled_at` datetime(3),
	`reason_code` varchar(64),
	`run_at` datetime(3) NOT NULL,
	`lease_until` datetime(3),
	`fencing_token` bigint unsigned NOT NULL DEFAULT 0,
	`schedule_name` varchar(100),
	`schedule_slot` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `job_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `job_runs_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `job_runs_type_key_uq` UNIQUE(`type`,`idempotency_hash`),
	CONSTRAINT `job_runs_schedule_slot_uq` UNIQUE(`schedule_name`,`schedule_slot`)
);
--> statement-breakpoint
CREATE TABLE `mail_attempts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`mail_id` bigint unsigned NOT NULL,
	`generation` int unsigned NOT NULL,
	`state` enum('sending','accepted','held','captured','failed','unknown') NOT NULL,
	`reason_code` varchar(64),
	`started_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	CONSTRAINT `mail_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_attempts_generation_uq` UNIQUE(`mail_id`,`generation`)
);
--> statement-breakpoint
CREATE TABLE `mail_outbox` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`template` varchar(100) NOT NULL,
	`idempotency_hash` char(64) NOT NULL,
	`correlation_id` varchar(64) NOT NULL,
	`payload_enc` mediumtext,
	`capture_enc` mediumtext,
	`state` enum('queued','sending','accepted','held','captured','failed','expired','unknown','canceled') NOT NULL DEFAULT 'queued',
	`reason_code` varchar(64),
	`job_public_id` char(26),
	`generation` int unsigned NOT NULL DEFAULT 1,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `mail_outbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_outbox_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `mail_outbox_key_uq` UNIQUE(`idempotency_hash`)
);
--> statement-breakpoint
CREATE TABLE `portable_exports` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`requested_by` bigint unsigned NOT NULL,
	`requester_public_id` char(26) NOT NULL,
	`requester_session_id` varchar(128) NOT NULL,
	`state` enum('queued','running','completed','failed','canceled','refused','unknown') NOT NULL DEFAULT 'running',
	`selection` enum('all','customers','orders') NOT NULL,
	`storage_key` varchar(100) NOT NULL,
	`package_id` varchar(128),
	`manifest_sha256` char(64),
	`sha256` char(64),
	`size` bigint unsigned,
	`counts` json,
	`reason_code` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`expires_at` datetime(3) NOT NULL,
	`deleted_at` datetime(3),
	CONSTRAINT `portable_exports_id` PRIMARY KEY(`id`),
	CONSTRAINT `portable_exports_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `portable_import_objects` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`import_id` bigint unsigned NOT NULL,
	`sha256` char(64) NOT NULL,
	`size` bigint unsigned NOT NULL,
	`escrow_key` varchar(100) NOT NULL,
	`escrow_cipher_digest` char(64),
	`prepared_key` varchar(100) NOT NULL,
	`prepared_at` datetime(3),
	`reconciled_at` datetime(3),
	CONSTRAINT `portable_import_objects_id` PRIMARY KEY(`id`),
	CONSTRAINT `portable_import_object_digest_uq` UNIQUE(`import_id`,`sha256`)
);
--> statement-breakpoint
CREATE TABLE `portable_import_records` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`import_id` bigint unsigned NOT NULL,
	`portable_id` varchar(128) NOT NULL,
	`record_type` varchar(80) NOT NULL,
	`position` int unsigned NOT NULL,
	`disposition` enum('create','link','conflict','hold') NOT NULL,
	`reason_code` varchar(64),
	`digest` char(64) NOT NULL,
	`encrypted_payload` mediumtext NOT NULL,
	`receipt_at` datetime(3),
	`destination_key` varchar(100),
	`adoption_key` varchar(100),
	CONSTRAINT `portable_import_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `portable_import_record_ref_uq` UNIQUE(`import_id`,`record_type`,`portable_id`),
	CONSTRAINT `portable_import_record_position_uq` UNIQUE(`import_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `portable_import_steps` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`import_id` bigint unsigned NOT NULL,
	`from_phase` enum('received','quarantined','verified','planned','approved','objects-prepared','records-committed','finalized','reconciled','accepted','held-unknown','failed','canceled'),
	`to_phase` enum('received','quarantined','verified','planned','approved','objects-prepared','records-committed','finalized','reconciled','accepted','held-unknown','failed','canceled') NOT NULL,
	`input_sha256` char(64),
	`plan_digest` char(64),
	`installation_id` varchar(63) NOT NULL,
	`actor_user_id` bigint unsigned,
	`step_up_at` datetime(3),
	`job_id` varchar(128),
	`fence` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `portable_import_steps_id` PRIMARY KEY(`id`),
	CONSTRAINT `portable_import_steps_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `portable_steps_import_phase_uq` UNIQUE(`import_id`,`to_phase`)
);
--> statement-breakpoint
CREATE TABLE `portable_imports` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`submitted_by` bigint unsigned NOT NULL,
	`phase` enum('received','quarantined','verified','planned','approved','objects-prepared','records-committed','finalized','reconciled','accepted','held-unknown','failed','canceled') NOT NULL DEFAULT 'received',
	`state` enum('queued','running','completed','failed','canceled','refused','unknown') NOT NULL DEFAULT 'running',
	`version` int unsigned NOT NULL DEFAULT 1,
	`storage_key` varchar(100) NOT NULL,
	`input_sha256` char(64),
	`input_size` bigint unsigned,
	`encrypted_escrow_key` varchar(350),
	`package_id` varchar(128),
	`manifest_sha256` char(64),
	`source_system` varchar(128),
	`installation_id` varchar(63) NOT NULL,
	`plan_digest` char(64),
	`plan` json,
	`reconciliation` json,
	`reason_code` varchar(64),
	`approved_by` bigint unsigned,
	`approver_session_id` varchar(128),
	`approver_public_id` char(26),
	`approval_step_up_at` datetime(3),
	`plan_expires_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `portable_imports_id` PRIMARY KEY(`id`),
	CONSTRAINT `portable_imports_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `portable_mappings` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`package_id` varchar(128) NOT NULL,
	`source_portable_id` varchar(128) NOT NULL,
	`record_type` varchar(80) NOT NULL,
	`source_digest` char(64) NOT NULL,
	`local_id` bigint unsigned,
	`local_public_id` char(26),
	`original_import_id` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `portable_mappings_id` PRIMARY KEY(`id`),
	CONSTRAINT `portable_mapping_source_uq` UNIQUE(`package_id`,`record_type`,`source_portable_id`)
);
--> statement-breakpoint
CREATE TABLE `portable_package_reservations` (
	`package_id` varchar(128) NOT NULL,
	`manifest_sha256` char(64) NOT NULL,
	`import_id` bigint unsigned,
	CONSTRAINT `portable_package_reservations_package_id` PRIMARY KEY(`package_id`)
);
--> statement-breakpoint
CREATE TABLE `backup_archives` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`state` enum('queued','running','completed','failed','canceled','refused','unknown') NOT NULL DEFAULT 'queued',
	`reason_code` varchar(64),
	`trigger_kind` enum('manual','scheduled','pre_upgrade','cli') NOT NULL DEFAULT 'manual',
	`storage_key` varchar(64),
	`encrypted_size_bytes` bigint unsigned,
	`archive_sha256` char(64),
	`manifest_sha256` char(64),
	`backup_key_id` varchar(32),
	`key_custody_mode` enum('host_file','env_var','settings_secret'),
	`installation_id` varchar(64) NOT NULL,
	`release_ref` varchar(80) NOT NULL,
	`schema_migration_count` int unsigned,
	`last_migration_hash` varchar(128),
	`object_count` int unsigned,
	`object_total_bytes` bigint unsigned,
	`verification_status` enum('unverified','verified','failed') NOT NULL DEFAULT 'unverified',
	`last_verified_at` datetime(3),
	`offhost_copy_status` enum('local_only','disabled') NOT NULL DEFAULT 'local_only',
	`job_public_id` varchar(64),
	`correlation_id` varchar(64),
	`requested_by_user_id` bigint unsigned,
	`completed_at` datetime(3),
	`purged_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `backup_archives_id` PRIMARY KEY(`id`),
	CONSTRAINT `backup_archives_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `backup_archives_storage_key_uq` UNIQUE(`storage_key`)
);
--> statement-breakpoint
CREATE TABLE `backup_legal_holds` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`backup_id` bigint unsigned NOT NULL,
	`reason_code` varchar(64) NOT NULL,
	`note_enc` text NOT NULL,
	`created_by_user_id` bigint unsigned,
	`released_by_user_id` bigint unsigned,
	`release_reason_code` varchar(64),
	`released_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `backup_legal_holds_id` PRIMARY KEY(`id`),
	CONSTRAINT `backup_legal_holds_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `backup_restore_drills` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`backup_id` bigint unsigned NOT NULL,
	`state` enum('queued','running','completed','failed','canceled','refused','unknown') NOT NULL,
	`reason_code` varchar(64),
	`target_database_name` varchar(64) NOT NULL,
	`continuity_mode` enum('preserve_continuity','quarantine_credentials') NOT NULL DEFAULT 'preserve_continuity',
	`achieved_data_age_ms` bigint unsigned,
	`duration_ms` int unsigned,
	`continuity_report` json,
	`integrity_report` json,
	`requested_by_user_id` bigint unsigned,
	`correlation_id` varchar(64),
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `backup_restore_drills_id` PRIMARY KEY(`id`),
	CONSTRAINT `backup_restore_drills_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `backup_verifications` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`backup_id` bigint unsigned NOT NULL,
	`state` enum('queued','running','completed','failed','canceled','refused','unknown') NOT NULL,
	`reason_code` varchar(64),
	`authenticated_bytes` bigint unsigned,
	`chunks_verified` int unsigned,
	`sql_sha256_matched` boolean,
	`objects_verified` int unsigned,
	`manifest_valid` boolean,
	`key_readiness` enum('ready','missing_data_keys','unknown') NOT NULL DEFAULT 'unknown',
	`missing_data_key_ids` json NOT NULL,
	`duration_ms` int unsigned,
	`requested_by_user_id` bigint unsigned,
	`correlation_id` varchar(64),
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `backup_verifications_id` PRIMARY KEY(`id`),
	CONSTRAINT `backup_verifications_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `integration_egress_allowlist` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`purpose` varchar(32) NOT NULL,
	`match_type` varchar(16) NOT NULL,
	`pattern` varchar(255) NOT NULL,
	`port` int unsigned NOT NULL,
	`protocol` varchar(16) NOT NULL,
	`allow_private_address` boolean NOT NULL DEFAULT false,
	`enabled` boolean NOT NULL DEFAULT true,
	`justification` varchar(280) NOT NULL,
	`created_by_user_id` bigint unsigned,
	`updated_by_user_id` bigint unsigned,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `integration_egress_allowlist_id` PRIMARY KEY(`id`),
	CONSTRAINT `integration_egress_allowlist_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `uq_integration_egress_target` UNIQUE(`purpose`,`pattern`,`port`,`protocol`)
);
--> statement-breakpoint
CREATE TABLE `integration_provider_checks` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`provider_key` varchar(32) NOT NULL,
	`last_checked_at` datetime(3) NOT NULL,
	`last_outcome` varchar(24) NOT NULL,
	`last_reason_code` varchar(64),
	`verified_at` datetime(3),
	`consecutive_failures` int unsigned NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `integration_provider_checks_id` PRIMARY KEY(`id`),
	CONSTRAINT `integration_provider_checks_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `uq_integration_provider_checks_key` UNIQUE(`provider_key`)
);
--> statement-breakpoint
CREATE TABLE `integration_webhook_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` char(26) NOT NULL,
	`provider` varchar(32) NOT NULL,
	`external_event_id` varchar(128) NOT NULL,
	`event_type` varchar(96) NOT NULL,
	`payload_sha256` char(64) NOT NULL,
	`status` varchar(24) NOT NULL,
	`reason_code` varchar(64),
	`provider_timestamp` datetime(3) NOT NULL,
	`processed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `integration_webhook_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `integration_webhook_events_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `uq_integration_webhook_provider_event` UNIQUE(`provider`,`external_event_id`)
);
--> statement-breakpoint
CREATE TABLE `http_rate_limit_counters` (
	`category` enum('auth_high_risk','user_login','form_submission','api','expensive','standard_browsing') NOT NULL,
	`slot` int unsigned NOT NULL,
	`hits` int unsigned NOT NULL,
	`reset_at` datetime(3) NOT NULL,
	CONSTRAINT `http_rate_limit_counters_category_slot_pk` PRIMARY KEY(`category`,`slot`)
);
--> statement-breakpoint
ALTER TABLE `customer_ref_history` ADD CONSTRAINT `customer_ref_history_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer_ref_reservations` ADD CONSTRAINT `customer_ref_reservations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `identity_tokens` ADD CONSTRAINT `identity_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_sessions` ADD CONSTRAINT `user_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assurance_accounts` ADD CONSTRAINT `assurance_accounts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assurance_challenges` ADD CONSTRAINT `assurance_challenges_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assurance_passkeys` ADD CONSTRAINT `assurance_passkeys_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assurance_recovery_codes` ADD CONSTRAINT `assurance_recovery_codes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `catalog_product_versions` ADD CONSTRAINT `catalog_product_versions_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_grants` ADD CONSTRAINT `order_grants_grantee_user_id_users_id_fk` FOREIGN KEY (`grantee_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_grants` ADD CONSTRAINT `order_grants_granted_by_user_id_users_id_fk` FOREIGN KEY (`granted_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_grants` ADD CONSTRAINT `order_grants_ended_by_user_id_users_id_fk` FOREIGN KEY (`ended_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_lock_history` ADD CONSTRAINT `order_lock_history_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_notes` ADD CONSTRAINT `order_notes_author_user_id_users_id_fk` FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_reassignments` ADD CONSTRAINT `order_reassignments_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_references` ADD CONSTRAINT `order_references_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_status_history` ADD CONSTRAINT `order_status_history_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_workflow_versions` ADD CONSTRAINT `order_workflow_versions_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `engagement_notification_preferences` ADD CONSTRAINT `engagement_notification_preferences_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `engagement_notifications` ADD CONSTRAINT `engagement_notifications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `engagement_order_message_reads` ADD CONSTRAINT `engagement_order_message_reads_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `engagement_order_messages` ADD CONSTRAINT `engagement_order_messages_author_user_id_users_id_fk` FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `engagement_support_ticket_messages` ADD CONSTRAINT `engagement_support_ticket_messages_author_user_id_users_id_fk` FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `engagement_support_tickets` ADD CONSTRAINT `engagement_support_tickets_requester_user_id_users_id_fk` FOREIGN KEY (`requester_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `engagement_support_tickets` ADD CONSTRAINT `engagement_support_tickets_assignee_user_id_users_id_fk` FOREIGN KEY (`assignee_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_invoice_lines` ADD CONSTRAINT `cmp_inv_line_inv_fk` FOREIGN KEY (`invoice_id`) REFERENCES `compliance_invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_invoice_payments` ADD CONSTRAINT `cmp_pmt_inv_fk` FOREIGN KEY (`invoice_id`) REFERENCES `compliance_invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_invoice_payments` ADD CONSTRAINT `cmp_pmt_rec_user_fk` FOREIGN KEY (`recorded_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_invoice_refunds` ADD CONSTRAINT `cmp_rfd_inv_fk` FOREIGN KEY (`invoice_id`) REFERENCES `compliance_invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_invoice_refunds` ADD CONSTRAINT `cmp_rfd_pmt_fk` FOREIGN KEY (`payment_id`) REFERENCES `compliance_invoice_payments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_invoice_refunds` ADD CONSTRAINT `cmp_rfd_rec_user_fk` FOREIGN KEY (`recorded_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_invoices` ADD CONSTRAINT `cmp_inv_created_by_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_invoices` ADD CONSTRAINT `cmp_inv_issued_by_fk` FOREIGN KEY (`issued_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_invoices` ADD CONSTRAINT `cmp_inv_voided_by_fk` FOREIGN KEY (`voided_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `compliance_provider_events` ADD CONSTRAINT `cmp_pevt_inv_fk` FOREIGN KEY (`invoice_id`) REFERENCES `compliance_invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `intake_questionnaire_versions` ADD CONSTRAINT `cmp_iqv_q_fk` FOREIGN KEY (`questionnaire_id`) REFERENCES `intake_questionnaires`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `intake_questionnaire_versions` ADD CONSTRAINT `cmp_iqv_pub_user_fk` FOREIGN KEY (`published_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `intake_submission_revisions` ADD CONSTRAINT `cmp_irev_sub_fk` FOREIGN KEY (`submission_id`) REFERENCES `intake_submissions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `intake_submission_revisions` ADD CONSTRAINT `cmp_irev_actor_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `intake_submissions` ADD CONSTRAINT `cmp_isub_q_fk` FOREIGN KEY (`questionnaire_id`) REFERENCES `intake_questionnaires`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `intake_submissions` ADD CONSTRAINT `cmp_isub_qv_fk` FOREIGN KEY (`questionnaire_version_id`) REFERENCES `intake_questionnaire_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `intake_submissions` ADD CONSTRAINT `cmp_isub_sub_user_fk` FOREIGN KEY (`submitted_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `intake_submissions` ADD CONSTRAINT `cmp_isub_rev_user_fk` FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policy_acceptances` ADD CONSTRAINT `cmp_pol_acc_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policy_acceptances` ADD CONSTRAINT `cmp_pol_acc_doc_fk` FOREIGN KEY (`document_id`) REFERENCES `policy_documents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policy_acceptances` ADD CONSTRAINT `cmp_pol_acc_ver_fk` FOREIGN KEY (`policy_version_id`) REFERENCES `policy_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policy_versions` ADD CONSTRAINT `cmp_pol_ver_doc_fk` FOREIGN KEY (`document_id`) REFERENCES `policy_documents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policy_versions` ADD CONSTRAINT `cmp_pol_ver_pub_user_fk` FOREIGN KEY (`published_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `job_attempts` ADD CONSTRAINT `job_attempts_job_id_job_runs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `job_runs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_attempts` ADD CONSTRAINT `mail_attempts_mail_id_mail_outbox_id_fk` FOREIGN KEY (`mail_id`) REFERENCES `mail_outbox`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `backup_archives` ADD CONSTRAINT `backup_archives_requested_by_user_id_users_id_fk` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `backup_legal_holds` ADD CONSTRAINT `backup_legal_holds_backup_id_backup_archives_id_fk` FOREIGN KEY (`backup_id`) REFERENCES `backup_archives`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `backup_legal_holds` ADD CONSTRAINT `backup_legal_holds_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `backup_legal_holds` ADD CONSTRAINT `backup_legal_holds_released_by_user_id_users_id_fk` FOREIGN KEY (`released_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `backup_restore_drills` ADD CONSTRAINT `backup_restore_drills_backup_id_backup_archives_id_fk` FOREIGN KEY (`backup_id`) REFERENCES `backup_archives`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `backup_restore_drills` ADD CONSTRAINT `backup_restore_drills_requested_by_user_id_users_id_fk` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `backup_verifications` ADD CONSTRAINT `backup_verifications_backup_id_backup_archives_id_fk` FOREIGN KEY (`backup_id`) REFERENCES `backup_archives`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `backup_verifications` ADD CONSTRAINT `backup_verifications_requested_by_user_id_users_id_fk` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `customer_ref_history_user_idx` ON `customer_ref_history` (`user_id`,`changed_at`);--> statement-breakpoint
CREATE INDEX `identity_tokens_user_purpose_idx` ON `identity_tokens` (`user_id`,`purpose`,`consumed_at`);--> statement-breakpoint
CREATE INDEX `user_sessions_user_idx` ON `user_sessions` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `users_role_status_idx` ON `users` (`role`,`status`);--> statement-breakpoint
CREATE INDEX `users_name_first_idx` ON `users` (`name_first_prefix_index`);--> statement-breakpoint
CREATE INDEX `users_name_last_idx` ON `users` (`name_last_prefix_index`);--> statement-breakpoint
CREATE INDEX `ix_assurance_pending_totp_expiry` ON `assurance_accounts` (`pending_totp_expires_at`);--> statement-breakpoint
CREATE INDEX `ix_assurance_challenge_expiry` ON `assurance_challenges` (`expires_at`);--> statement-breakpoint
CREATE INDEX `ix_assurance_passkey_user` ON `assurance_passkeys` (`user_id`);--> statement-breakpoint
CREATE INDEX `catalog_groups_sort_idx` ON `catalog_groups` (`active`,`sort_order`);--> statement-breakpoint
CREATE INDEX `catalog_products_group_idx` ON `catalog_products` (`group_id`,`active`,`sort_order`);--> statement-breakpoint
CREATE INDEX `order_grants_order_idx` ON `order_grants` (`order_id`,`status`);--> statement-breakpoint
CREATE INDEX `order_grants_grantee_idx` ON `order_grants` (`grantee_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `order_grants_invitee_idx` ON `order_grants` (`invitee_email_index`,`status`);--> statement-breakpoint
CREATE INDEX `order_import_provenance_order_idx` ON `order_import_provenance` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_line_items_order_idx` ON `order_line_items` (`order_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `order_lock_history_order_idx` ON `order_lock_history` (`order_id`,`id`);--> statement-breakpoint
CREATE INDEX `order_notes_order_idx` ON `order_notes` (`order_id`,`visibility`,`id`);--> statement-breakpoint
CREATE INDEX `order_reassignments_order_idx` ON `order_reassignments` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_references_order_idx` ON `order_references` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_status_history_order_idx` ON `order_status_history` (`order_id`,`id`);--> statement-breakpoint
CREATE INDEX `orders_owner_idx` ON `orders` (`owner_user_id`,`id`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status_key`,`id`);--> statement-breakpoint
CREATE INDEX `orders_created_idx` ON `orders` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `file_access_log_file_idx` ON `file_access_log` (`file_public_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `file_access_log_actor_idx` ON `file_access_log` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `file_download_tickets_order_idx` ON `file_download_tickets` (`order_id`);--> statement-breakpoint
CREATE INDEX `file_download_tickets_file_idx` ON `file_download_tickets` (`file_id`);--> statement-breakpoint
CREATE INDEX `file_download_tickets_exp_idx` ON `file_download_tickets` (`expires_at`);--> statement-breakpoint
CREATE INDEX `order_files_order_public_idx` ON `order_files` (`order_id`,`public_id`);--> statement-breakpoint
CREATE INDEX `order_files_owner_idx` ON `order_files` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `order_files_retention_idx` ON `order_files` (`purge_after`,`purged_at`);--> statement-breakpoint
CREATE INDEX `eng_imp_prov_import_idx` ON `engagement_import_provenance` (`import_id`);--> statement-breakpoint
CREATE INDEX `eng_notif_user_read_idx` ON `engagement_notifications` (`user_id`,`read_at`,`id`);--> statement-breakpoint
CREATE INDEX `eng_notif_user_id_idx` ON `engagement_notifications` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `eng_notif_created_idx` ON `engagement_notifications` (`created_at`);--> statement-breakpoint
CREATE INDEX `eng_msg_att_msg_idx` ON `engagement_order_message_attachments` (`message_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `eng_msg_reads_user_order_idx` ON `engagement_order_message_reads` (`user_id`,`order_id`);--> statement-breakpoint
CREATE INDEX `eng_order_msg_order_id_idx` ON `engagement_order_messages` (`order_id`,`id`);--> statement-breakpoint
CREATE INDEX `eng_order_msg_order_pub_idx` ON `engagement_order_messages` (`order_public_id`,`public_id`);--> statement-breakpoint
CREATE INDEX `eng_order_msg_ref_idx` ON `engagement_order_messages` (`order_reference`);--> statement-breakpoint
CREATE INDEX `eng_order_msg_order_ref_idx` ON `engagement_order_messages` (`order_id`,`order_reference`);--> statement-breakpoint
CREATE INDEX `eng_order_msg_created_idx` ON `engagement_order_messages` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `eng_search_tok_lookup_idx` ON `engagement_search_tokens` (`domain`,`token_hash`,`customer_visible`,`record_id`);--> statement-breakpoint
CREATE INDEX `eng_search_tok_rec_idx` ON `engagement_search_tokens` (`domain`,`record_id`);--> statement-breakpoint
CREATE INDEX `eng_ticket_hist_ticket_idx` ON `engagement_support_ticket_history` (`ticket_id`,`id`);--> statement-breakpoint
CREATE INDEX `eng_ticket_msg_ticket_idx` ON `engagement_support_ticket_messages` (`ticket_id`,`id`);--> statement-breakpoint
CREATE INDEX `eng_tickets_req_status_idx` ON `engagement_support_tickets` (`requester_user_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `eng_tickets_req_num_idx` ON `engagement_support_tickets` (`requester_user_id`,`ticket_number`);--> statement-breakpoint
CREATE INDEX `eng_tickets_req_ref_idx` ON `engagement_support_tickets` (`requester_user_id`,`related_order_reference`);--> statement-breakpoint
CREATE INDEX `eng_tickets_order_ref_idx` ON `engagement_support_tickets` (`related_order_reference`);--> statement-breakpoint
CREATE INDEX `eng_tickets_queue_idx` ON `engagement_support_tickets` (`status`,`priority`,`id`);--> statement-breakpoint
CREATE INDEX `eng_tickets_assignee_idx` ON `engagement_support_tickets` (`assignee_user_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `eng_tickets_order_pub_idx` ON `engagement_support_tickets` (`related_order_public_id`);--> statement-breakpoint
CREATE INDEX `cmp_pmt_inv_idx` ON `compliance_invoice_payments` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `cmp_rfd_inv_idx` ON `compliance_invoice_refunds` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `cmp_rfd_pmt_idx` ON `compliance_invoice_refunds` (`payment_id`);--> statement-breakpoint
CREATE INDEX `cmp_inv_order_idx` ON `compliance_invoices` (`order_id`);--> statement-breakpoint
CREATE INDEX `cmp_inv_order_pub_idx` ON `compliance_invoices` (`order_public_id`);--> statement-breakpoint
CREATE INDEX `cmp_inv_st_created_idx` ON `compliance_invoices` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `cmp_iqv_qid_st_idx` ON `intake_questionnaire_versions` (`questionnaire_id`,`status`);--> statement-breakpoint
CREATE INDEX `cmp_int_q_scope_act_idx` ON `intake_questionnaires` (`scope_kind`,`scope_ref`,`active`);--> statement-breakpoint
CREATE INDEX `cmp_isub_order_pub_idx` ON `intake_submissions` (`order_public_id`);--> statement-breakpoint
CREATE INDEX `cmp_isub_status_idx` ON `intake_submissions` (`status`);--> statement-breakpoint
CREATE INDEX `cmp_pol_acc_doc_ver_idx` ON `policy_acceptances` (`document_id`,`policy_version_id`);--> statement-breakpoint
CREATE INDEX `cmp_pol_acc_order_idx` ON `policy_acceptances` (`order_public_id`);--> statement-breakpoint
CREATE INDEX `cmp_pol_docs_active_aud_idx` ON `policy_documents` (`active`,`audience`);--> statement-breakpoint
CREATE INDEX `cmp_pol_ver_doc_st_eff_idx` ON `policy_versions` (`document_id`,`status`,`effective_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_case_event_event` ON `audit_case_events` (`event_id`);--> statement-breakpoint
CREATE INDEX `ix_audit_case_notes_case` ON `audit_case_notes` (`case_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_cases_status` ON `audit_cases` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_checkpoint_seq` ON `audit_checkpoints` (`seq`);--> statement-breakpoint
CREATE INDEX `ix_audit_time` ON `audit_events` (`occurred_at`,`event_id`);--> statement-breakpoint
CREATE INDEX `ix_audit_cat_sev_time` ON `audit_events` (`category`,`severity_number`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_name_time` ON `audit_events` (`event_name`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_outcome_time` ON `audit_events` (`outcome`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_actor_time` ON `audit_events` (`actor_ref`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_res_time` ON `audit_events` (`resource_type`,`resource_ref`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_req` ON `audit_events` (`request_id`);--> statement-breakpoint
CREATE INDEX `ix_audit_trace` ON `audit_events` (`trace_id`);--> statement-breakpoint
CREATE INDEX `ix_audit_corr_time` ON `audit_events` (`correlation_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_job` ON `audit_events` (`job_id`);--> statement-breakpoint
CREATE INDEX `ix_audit_pkg` ON `audit_events` (`package_id`);--> statement-breakpoint
CREATE INDEX `ix_audit_reason_time` ON `audit_events` (`reason_code`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_exports_req` ON `audit_exports` (`requested_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_exports_status` ON `audit_exports` (`status`);--> statement-breakpoint
CREATE INDEX `ix_audit_holds_active` ON `audit_legal_holds` (`released_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_sq_owner` ON `audit_saved_queries` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `ix_audit_sq_shared` ON `audit_saved_queries` (`shared`);--> statement-breakpoint
CREATE INDEX `siem_destinations_enabled_idx` ON `siem_destinations` (`enabled`);--> statement-breakpoint
CREATE INDEX `siem_outbox_ready_idx` ON `siem_outbox` (`destination_id`,`state`,`endpoint_generation`,`id`);--> statement-breakpoint
CREATE INDEX `siem_outbox_state_age_idx` ON `siem_outbox` (`state`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `platform_presentation_images_sha_idx` ON `platform_presentation_images` (`sha256`);--> statement-breakpoint
CREATE INDEX `platform_presentation_images_gc_idx` ON `platform_presentation_images` (`deleted_at`,`object_purged_at`);--> statement-breakpoint
CREATE INDEX `job_runs_ready_ix` ON `job_runs` (`state`,`run_at`,`id`);--> statement-breakpoint
CREATE INDEX `job_runs_stale_ix` ON `job_runs` (`state`,`lease_until`,`id`);--> statement-breakpoint
CREATE INDEX `job_runs_type_ix` ON `job_runs` (`type`,`public_id`);--> statement-breakpoint
CREATE INDEX `job_runs_state_public_ix` ON `job_runs` (`state`,`public_id`);--> statement-breakpoint
CREATE INDEX `mail_outbox_state_ix` ON `mail_outbox` (`state`,`public_id`);--> statement-breakpoint
CREATE INDEX `mail_outbox_expiry_ix` ON `mail_outbox` (`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `mail_outbox_job_ix` ON `mail_outbox` (`job_public_id`);--> statement-breakpoint
CREATE INDEX `portable_exports_expiry_idx` ON `portable_exports` (`deleted_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `portable_import_record_remaining_idx` ON `portable_import_records` (`import_id`,`receipt_at`,`position`);--> statement-breakpoint
CREATE INDEX `portable_import_package_idx` ON `portable_imports` (`package_id`,`public_id`);--> statement-breakpoint
CREATE INDEX `backup_archives_state_created_idx` ON `backup_archives` (`state`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `backup_archives_verified_idx` ON `backup_archives` (`verification_status`,`purged_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `backup_archives_created_idx` ON `backup_archives` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `backup_legal_holds_active_idx` ON `backup_legal_holds` (`backup_id`,`released_at`);--> statement-breakpoint
CREATE INDEX `backup_restore_drills_backup_idx` ON `backup_restore_drills` (`backup_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `backup_verifications_backup_idx` ON `backup_verifications` (`backup_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_integration_egress_purpose_enabled` ON `integration_egress_allowlist` (`purpose`,`enabled`);--> statement-breakpoint
CREATE INDEX `idx_integration_webhook_status` ON `integration_webhook_events` (`provider`,`status`);--> statement-breakpoint
CREATE INDEX `http_rate_limit_reset_idx` ON `http_rate_limit_counters` (`reset_at`);