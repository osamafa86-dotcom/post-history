import { relations } from "drizzle-orm/relations";
import { deviceAttestationKeys, idempotencyKeys, materialContributors, materialFiles, materialTransitions, materials, notificationDeliveries, notifications, offices, outboxEvents, pushDevices, recoveryCodes, recoveryRequests, refreshTokens, uploadForms, uploadSessions, userPermissions, userRoles, users } from "./schema";

export const refreshTokensRelations = relations(refreshTokens, ({one, many}) => ({
	user: one(users, {
		fields: [refreshTokens.userId],
		references: [users.id]
	}),
	refreshToken: one(refreshTokens, {
		fields: [refreshTokens.replacedBy],
		references: [refreshTokens.id],
		relationName: "refreshTokens_replacedBy_refreshTokens_id"
	}),
	refreshTokens: many(refreshTokens, {
		relationName: "refreshTokens_replacedBy_refreshTokens_id"
	}),
}));

export const usersRelations = relations(users, ({one, many}) => ({
	refreshTokens: many(refreshTokens),
	pushDevices: many(pushDevices),
	uploadForms: many(uploadForms),
	materialTransitions: many(materialTransitions),
	userPermissions_userId: many(userPermissions, {
		relationName: "userPermissions_userId_users_id"
	}),
	userPermissions_grantedBy: many(userPermissions, {
		relationName: "userPermissions_grantedBy_users_id"
	}),
	userPermissions_revokedBy: many(userPermissions, {
		relationName: "userPermissions_revokedBy_users_id"
	}),
	materials_reporterId: many(materials, {
		relationName: "materials_reporterId_users_id"
	}),
	materials_reservedBy: many(materials, {
		relationName: "materials_reservedBy_users_id"
	}),
	uploadSessions: many(uploadSessions),
	office: one(offices, {
		fields: [users.officeId],
		references: [offices.id]
	}),
	recoveryRequests_userId: many(recoveryRequests, {
		relationName: "recoveryRequests_userId_users_id"
	}),
	recoveryRequests_approvedBy: many(recoveryRequests, {
		relationName: "recoveryRequests_approvedBy_users_id"
	}),
	notifications: many(notifications),
	deviceAttestationKeys: many(deviceAttestationKeys),
	outboxEvents: many(outboxEvents),
	recoveryCodes: many(recoveryCodes),
	materialContributors: many(materialContributors),
	userRoles_userId: many(userRoles, {
		relationName: "userRoles_userId_users_id"
	}),
	userRoles_grantedBy: many(userRoles, {
		relationName: "userRoles_grantedBy_users_id"
	}),
	idempotencyKeys: many(idempotencyKeys),
}));

export const pushDevicesRelations = relations(pushDevices, ({one}) => ({
	user: one(users, {
		fields: [pushDevices.userId],
		references: [users.id]
	}),
}));

export const uploadFormsRelations = relations(uploadForms, ({one, many}) => ({
	user: one(users, {
		fields: [uploadForms.publishedBy],
		references: [users.id]
	}),
	materials: many(materials),
}));

export const materialTransitionsRelations = relations(materialTransitions, ({one}) => ({
	material: one(materials, {
		fields: [materialTransitions.materialId],
		references: [materials.id]
	}),
	user: one(users, {
		fields: [materialTransitions.actorId],
		references: [users.id]
	}),
}));

export const materialsRelations = relations(materials, ({one, many}) => ({
	materialTransitions: many(materialTransitions),
	materialFiles: many(materialFiles),
	user_reporterId: one(users, {
		fields: [materials.reporterId],
		references: [users.id],
		relationName: "materials_reporterId_users_id"
	}),
	office: one(offices, {
		fields: [materials.officeId],
		references: [offices.id]
	}),
	uploadForm: one(uploadForms, {
		fields: [materials.formVersion],
		references: [uploadForms.version]
	}),
	user_reservedBy: one(users, {
		fields: [materials.reservedBy],
		references: [users.id],
		relationName: "materials_reservedBy_users_id"
	}),
	uploadSessions: many(uploadSessions),
	notifications: many(notifications),
	materialContributors: many(materialContributors),
}));

export const userPermissionsRelations = relations(userPermissions, ({one}) => ({
	user_userId: one(users, {
		fields: [userPermissions.userId],
		references: [users.id],
		relationName: "userPermissions_userId_users_id"
	}),
	user_grantedBy: one(users, {
		fields: [userPermissions.grantedBy],
		references: [users.id],
		relationName: "userPermissions_grantedBy_users_id"
	}),
	user_revokedBy: one(users, {
		fields: [userPermissions.revokedBy],
		references: [users.id],
		relationName: "userPermissions_revokedBy_users_id"
	}),
}));

export const materialFilesRelations = relations(materialFiles, ({one, many}) => ({
	material: one(materials, {
		fields: [materialFiles.materialId],
		references: [materials.id]
	}),
	materialFile: one(materialFiles, {
		fields: [materialFiles.derivedFromId],
		references: [materialFiles.id],
		relationName: "materialFiles_derivedFromId_materialFiles_id"
	}),
	materialFiles: many(materialFiles, {
		relationName: "materialFiles_derivedFromId_materialFiles_id"
	}),
	uploadSession: one(uploadSessions, {
		fields: [materialFiles.uploadSessionId],
		references: [uploadSessions.id],
		relationName: "materialFiles_uploadSessionId_uploadSessions_id"
	}),
	uploadSessions_fileId: many(uploadSessions, {
		relationName: "uploadSessions_fileId_materialFiles_id"
	}),
	uploadSessions_duplicateOfFileId: many(uploadSessions, {
		relationName: "uploadSessions_duplicateOfFileId_materialFiles_id"
	}),
}));

export const uploadSessionsRelations = relations(uploadSessions, ({one, many}) => ({
	materialFiles: many(materialFiles, {
		relationName: "materialFiles_uploadSessionId_uploadSessions_id"
	}),
	material: one(materials, {
		fields: [uploadSessions.materialId],
		references: [materials.id]
	}),
	user: one(users, {
		fields: [uploadSessions.createdBy],
		references: [users.id]
	}),
	materialFile_fileId: one(materialFiles, {
		fields: [uploadSessions.fileId],
		references: [materialFiles.id],
		relationName: "uploadSessions_fileId_materialFiles_id"
	}),
	materialFile_duplicateOfFileId: one(materialFiles, {
		fields: [uploadSessions.duplicateOfFileId],
		references: [materialFiles.id],
		relationName: "uploadSessions_duplicateOfFileId_materialFiles_id"
	}),
}));

export const officesRelations = relations(offices, ({many}) => ({
	materials: many(materials),
	users: many(users),
}));

export const recoveryRequestsRelations = relations(recoveryRequests, ({one, many}) => ({
	user_userId: one(users, {
		fields: [recoveryRequests.userId],
		references: [users.id],
		relationName: "recoveryRequests_userId_users_id"
	}),
	user_approvedBy: one(users, {
		fields: [recoveryRequests.approvedBy],
		references: [users.id],
		relationName: "recoveryRequests_approvedBy_users_id"
	}),
	notifications: many(notifications),
}));

export const notificationsRelations = relations(notifications, ({one, many}) => ({
	user: one(users, {
		fields: [notifications.userId],
		references: [users.id]
	}),
	outboxEvent: one(outboxEvents, {
		fields: [notifications.eventId],
		references: [outboxEvents.id]
	}),
	material: one(materials, {
		fields: [notifications.materialId],
		references: [materials.id]
	}),
	recoveryRequest: one(recoveryRequests, {
		fields: [notifications.recoveryRequestId],
		references: [recoveryRequests.id]
	}),
	notificationDeliveries: many(notificationDeliveries),
}));

export const outboxEventsRelations = relations(outboxEvents, ({one, many}) => ({
	notifications: many(notifications),
	user: one(users, {
		fields: [outboxEvents.actorId],
		references: [users.id]
	}),
}));

export const deviceAttestationKeysRelations = relations(deviceAttestationKeys, ({one}) => ({
	user: one(users, {
		fields: [deviceAttestationKeys.userId],
		references: [users.id]
	}),
}));

export const recoveryCodesRelations = relations(recoveryCodes, ({one}) => ({
	user: one(users, {
		fields: [recoveryCodes.userId],
		references: [users.id]
	}),
}));

export const materialContributorsRelations = relations(materialContributors, ({one}) => ({
	material: one(materials, {
		fields: [materialContributors.materialId],
		references: [materials.id]
	}),
	user: one(users, {
		fields: [materialContributors.userId],
		references: [users.id]
	}),
}));

export const userRolesRelations = relations(userRoles, ({one}) => ({
	user_userId: one(users, {
		fields: [userRoles.userId],
		references: [users.id],
		relationName: "userRoles_userId_users_id"
	}),
	user_grantedBy: one(users, {
		fields: [userRoles.grantedBy],
		references: [users.id],
		relationName: "userRoles_grantedBy_users_id"
	}),
}));

export const idempotencyKeysRelations = relations(idempotencyKeys, ({one}) => ({
	user: one(users, {
		fields: [idempotencyKeys.userId],
		references: [users.id]
	}),
}));

export const notificationDeliveriesRelations = relations(notificationDeliveries, ({one}) => ({
	notification: one(notifications, {
		fields: [notificationDeliveries.notificationId],
		references: [notifications.id]
	}),
}));