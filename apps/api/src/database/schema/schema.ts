import { bytea } from "../bytea"
import { pgTable, uuid, text, timestamp, index, foreignKey, unique, check, integer, jsonb, bigint, type AnyPgColumn, uniqueIndex, boolean, time, primaryKey, numeric, smallint, pgSequence } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"


export const schemaMigrationsIdSeq = pgSequence("schema_migrations_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "2147483647", cache: "1", cycle: false })
export const receiptNumberSeq = pgSequence("receipt_number_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "999999", cache: "1", cycle: false })

export const offices = pgTable("offices", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	nameAr: text("name_ar").notNull(),
	nameEn: text("name_en").notNull(),
	governorate: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const refreshTokens = pgTable("refresh_tokens", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	tokenHash: bytea("token_hash").notNull(),
	installationId: uuid("installation_id"),
	platform: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	replacedBy: uuid("replaced_by"),
}, (table) => [
	index("refresh_tokens_user_active_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")).where(sql`(revoked_at IS NULL)`),
	foreignKey({
			columns: [table.replacedBy],
			foreignColumns: [table.id],
			name: "refresh_tokens_replaced_by_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "refresh_tokens_user_id_fkey"
		}).onDelete("cascade"),
	unique("refresh_tokens_token_hash_key").on(table.tokenHash),
	check("refresh_tokens_hash_len", sql`octet_length(token_hash) = 32`),
	check("refresh_tokens_platform_check", sql`(platform IS NULL) OR (platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text]))`),
]);

export const pushDevices = pgTable("push_devices", {
	installationId: uuid("installation_id").primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	platform: text().notNull(),
	tokenEnc: bytea("token_enc").notNull(),
	appVersion: text("app_version"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("push_devices_user_active_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")).where(sql`(revoked_at IS NULL)`),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "push_devices_user_id_fkey"
		}).onDelete("cascade"),
	check("push_devices_platform_check", sql`platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])`),
]);

export const uploadForms = pgTable("upload_forms", {
	version: integer().primaryKey().notNull(),
	materialTypes: text("material_types").array().default([""]).notNull(),
	schema: jsonb().notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	publishedBy: uuid("published_by"),
}, (table) => [
	foreignKey({
			columns: [table.publishedBy],
			foreignColumns: [users.id],
			name: "upload_forms_published_by_fkey"
		}),
	check("upload_forms_material_types_known", sql`material_types <@ allowed_material_types()`),
	check("upload_forms_no_sensitive_fields_v0", sql`NOT jsonb_path_exists(schema, '$."fields"[*]?(@."sensitive" == true || @."type" == "location")'::jsonpath)`),
	check("upload_forms_schema_has_fields", sql`(schema ? 'fields'::text) AND (jsonb_typeof((schema -> 'fields'::text)) = 'array'::text)`),
	check("upload_forms_schema_is_object", sql`jsonb_typeof(schema) = 'object'::text`),
	check("upload_forms_schema_version_matches", sql`(schema ? 'version'::text) AND (((schema ->> 'version'::text))::integer = version)`),
	check("upload_forms_version_positive", sql`version >= 1`),
]);

export const materialTransitions = pgTable("material_transitions", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "material_transitions_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	materialId: uuid("material_id").notNull(),
	track: text().notNull(),
	fromState: text("from_state").notNull(),
	toState: text("to_state").notNull(),
	reason: text().notNull(),
	noteTimecodeMs: integer("note_timecode_ms"),
	actorId: uuid("actor_id"),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("material_transitions_material_idx").using("btree", table.materialId.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.actorId],
			foreignColumns: [users.id],
			name: "material_transitions_actor_id_fkey"
		}),
	foreignKey({
			columns: [table.materialId],
			foreignColumns: [materials.id],
			name: "material_transitions_material_id_fkey"
		}).onDelete("cascade"),
	check("material_transitions_changes_state", sql`from_state <> to_state`),
	check("material_transitions_reason_nonempty", sql`(char_length(reason) >= 1) AND (char_length(reason) <= 2000)`),
	check("material_transitions_timecode_nonneg", sql`(note_timecode_ms IS NULL) OR (note_timecode_ms >= 0)`),
	check("material_transitions_track_check", sql`track = ANY (ARRAY['technical'::text, 'editorial'::text, 'rights'::text])`),
]);

export const auditLog = pgTable("audit_log", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "audit_log_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	actorId: uuid("actor_id"),
	action: text().notNull(),
	targetType: text("target_type"),
	targetId: text("target_id"),
	installationId: uuid("installation_id"),
	details: jsonb().default({}).notNull(),
	prevHash: bytea("prev_hash"),
	hash: bytea("hash").notNull(),
}, (table) => [
	index("audit_log_actor_idx").using("btree", table.actorId.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")).where(sql`(actor_id IS NOT NULL)`),
	index("audit_log_target_idx").using("btree", table.targetType.asc().nullsLast().op("int8_ops"), table.targetId.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("int8_ops")),
	check("audit_log_action_nonempty", sql`(char_length(action) >= 1) AND (char_length(action) <= 128)`),
	check("audit_log_details_is_object", sql`jsonb_typeof(details) = 'object'::text`),
	check("audit_log_details_whitelisted", sql`CHECK (audit_details_is_whitelisted(details`),
	check("audit_log_hash_len", sql`octet_length(hash) = 32`),
	check("audit_log_prev_hash_len", sql`(prev_hash IS NULL) OR (octet_length(prev_hash) = 32)`),
]);

export const uploadSessions = pgTable("upload_sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	materialId: uuid("material_id").notNull(),
	createdBy: uuid("created_by").notNull(),
	kind: text().notNull(),
	state: text().default('created').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
	filename: text().notNull(),
	mimeType: text("mime_type"),
	proxyMode: text("proxy_mode"),
	partSizeBytes: integer("part_size_bytes").notNull(),
	uploadPath: text("upload_path").default('tusd').notNull(),
	tusUploadId: text("tus_upload_id"),
	storageKey: text("storage_key"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytesReceived: bigint("bytes_received", { mode: "number" }).default(0).notNull(),
	clientSha256: bytea("client_sha256"),
	clientFingerprint: jsonb("client_fingerprint"),
	uploadTokenHash: bytea("upload_token_hash"),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	fileId: uuid("file_id"),
	duplicateOfFileId: uuid("duplicate_of_file_id"),
	failureReason: text("failure_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	hookReservedUntil: timestamp("hook_reserved_until", { withTimezone: true, mode: 'string' }),
	uploadTokenExpiresAt: timestamp("upload_token_expires_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("upload_sessions_expiry_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(state = ANY (ARRAY['created'::text, 'in_progress'::text]))`),
	index("upload_sessions_inflight_idx").using("btree", table.state.asc().nullsLast().op("timestamptz_ops"), table.updatedAt.asc().nullsLast().op("text_ops")).where(sql`(state = ANY (ARRAY['created'::text, 'in_progress'::text]))`),
	index("upload_sessions_material_idx").using("btree", table.materialId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("uuid_ops")),
	index("upload_sessions_owner_idx").using("btree", table.createdBy.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops"), table.id.desc().nullsFirst().op("uuid_ops")),
	uniqueIndex("upload_sessions_tus_upload_id_key").using("btree", table.tusUploadId.asc().nullsLast().op("text_ops")).where(sql`(tus_upload_id IS NOT NULL)`),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "upload_sessions_created_by_fkey"
		}),
	foreignKey({
			columns: [table.duplicateOfFileId],
			foreignColumns: [materialFiles.id],
			name: "upload_sessions_duplicate_of_file_id_fkey"
		}),
	foreignKey({
			columns: [table.fileId],
			foreignColumns: [materialFiles.id],
			name: "upload_sessions_file_id_fkey"
		}),
	foreignKey({
			columns: [table.materialId],
			foreignColumns: [materials.id],
			name: "upload_sessions_material_id_fkey"
		}).onDelete("cascade"),
	check("upload_sessions_bytes_received_range", sql`(bytes_received >= 0) AND (bytes_received <= size_bytes)`),
	check("upload_sessions_client_sha256_len", sql`(client_sha256 IS NULL) OR (octet_length(client_sha256) = 32)`),
	check("upload_sessions_dedup_has_target", sql`(state = 'deduplicated'::text) = (duplicate_of_file_id IS NOT NULL)`),
	check("upload_sessions_failed_has_reason", sql`(state = 'failed'::text) = (failure_reason IS NOT NULL)`),
	check("upload_sessions_failure_reason_check", sql`(failure_reason IS NULL) OR (failure_reason = ANY (ARRAY['checksum_mismatch'::text, 'invalid_file'::text, 'expired'::text, 'aborted'::text, 'storage_error'::text]))`),
	check("upload_sessions_filename_len", sql`(char_length(filename) >= 1) AND (char_length(filename) <= 255)`),
	check("upload_sessions_fingerprint_is_object", sql`(client_fingerprint IS NULL) OR (jsonb_typeof(client_fingerprint) = 'object'::text)`),
	check("upload_sessions_hook_reserved_created_only", sql`(hook_reserved_until IS NULL) OR (state = 'created'::text)`),
	check("upload_sessions_kind_check", sql`kind = ANY (ARRAY['original'::text, 'proxy'::text, 'voice_note'::text])`),
	check("upload_sessions_part_size_min", sql`part_size_bytes >= 1048576`),
	check("upload_sessions_proxy_mode_check", sql`(proxy_mode IS NULL) OR (proxy_mode = ANY (ARRAY['urgent'::text, 'normal'::text]))`),
	check("upload_sessions_proxy_mode_only_proxy", sql`(proxy_mode IS NULL) OR (kind = 'proxy'::text)`),
	check("upload_sessions_size_positive", sql`size_bytes > 0`),
	check("upload_sessions_state_check", sql`state = ANY (ARRAY['created'::text, 'in_progress'::text, 'completed'::text, 'verified'::text, 'failed'::text, 'deduplicated'::text])`),
	check("upload_sessions_token_expiry_within_session", sql`(upload_token_expires_at IS NULL) OR (upload_token_expires_at <= expires_at)`),
	check("upload_sessions_upload_path_check", sql`upload_path = ANY (ARRAY['tusd'::text, 'direct'::text, 'ietf'::text])`),
]);

export const recoveryRequests = pgTable("recovery_requests", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	state: text().default('pending_approval').notNull(),
	approvedBy: uuid("approved_by"),
	verificationNote: text("verification_note"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	resetTokenHash: bytea("reset_token_hash"),
	resetTokenExpiresAt: timestamp("reset_token_expires_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("recovery_requests_pending_idx").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(state = 'pending_approval'::text)`),
	uniqueIndex("recovery_requests_reset_token_key").using("btree", table.resetTokenHash.asc().nullsLast().op("bytea_ops")).where(sql`(reset_token_hash IS NOT NULL)`),
	foreignKey({
			columns: [table.approvedBy],
			foreignColumns: [users.id],
			name: "recovery_requests_approved_by_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "recovery_requests_user_id_fkey"
		}).onDelete("cascade"),
	check("recovery_requests_approved_by_note", sql`(state <> 'approved'::text) OR ((approved_by IS NOT NULL) AND (verification_note IS NOT NULL))`),
	check("recovery_requests_completed_needs_token", sql`(completed_at IS NULL) OR (reset_token_hash IS NOT NULL)`),
	check("recovery_requests_decision_consistent", sql`((state = 'pending_approval'::text) AND (decided_at IS NULL)) OR ((state <> 'pending_approval'::text) AND (decided_at IS NOT NULL))`),
	check("recovery_requests_reset_only_when_approved", sql`(reset_token_hash IS NULL) OR (state = 'approved'::text)`),
	check("recovery_requests_reset_token_consistent", sql`(reset_token_hash IS NULL) = (reset_token_expires_at IS NULL)`),
	check("recovery_requests_reset_token_hash_len", sql`(reset_token_hash IS NULL) OR (octet_length(reset_token_hash) = 32)`),
	check("recovery_requests_reset_token_max_24h", sql`(reset_token_expires_at IS NULL) OR (reset_token_expires_at <= (decided_at + '24:00:00'::interval))`),
	check("recovery_requests_state_check", sql`state = ANY (ARRAY['pending_approval'::text, 'approved'::text, 'rejected'::text, 'expired'::text])`),
]);

export const deviceAttestationKeys = pgTable("device_attestation_keys", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	platform: text().default('ios').notNull(),
	keyIdHash: bytea("key_id_hash").notNull(),
	publicKey: bytea("public_key").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	signCount: bigint("sign_count", { mode: "number" }).default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("device_attestation_keys_user_active_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")).where(sql`(revoked_at IS NULL)`),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "device_attestation_keys_user_id_fkey"
		}).onDelete("cascade"),
	unique("device_attestation_keys_key_id_hash_key").on(table.keyIdHash),
	check("device_attestation_keys_key_id_hash_len", sql`octet_length(key_id_hash) = 32`),
	check("device_attestation_keys_platform_check", sql`platform = 'ios'::text`),
	check("device_attestation_keys_sign_count_nonneg", sql`sign_count >= 0`),
]);

export const users = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: text().notNull(),
	passwordHash: text("password_hash").notNull(),
	totpSecretEnc: bytea("totp_secret_enc"),
	totpEnabled: boolean("totp_enabled").default(false).notNull(),
	status: text().default('active').notNull(),
	officeId: uuid("office_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: 'string' }),
	credentialResetRequired: boolean("credential_reset_required").default(false).notNull(),
	totpPendingSecretEnc: bytea("totp_pending_secret_enc"),
	legalNameEnc: bytea("legal_name_enc"),
}, (table) => [
	uniqueIndex("users_email_lower_key").using("btree", sql`lower(email)`),
	index("users_office_idx").using("btree", table.officeId.asc().nullsLast().op("uuid_ops")).where(sql`(office_id IS NOT NULL)`),
	foreignKey({
			columns: [table.officeId],
			foreignColumns: [offices.id],
			name: "users_office_id_fkey"
		}),
	check("users_status_check", sql`status = ANY (ARRAY['active'::text, 'suspended'::text, 'recovery'::text])`),
	check("users_totp_consistent", sql`(NOT totp_enabled) OR (totp_secret_enc IS NOT NULL)`),
	check("users_totp_pending_only_during_reset", sql`(totp_pending_secret_enc IS NULL) OR credential_reset_required`),
]);

export const materials = pgTable("materials", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	reporterId: uuid("reporter_id").notNull(),
	officeId: uuid("office_id"),
	title: text().notNull(),
	materialTypes: text("material_types").array().notNull(),
	governorate: text().notNull(),
	city: text().notNull(),
	shotAt: timestamp("shot_at", { withTimezone: true, mode: 'string' }),
	priority: text().notNull(),
	sensitivityMinors: boolean("sensitivity_minors").notNull(),
	sensitivityInjured: boolean("sensitivity_injured").notNull(),
	sensitivityGraphic: boolean("sensitivity_graphic").notNull(),
	displayNameMode: text("display_name_mode").notNull(),
	displayNamePseudonym: text("display_name_pseudonym"),
	gpsEnc: bytea("gps_enc"),
	formVersion: integer("form_version").notNull(),
	dynamicFields: jsonb("dynamic_fields").default({}).notNull(),
	technicalState: text("technical_state").default('pending').notNull(),
	editorialState: text("editorial_state").default('inbox').notNull(),
	rightsState: text("rights_state").default('unknown').notNull(),
	version: integer().default(1).notNull(),
	reservedBy: uuid("reserved_by"),
	reservedAt: timestamp("reserved_at", { withTimezone: true, mode: 'string' }),
	originalHeight: integer("original_height"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	originalDurationMs: bigint("original_duration_ms", { mode: "number" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
	acknowledgedBy: uuid("acknowledged_by"),
	acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("materials_board_idx").using("btree", table.officeId.asc().nullsLast().op("uuid_ops"), table.editorialState.asc().nullsLast().op("timestamptz_ops"), table.priority.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("materials_cursor_idx").using("btree", table.createdAt.desc().nullsFirst().op("uuid_ops"), table.id.desc().nullsFirst().op("timestamptz_ops")),
	index("materials_governorate_shot_idx").using("btree", table.governorate.asc().nullsLast().op("timestamptz_ops"), table.shotAt.desc().nullsFirst().op("text_ops")),
	index("materials_reporter_idx").using("btree", table.reporterId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("materials_reserved_idx").using("btree", table.reservedBy.asc().nullsLast().op("uuid_ops"), table.reservedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(reserved_by IS NOT NULL)`),
	index("materials_rights_idx").using("btree", table.rightsState.asc().nullsLast().op("timestamptz_ops"), table.editorialState.asc().nullsLast().op("timestamptz_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("materials_shot_cursor_idx").using("btree", table.shotAt.desc().nullsFirst().op("timestamptz_ops"), table.id.desc().nullsFirst().op("uuid_ops")),
	index("materials_technical_inflight_idx").using("btree", table.technicalState.asc().nullsLast().op("timestamptz_ops"), table.updatedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(technical_state = ANY (ARRAY['pending'::text, 'proxy_received'::text, 'original_received'::text]))`),
	index("materials_updated_cursor_idx").using("btree", table.updatedAt.desc().nullsFirst().op("timestamptz_ops"), table.id.desc().nullsFirst().op("uuid_ops")),
	foreignKey({
			columns: [table.acknowledgedBy],
			foreignColumns: [users.id],
			name: "materials_acknowledged_by_fkey"
		}),
	foreignKey({
			columns: [table.formVersion],
			foreignColumns: [uploadForms.version],
			name: "materials_form_version_fkey"
		}),
	foreignKey({
			columns: [table.officeId],
			foreignColumns: [offices.id],
			name: "materials_office_id_fkey"
		}),
	foreignKey({
			columns: [table.reporterId],
			foreignColumns: [users.id],
			name: "materials_reporter_id_fkey"
		}),
	foreignKey({
			columns: [table.reservedBy],
			foreignColumns: [users.id],
			name: "materials_reserved_by_fkey"
		}),
	check("materials_acknowledged_consistent", sql`(acknowledged_by IS NULL) = (acknowledged_at IS NULL)`),
	check("materials_display_name_mode_check", sql`display_name_mode = ANY (ARRAY['real_name'::text, 'pseudonym'::text, 'network'::text])`),
	check("materials_dynamic_fields_is_object", sql`jsonb_typeof(dynamic_fields) = 'object'::text`),
	check("materials_editorial_state_check", sql`editorial_state = ANY (ARRAY['inbox'::text, 'acknowledged'::text, 'reviewing'::text, 'needs_changes'::text, 'accepted'::text, 'in_production'::text, 'final_review'::text, 'published'::text, 'rejected'::text])`),
	check("materials_original_duration_nonneg", sql`(original_duration_ms IS NULL) OR (original_duration_ms >= 0)`),
	check("materials_original_height_positive", sql`(original_height IS NULL) OR (original_height > 0)`),
	check("materials_priority_check", sql`priority = ANY (ARRAY['urgent'::text, 'important'::text, 'normal'::text])`),
	check("materials_pseudonym_consistent", sql`(display_name_mode = 'pseudonym'::text) = (display_name_pseudonym IS NOT NULL)`),
	check("materials_reservation_consistent", sql`(reserved_by IS NULL) = (reserved_at IS NULL)`),
	check("materials_rights_state_check", sql`rights_state = ANY (ARRAY['unknown'::text, 'documented'::text, 'sellable'::text, 'blocked'::text, 'withdrawn'::text])`),
	check("materials_row_version_positive", sql`row_version >= 1`),
	check("materials_technical_state_check", sql`technical_state = ANY (ARRAY['pending'::text, 'proxy_received'::text, 'original_received'::text, 'verified'::text, 'failed'::text])`),
	check("materials_title_len", sql`(char_length(title) >= 1) AND (char_length(title) <= 200)`),
	check("materials_types_known", sql`material_types <@ allowed_material_types()`),
	check("materials_types_nonempty", sql`cardinality(material_types) >= 1`),
	check("materials_version_positive", sql`version >= 1`),
]);

export const notificationRules = pgTable("notification_rules", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	eventType: text("event_type").notNull(),
	priorities: text().array(),
	materialTypes: text("material_types").array(),
	scopeKind: text("scope_kind").default('all').notNull(),
	scopeId: text("scope_id").default('').notNull(),
	recipientRoles: text("recipient_roles").array().default([""]).notNull(),
	recipientPermissions: text("recipient_permissions").array().default([""]).notNull(),
	channels: text().array().notNull(),
	delaySeconds: integer("delay_seconds").default(0).notNull(),
	quietHoursStart: time("quiet_hours_start"),
	quietHoursEnd: time("quiet_hours_end"),
	quietHoursTz: text("quiet_hours_tz"),
	digestIntervalMinutes: integer("digest_interval_minutes"),
	assignment: boolean().default(false).notNull(),
	enabled: boolean().default(true).notNull(),
	rowVersion: integer("row_version").default(1).notNull(),
	createdBy: uuid("created_by"),
	updatedBy: uuid("updated_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("notification_rules_event_idx").using("btree", table.eventType.asc().nullsLast().op("text_ops"), table.enabled.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "notification_rules_created_by_fkey"
		}),
	foreignKey({
			columns: [table.updatedBy],
			foreignColumns: [users.id],
			name: "notification_rules_updated_by_fkey"
		}),
	check("notification_rules_channels_check", sql`(cardinality(channels) >= 1) AND (channels <@ ARRAY['in_app'::text, 'websocket'::text, 'apns'::text, 'fcm'::text, 'web_push'::text, 'email'::text, 'telegram'::text, 'whatsapp'::text, 'sms'::text])`),
	check("notification_rules_delay_range", sql`(delay_seconds >= 0) AND (delay_seconds <= 86400)`),
	check("notification_rules_digest_range", sql`(digest_interval_minutes IS NULL) OR ((digest_interval_minutes >= 15) AND (digest_interval_minutes <= 1440))`),
	check("notification_rules_event_type_check", sql`event_type = ANY (ARRAY['material.created'::text, 'material.urgent_received'::text, 'material.updated'::text, 'material.version_created'::text, 'material.technical_transition'::text, 'material.editorial_transition'::text, 'material.rights_transition'::text, 'material.acknowledged'::text, 'material.change_requested'::text, 'material.accepted_for_production'::text, 'material.reserved'::text, 'material.released'::text, 'material.contributors_set'::text, 'material.published'::text, 'upload.started'::text, 'upload.proxy_received'::text, 'upload.original_received'::text, 'upload.verified'::text, 'upload.deduplicated'::text, 'upload.failed'::text, 'ai.draft_ready'::text])`),
	check("notification_rules_has_recipient", sql`(cardinality(recipient_roles) + cardinality(recipient_permissions)) >= 1`),
	check("notification_rules_material_types_check", sql`(material_types IS NULL) OR ((cardinality(material_types) >= 1) AND (material_types <@ allowed_material_types()))`),
	check("notification_rules_name_len", sql`(char_length(name) >= 1) AND (char_length(name) <= 120)`),
	check("notification_rules_permissions_check", sql`recipient_permissions <@ ARRAY['sensitive_location:read'::text, 'protected_source:read'::text, 'reporter_identity:read'::text]`),
	check("notification_rules_priorities_check", sql`(priorities IS NULL) OR ((cardinality(priorities) >= 1) AND (priorities <@ ARRAY['urgent'::text, 'important'::text, 'normal'::text]))`),
	check("notification_rules_quiet_hours_consistent", sql`((quiet_hours_start IS NULL) = (quiet_hours_end IS NULL)) AND ((quiet_hours_start IS NULL) = (quiet_hours_tz IS NULL))`),
	check("notification_rules_roles_check", sql`recipient_roles <@ ARRAY['system_admin'::text, 'editor_in_chief'::text, 'supervisor'::text, 'producer'::text, 'finance'::text, 'reporter'::text, 'rights_officer'::text]`),
	check("notification_rules_row_version_pos", sql`row_version >= 1`),
	check("notification_rules_scope_id_check", sql`(scope_kind = 'all'::text) = (scope_id = ''::text)`),
	check("notification_rules_scope_kind_check", sql`scope_kind = ANY (ARRAY['all'::text, 'office'::text, 'governorate'::text])`),
]);

export const notifications = pgTable("notifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	eventId: bigint("event_id", { mode: "number" }).notNull(),
	type: text().notNull(),
	materialId: uuid("material_id"),
	title: text().notNull(),
	priority: text().default('normal').notNull(),
	state: text().default('sent').notNull(),
	assignmentState: text("assignment_state"),
	escalationLevel: integer("escalation_level").default(0).notNull(),
	escalateAt: timestamp("escalate_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'string' }),
	acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: 'string' }),
	recoveryRequestId: uuid("recovery_request_id"),
	ruleId: uuid("rule_id"),
}, (table) => [
	index("notifications_escalation_idx").using("btree", table.escalateAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((acknowledged_at IS NULL) AND (escalate_at IS NOT NULL))`),
	index("notifications_inbox_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("notifications_overdue_assignment_idx").using("btree", table.escalateAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((assignment_state = 'assigned'::text) AND (acknowledged_at IS NULL))`),
	index("notifications_material_idx").using("btree", table.materialId.asc().nullsLast().op("uuid_ops")).where(sql`(material_id IS NOT NULL)`),
	index("notifications_unread_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")).where(sql`(read_at IS NULL)`),
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [outboxEvents.id],
			name: "notifications_event_id_fkey"
		}),
	foreignKey({
			columns: [table.materialId],
			foreignColumns: [materials.id],
			name: "notifications_material_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.recoveryRequestId],
			foreignColumns: [recoveryRequests.id],
			name: "notifications_recovery_request_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.ruleId],
			foreignColumns: [notificationRules.id],
			name: "notifications_rule_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "notifications_user_id_fkey"
		}).onDelete("cascade"),
	unique("notifications_user_event_key").on(table.userId, table.eventId),
	check("notifications_ack_consistent", sql`(state = 'acknowledged'::text) = (acknowledged_at IS NOT NULL)`),
	check("notifications_assignment_state_check", sql`(assignment_state IS NULL) OR (assignment_state = ANY (ARRAY['assigned'::text, 'acknowledged'::text]))`),
	check("notifications_escalation_nonneg", sql`escalation_level >= 0`),
	check("notifications_priority_check", sql`priority = ANY (ARRAY['urgent'::text, 'important'::text, 'normal'::text])`),
	check("notifications_read_consistent", sql`(state = ANY (ARRAY['read'::text, 'acknowledged'::text])) = (read_at IS NOT NULL)`),
	check("notifications_state_check", sql`state = ANY (ARRAY['sent'::text, 'delivered'::text, 'read'::text, 'acknowledged'::text])`),
]);

export const materialFiles = pgTable("material_files", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	materialId: uuid("material_id").notNull(),
	kind: text().notNull(),
	state: text().default('uploading').notNull(),
	uploadSessionId: uuid("upload_session_id"),
	derivedFromId: uuid("derived_from_id"),
	storageKey: text("storage_key"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }),
	sha256: bytea("sha256"),
	mimeType: text("mime_type"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	durationMs: bigint("duration_ms", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	startPtsUs: bigint("start_pts_us", { mode: "number" }),
	width: integer(),
	height: integer(),
	proxyMode: text("proxy_mode"),
	receiptNumber: text("receipt_number"),
	verifiedAt: timestamp("verified_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	technical: jsonb(),
	headSha256: bytea("head_sha256"),
	tailSha256: bytea("tail_sha256"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	perceptualHash: bigint("perceptual_hash", { mode: "number" }).array(),
	licenseId: uuid("license_id"),
}, (table) => [
	uniqueIndex("material_files_delivery_license_key").using("btree", table.derivedFromId.asc().nullsLast().op("uuid_ops"), table.licenseId.asc().nullsLast().op("uuid_ops")).where(sql`(kind = 'delivery'::text)`),
	uniqueIndex("material_files_derived_kind_key").using("btree", table.derivedFromId.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops")).where(sql`((derived_from_id IS NOT NULL) AND (kind <> 'delivery'::text))`),
	index("material_files_material_kind_idx").using("btree", table.materialId.asc().nullsLast().op("uuid_ops"), table.kind.asc().nullsLast().op("text_ops")),
	index("material_files_recent_receipts_idx").using("btree", table.verifiedAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`((receipt_number IS NOT NULL) AND (verified_at IS NOT NULL))`),
	uniqueIndex("material_files_receipt_number_key").using("btree", table.receiptNumber.asc().nullsLast().op("text_ops")).where(sql`(receipt_number IS NOT NULL)`),
	index("material_files_sha256_idx").using("btree", table.sha256.asc().nullsLast().op("bytea_ops")).where(sql`(sha256 IS NOT NULL)`),
	index("material_files_size_head_idx").using("btree", table.sizeBytes.asc().nullsLast().op("bytea_ops"), table.headSha256.asc().nullsLast().op("bytea_ops")).where(sql`(head_sha256 IS NOT NULL)`),
	foreignKey({
			columns: [table.derivedFromId],
			foreignColumns: [table.id],
			name: "material_files_derived_from_id_fkey"
		}),
	foreignKey({
			columns: [table.materialId],
			foreignColumns: [materials.id],
			name: "material_files_material_id_fkey"
		}).onDelete("cascade"),
	check("material_files_delivery_license_check", sql`(kind = 'delivery'::text) = (license_id IS NOT NULL)`),
	check("material_files_dims_positive", sql`((width IS NULL) OR (width > 0)) AND ((height IS NULL) OR (height > 0))`),
	check("material_files_head_sha256_len", sql`(head_sha256 IS NULL) OR (octet_length(head_sha256) = 32)`),
	check("material_files_kind_check", sql`kind = ANY (ARRAY['original'::text, 'proxy'::text, 'hls'::text, 'audio'::text, 'thumbnail'::text, 'voice_note'::text, 'export'::text, 'transcript'::text, 'captions'::text, 'watermarked_preview'::text, 'shot_list'::text, 'delivery'::text])`),
	check("material_files_perceptual_hash_size", sql`(perceptual_hash IS NULL) OR (((cardinality(perceptual_hash) >= 1) AND (cardinality(perceptual_hash) <= 32)) AND (array_position(perceptual_hash, NULL::bigint) IS NULL))`),
	check("material_files_perceptual_hash_video_only", sql`(perceptual_hash IS NULL) OR (kind = 'original'::text)`),
	check("material_files_proxy_mode_check", sql`(proxy_mode IS NULL) OR (proxy_mode = ANY (ARRAY['urgent'::text, 'normal'::text]))`),
	check("material_files_proxy_mode_only_proxy", sql`(proxy_mode IS NULL) OR (kind = 'proxy'::text)`),
	check("material_files_receipt_format", sql`(receipt_number IS NULL) OR (receipt_number ~ '^R-[0-9]{6}-[0-9]{6}$'::text)`),
	check("material_files_receipt_only_original", sql`(receipt_number IS NULL) OR (kind = 'original'::text)`),
	check("material_files_sha256_len", sql`(sha256 IS NULL) OR (octet_length(sha256) = 32)`),
	check("material_files_size_nonneg", sql`(size_bytes IS NULL) OR (size_bytes >= 0)`),
	check("material_files_state_check", sql`state = ANY (ARRAY['uploading'::text, 'received'::text, 'verified'::text, 'failed'::text])`),
	check("material_files_tail_sha256_len", sql`(tail_sha256 IS NULL) OR (octet_length(tail_sha256) = 32)`),
	check("material_files_technical_whitelisted", sql`(technical IS NULL) OR material_file_technical_is_whitelisted(technical)`),
	check("material_files_verified_consistent", sql`(state = 'verified'::text) = (verified_at IS NOT NULL)`),
	check("material_files_verified_has_sha", sql`(state <> 'verified'::text) OR (sha256 IS NOT NULL)`),
]);

export const materialExports = pgTable("material_exports", {
	sourceFileId: uuid("source_file_id").primaryKey().notNull(),
	materialId: uuid("material_id").notNull(),
	requestedBy: uuid("requested_by").notNull(),
	state: text().default('requested').notNull(),
	fileId: uuid("file_id"),
	failureReason: text("failure_reason"),
	requestedAt: timestamp("requested_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("material_exports_material_idx").using("btree", table.materialId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.fileId],
			foreignColumns: [materialFiles.id],
			name: "material_exports_file_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.materialId],
			foreignColumns: [materials.id],
			name: "material_exports_material_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.requestedBy],
			foreignColumns: [users.id],
			name: "material_exports_requested_by_fkey"
		}),
	foreignKey({
			columns: [table.sourceFileId],
			foreignColumns: [materialFiles.id],
			name: "material_exports_source_file_id_fkey"
		}).onDelete("cascade"),
	check("material_exports_failure_reason_check", sql`((state = 'failed'::text) = (failure_reason IS NOT NULL)) AND ((failure_reason IS NULL) OR (failure_reason = ANY (ARRAY['source_unavailable'::text, 'build_failed'::text])))`),
	check("material_exports_ready_has_file", sql`(state = 'ready'::text) = (file_id IS NOT NULL)`),
	check("material_exports_state_check", sql`state = ANY (ARRAY['requested'::text, 'ready'::text, 'failed'::text])`),
]);

export const userPermissions = pgTable("user_permissions", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "user_permissions_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	userId: uuid("user_id").notNull(),
	permission: text().notNull(),
	grantedBy: uuid("granted_by").notNull(),
	grantedAt: timestamp("granted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	reason: text().notNull(),
	revokedBy: uuid("revoked_by"),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("user_permissions_active_key").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.permission.asc().nullsLast().op("text_ops")).where(sql`(revoked_at IS NULL)`),
	index("user_permissions_user_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")).where(sql`(revoked_at IS NULL)`),
	foreignKey({
			columns: [table.grantedBy],
			foreignColumns: [users.id],
			name: "user_permissions_granted_by_fkey"
		}),
	foreignKey({
			columns: [table.revokedBy],
			foreignColumns: [users.id],
			name: "user_permissions_revoked_by_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "user_permissions_user_id_fkey"
		}).onDelete("cascade"),
	check("user_permissions_permission_check", sql`permission = ANY (ARRAY['sensitive_location:read'::text, 'protected_source:read'::text, 'reporter_identity:read'::text])`),
	check("user_permissions_reason_len", sql`(char_length(reason) >= 1) AND (char_length(reason) <= 500)`),
	check("user_permissions_revoke_consistent", sql`(revoked_by IS NULL) = (revoked_at IS NULL)`),
	check("user_permissions_revoked_after_granted", sql`(revoked_at IS NULL) OR (revoked_at >= granted_at)`),
]);

export const systemSettings = pgTable("system_settings", {
	key: text().primaryKey().notNull(),
	value: text().notNull(),
	updatedBy: uuid("updated_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.updatedBy],
			foreignColumns: [users.id],
			name: "system_settings_updated_by_fkey"
		}),
	check("system_settings_key_check", sql`key = 'reporter_legal_name_access'::text`),
	check("system_settings_reporter_legal_name_access_check", sql`(key <> 'reporter_legal_name_access'::text) OR (value = ANY (ARRAY['separate'::text, 'protected_source'::text]))`),
]);

export const outboxEvents = pgTable("outbox_events", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "outbox_events_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	type: text().notNull(),
	aggregateType: text("aggregate_type").notNull(),
	aggregateId: uuid("aggregate_id").notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	idempotencyKey: text("idempotency_key").notNull(),
	actorId: uuid("actor_id"),
	payload: jsonb().default({}).notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	attempts: integer().default(0).notNull(),
	nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastError: text("last_error"),
}, (table) => [
	index("outbox_events_aggregate_idx").using("btree", table.aggregateType.asc().nullsLast().op("int8_ops"), table.aggregateId.asc().nullsLast().op("uuid_ops"), table.id.asc().nullsLast().op("int8_ops")),
	index("outbox_events_pending_idx").using("btree", table.nextAttemptAt.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("timestamptz_ops")).where(sql`(published_at IS NULL)`),
	index("outbox_events_type_idx").using("btree", table.type.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.actorId],
			foreignColumns: [users.id],
			name: "outbox_events_actor_id_fkey"
		}),
	unique("outbox_events_idempotency_key_key").on(table.idempotencyKey),
	check("outbox_events_aggregate_type_check", sql`aggregate_type = ANY (ARRAY['material'::text, 'upload'::text, 'notification'::text, 'form'::text, 'user'::text, 'listing'::text, 'license'::text])`),
	check("outbox_events_attempts_nonneg", sql`attempts >= 0`),
	check("outbox_events_idempotency_key_len", sql`(char_length(idempotency_key) >= 8) AND (char_length(idempotency_key) <= 200)`),
	check("outbox_events_payload_is_object", sql`jsonb_typeof(payload) = 'object'::text`),
	check("outbox_events_payload_whitelisted", sql`CHECK (outbox_payload_is_whitelisted(type, payload`),
	check("outbox_events_type_check", sql`type = ANY (ARRAY['material.created'::text, 'material.urgent_received'::text, 'material.updated'::text, 'material.version_created'::text, 'material.technical_transition'::text, 'material.editorial_transition'::text, 'material.rights_transition'::text, 'material.acknowledged'::text, 'material.change_requested'::text, 'material.accepted_for_production'::text, 'material.reserved'::text, 'material.released'::text, 'material.contributors_set'::text, 'material.published'::text, 'upload.started'::text, 'upload.progress'::text, 'upload.proxy_received'::text, 'upload.original_received'::text, 'upload.verified'::text, 'upload.deduplicated'::text, 'upload.failed'::text, 'form.published'::text, 'ai.draft_ready'::text, 'notification.escalated'::text, 'auth.recovery_requested'::text, 'auth.recovery_approved'::text, 'user.status_changed'::text, 'auth.recovery_completed'::text, 'export.requested'::text, 'setting.changed'::text, 'catalog.listing_changed'::text, 'license.delivery_requested'::text])`),
]);

export const recoveryCodes = pgTable("recovery_codes", {
	userId: uuid("user_id").notNull(),
	codeHash: bytea("code_hash").notNull(),
	usedAt: timestamp("used_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "recovery_codes_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.userId, table.codeHash], name: "recovery_codes_pkey"}),
	check("recovery_codes_hash_len", sql`octet_length(code_hash) = 32`),
]);

export const materialContributors = pgTable("material_contributors", {
	materialId: uuid("material_id").notNull(),
	userId: uuid("user_id").notNull(),
	role: text().notNull(),
	sharePercent: numeric("share_percent", { precision: 5, scale:  2 }).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.materialId],
			foreignColumns: [materials.id],
			name: "material_contributors_material_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "material_contributors_user_id_fkey"
		}),
	primaryKey({ columns: [table.materialId, table.userId], name: "material_contributors_pkey"}),
	check("material_contributors_role_check", sql`role = ANY (ARRAY['photographer'::text, 'reporter'::text, 'editor'::text, 'fixer'::text])`),
	check("material_contributors_share_range", sql`(share_percent >= (0)::numeric) AND (share_percent <= (100)::numeric)`),
]);

export const notificationRuleEscalations = pgTable("notification_rule_escalations", {
	ruleId: uuid("rule_id").notNull(),
	level: integer().notNull(),
	afterSeconds: integer("after_seconds").notNull(),
	recipientRoles: text("recipient_roles").array().notNull(),
	channels: text().array().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.ruleId],
			foreignColumns: [notificationRules.id],
			name: "notification_rule_escalations_rule_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.ruleId, table.level], name: "notification_rule_escalations_pkey"}),
	check("notification_rule_escalations_after_range", sql`(after_seconds >= 60) AND (after_seconds <= 86400)`),
	check("notification_rule_escalations_channels_check", sql`(cardinality(channels) >= 1) AND (channels <@ ARRAY['in_app'::text, 'websocket'::text, 'apns'::text, 'fcm'::text, 'web_push'::text, 'email'::text, 'telegram'::text, 'whatsapp'::text, 'sms'::text])`),
	check("notification_rule_escalations_level_range", sql`(level >= 1) AND (level <= 5)`),
	check("notification_rule_escalations_roles_check", sql`(cardinality(recipient_roles) >= 1) AND (recipient_roles <@ ARRAY['system_admin'::text, 'editor_in_chief'::text, 'supervisor'::text, 'producer'::text, 'finance'::text, 'reporter'::text, 'rights_officer'::text])`),
]);

export const userRoles = pgTable("user_roles", {
	userId: uuid("user_id").notNull(),
	role: text().notNull(),
	scopeKind: text("scope_kind").default('all').notNull(),
	scopeId: text("scope_id").default('').notNull(),
	grantedAt: timestamp("granted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	grantedBy: uuid("granted_by"),
}, (table) => [
	index("user_roles_scope_idx").using("btree", table.role.asc().nullsLast().op("text_ops"), table.scopeKind.asc().nullsLast().op("text_ops"), table.scopeId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.grantedBy],
			foreignColumns: [users.id],
			name: "user_roles_granted_by_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "user_roles_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.userId, table.role, table.scopeKind, table.scopeId], name: "user_roles_pkey"}),
	check("user_roles_role_check", sql`role = ANY (ARRAY['system_admin'::text, 'editor_in_chief'::text, 'supervisor'::text, 'producer'::text, 'finance'::text, 'reporter'::text, 'rights_officer'::text])`),
	check("user_roles_scope_id_check", sql`(scope_kind = 'all'::text) = (scope_id = ''::text)`),
	check("user_roles_scope_kind_check", sql`scope_kind = ANY (ARRAY['all'::text, 'office'::text, 'governorate'::text])`),
]);

export const idempotencyKeys = pgTable("idempotency_keys", {
	userId: uuid("user_id").notNull(),
	key: text().notNull(),
	requestFingerprint: bytea("request_fingerprint").notNull(),
	state: text().default('in_progress').notNull(),
	responseStatus: smallint("response_status"),
	responseBody: jsonb("response_body"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).default(sql`(now() + '24:00:00'::interval)`).notNull(),
}, (table) => [
	index("idempotency_keys_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "idempotency_keys_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.userId, table.key], name: "idempotency_keys_pkey"}),
	check("idempotency_keys_completed_has_response", sql`(state <> 'completed'::text) OR (response_status IS NOT NULL)`),
	check("idempotency_keys_key_len", sql`(char_length(key) >= 8) AND (char_length(key) <= 128)`),
	check("idempotency_keys_state_check", sql`state = ANY (ARRAY['in_progress'::text, 'completed'::text])`),
]);

export const notificationDeliveries = pgTable("notification_deliveries", {
	notificationId: uuid("notification_id").notNull(),
	channel: text().notNull(),
	status: text().default('pending').notNull(),
	attempts: integer().default(0).notNull(),
	lastError: text("last_error"),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("notification_deliveries_retry_idx").using("btree", table.updatedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'failed'::text]))`),
	foreignKey({
			columns: [table.notificationId],
			foreignColumns: [notifications.id],
			name: "notification_deliveries_notification_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.notificationId, table.channel], name: "notification_deliveries_pkey"}),
	check("notification_deliveries_attempts_nonneg", sql`attempts >= 0`),
	check("notification_deliveries_channel_check", sql`channel = ANY (ARRAY['in_app'::text, 'websocket'::text, 'apns'::text, 'fcm'::text, 'web_push'::text, 'email'::text, 'telegram'::text, 'whatsapp'::text, 'sms'::text])`),
	check("notification_deliveries_status_check", sql`status = ANY (ARRAY['pending'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'failed'::text])`),
]);

export const licenseTemplates = pgTable("license_templates", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	type: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdBy: uuid("created_by").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "license_templates_created_by_fkey"
		}),
	check("license_templates_type_check", sql`type = ANY (ARRAY['editorial_single'::text, 'editorial_term'::text, 'exclusive_temporary'::text, 'commercial'::text])`),
]);

export const catalogListings = pgTable("catalog_listings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	materialId: uuid("material_id").notNull(),
	materialVersion: integer("material_version").notNull(),
	state: text().notNull(),
	suspendedReason: text("suspended_reason"),
	titleAr: text("title_ar").notNull(),
	titleEn: text("title_en").notNull(),
	descriptionAr: text("description_ar").notNull(),
	descriptionEn: text("description_en").notNull(),
	shotList: jsonb("shot_list").default([]).notNull(),
	commercialAllowed: boolean("commercial_allowed").default(false).notNull(),
	listedAt: timestamp("listed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedBy: uuid("updated_by").notNull(),
}, (table) => [
	index("catalog_listings_listed_idx").using("btree", table.listedAt.desc().nullsFirst().op("timestamptz_ops"), table.id.desc().nullsFirst().op("timestamptz_ops")).where(sql`(state = 'listed'::text)`),
	foreignKey({
			columns: [table.materialId],
			foreignColumns: [materials.id],
			name: "catalog_listings_material_id_fkey"
		}),
	foreignKey({
			columns: [table.updatedBy],
			foreignColumns: [users.id],
			name: "catalog_listings_updated_by_fkey"
		}),
	unique("catalog_listings_material_id_key").on(table.materialId),
	check("catalog_listings_listed_at_check", sql`(state <> 'listed'::text) OR (listed_at IS NOT NULL)`),
	check("catalog_listings_shot_list_check", sql`(jsonb_typeof(shot_list) = 'array'::text) AND (jsonb_array_length(shot_list) <= 200)`),
	check("catalog_listings_state_check", sql`state = ANY (ARRAY['draft'::text, 'listed'::text, 'suspended'::text])`),
	check("catalog_listings_suspended_reason_check", sql`((state = 'suspended'::text) = (suspended_reason IS NOT NULL)) AND ((suspended_reason IS NULL) OR (suspended_reason = ANY (ARRAY['manual'::text, 'rights_changed'::text])))`),
	check("catalog_listings_text_len", sql`((char_length(title_ar) >= 1) AND (char_length(title_ar) <= 4000)) AND ((char_length(title_en) >= 1) AND (char_length(title_en) <= 4000)) AND ((char_length(description_ar) >= 1) AND (char_length(description_ar) <= 4000)) AND ((char_length(description_en) >= 1) AND (char_length(description_en) <= 4000))`),
	check("catalog_listings_version_positive", sql`material_version >= 1`),
]);

export const listingOffers = pgTable("listing_offers", {
	listingId: uuid("listing_id").notNull(),
	licenseTemplateId: uuid("license_template_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	priceOverrideMinor: bigint("price_override_minor", { mode: "number" }),
	priceOverrideCurrency: text("price_override_currency"),
}, (table) => [
	index("listing_offers_template_idx").using("btree", table.licenseTemplateId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.licenseTemplateId],
			foreignColumns: [licenseTemplates.id],
			name: "listing_offers_license_template_id_fkey"
		}),
	foreignKey({
			columns: [table.listingId],
			foreignColumns: [catalogListings.id],
			name: "listing_offers_listing_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.listingId, table.licenseTemplateId], name: "listing_offers_pkey"}),
	check("listing_offers_price_override_check", sql`((price_override_minor IS NULL) = (price_override_currency IS NULL)) AND ((price_override_minor IS NULL) OR ((price_override_minor >= 0) AND (price_override_minor <= '100000000000'::bigint))) AND ((price_override_currency IS NULL) OR (price_override_currency = ANY (ARRAY['USD'::text, 'ILS'::text])))`),
]);

export const licenseTemplateVersions = pgTable("license_template_versions", {
	templateId: uuid("template_id").notNull(),
	version: integer().notNull(),
	type: text().notNull(),
	nameAr: text("name_ar").notNull(),
	nameEn: text("name_en").notNull(),
	termsAr: text("terms_ar").notNull(),
	termsEn: text("terms_en").notNull(),
	usageMedia: text("usage_media").array().notNull(),
	territoryKind: text("territory_kind").notNull(),
	territoryCountries: text("territory_countries").array(),
	termDays: integer("term_days"),
	exclusivityHours: integer("exclusivity_hours"),
	deliverables: text().array().notNull(),
	attributionAr: text("attribution_ar").notNull(),
	attributionEn: text("attribution_en").notNull(),
	prohibitions: text().array().default([""]).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	basePriceMinor: bigint("base_price_minor", { mode: "number" }).notNull(),
	currency: text().notNull(),
	enabled: boolean().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdBy: uuid("created_by").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "license_template_versions_created_by_fkey"
		}),
	foreignKey({
			columns: [table.templateId],
			foreignColumns: [licenseTemplates.id],
			name: "license_template_versions_template_id_fkey"
		}),
	primaryKey({ columns: [table.templateId, table.version], name: "license_template_versions_pkey"}),
	check("license_template_versions_currency_check", sql`currency = ANY (ARRAY['USD'::text, 'ILS'::text])`),
	check("license_template_versions_deliverables_check", sql`(cardinality(deliverables) >= 1) AND (deliverables <@ ARRAY['original'::text, 'produced'::text, 'audio'::text, 'stills'::text])`),
	check("license_template_versions_exclusivity_check", sql`((type = 'exclusive_temporary'::text) = (exclusivity_hours IS NOT NULL)) AND ((exclusivity_hours IS NULL) OR ((exclusivity_hours >= 24) AND (exclusivity_hours <= 168)))`),
	check("license_template_versions_price_check", sql`(base_price_minor >= 0) AND (base_price_minor <= '100000000000'::bigint)`),
	check("license_template_versions_prohibitions_check", sql`prohibitions <@ ARRAY['resale'::text, 'advertising'::text, 'ai_training'::text, 're_editing'::text]`),
	check("license_template_versions_term_check", sql`((term_days IS NULL) OR ((term_days >= 1) AND (term_days <= 3650))) AND ((type <> ALL (ARRAY['editorial_term'::text, 'exclusive_temporary'::text])) OR (term_days IS NOT NULL))`),
	check("license_template_versions_territory_check", sql`((territory_kind = 'worldwide'::text) AND (territory_countries IS NULL)) OR ((territory_kind = 'countries'::text) AND ((cardinality(territory_countries) >= 1) AND (cardinality(territory_countries) <= 250)))`),
	check("license_template_versions_text_len", sql`((char_length(name_ar) >= 1) AND (char_length(name_ar) <= 4000)) AND ((char_length(name_en) >= 1) AND (char_length(name_en) <= 4000)) AND ((char_length(terms_ar) >= 1) AND (char_length(terms_ar) <= 4000)) AND ((char_length(terms_en) >= 1) AND (char_length(terms_en) <= 4000)) AND ((char_length(attribution_ar) >= 1) AND (char_length(attribution_ar) <= 4000)) AND ((char_length(attribution_en) >= 1) AND (char_length(attribution_en) <= 4000))`),
	check("license_template_versions_usage_media_check", sql`(cardinality(usage_media) >= 1) AND (usage_media <@ ARRAY['tv'::text, 'web'::text, 'social'::text, 'documentary'::text, 'advertising'::text])`),
	check("license_template_versions_version_positive", sql`version >= 1`),
]);
