import { relations } from "drizzle-orm/relations";
import { buyerInviteConflicts, buyerOrganizations, catalogListings, deviceAttestationKeys, exclusiveHolds, idempotencyKeys, journalEntries, ledgerAccounts, licenseDownloadGrants, licenseTemplateVersions, licenseTemplates, licenses, listingOffers, materialContributors, materialExports, materialFiles, materialTransitions, materials, notificationDeliveries, notificationRuleEscalations, notificationRules, notifications, offices, orderItems, orders, outboxEvents, paymentEvents, postings, pushDevices, recoveryCodes, recoveryRequests, refreshTokens, systemSettings, uploadForms, uploadSessions, userPermissions, userRoles, users } from "./schema";

export const refreshTokensRelations = relations(refreshTokens, ({one, many}) => ({
	refreshToken: one(refreshTokens, {
		fields: [refreshTokens.replacedBy],
		references: [refreshTokens.id],
		relationName: "refreshTokens_replacedBy_refreshTokens_id"
	}),
	refreshTokens: many(refreshTokens, {
		relationName: "refreshTokens_replacedBy_refreshTokens_id"
	}),
	user: one(users, {
		fields: [refreshTokens.userId],
		references: [users.id]
	}),
}));

export const usersRelations = relations(users, ({one, many}) => ({
	refreshTokens: many(refreshTokens),
	pushDevices: many(pushDevices),
	uploadForms: many(uploadForms),
	materialTransitions: many(materialTransitions),
	recoveryRequests_approvedBy: many(recoveryRequests, {
		relationName: "recoveryRequests_approvedBy_users_id"
	}),
	recoveryRequests_userId: many(recoveryRequests, {
		relationName: "recoveryRequests_userId_users_id"
	}),
	deviceAttestationKeys: many(deviceAttestationKeys),
	materials_acknowledgedBy: many(materials, {
		relationName: "materials_acknowledgedBy_users_id"
	}),
	materials_reporterId: many(materials, {
		relationName: "materials_reporterId_users_id"
	}),
	materials_reservedBy: many(materials, {
		relationName: "materials_reservedBy_users_id"
	}),
	notifications: many(notifications),
	materialExports: many(materialExports),
	userPermissions_grantedBy: many(userPermissions, {
		relationName: "userPermissions_grantedBy_users_id"
	}),
	userPermissions_revokedBy: many(userPermissions, {
		relationName: "userPermissions_revokedBy_users_id"
	}),
	userPermissions_userId: many(userPermissions, {
		relationName: "userPermissions_userId_users_id"
	}),
	systemSettings: many(systemSettings),
	notificationRules_createdBy: many(notificationRules, {
		relationName: "notificationRules_createdBy_users_id"
	}),
	notificationRules_updatedBy: many(notificationRules, {
		relationName: "notificationRules_updatedBy_users_id"
	}),
	licenseTemplates: many(licenseTemplates),
	office: one(offices, {
		fields: [users.officeId],
		references: [offices.id]
	}),
	buyerOrganization: one(buyerOrganizations, {
		fields: [users.organizationId],
		references: [buyerOrganizations.id]
	}),
	uploadSessions: many(uploadSessions),
	catalogListings: many(catalogListings),
	ledgerAccounts: many(ledgerAccounts),
	journalEntries: many(journalEntries),
	orders: many(orders),
	licenseDownloadGrants: many(licenseDownloadGrants),
	outboxEvents: many(outboxEvents),
	buyerInviteConflicts_existingUserId: many(buyerInviteConflicts, {
		relationName: "buyerInviteConflicts_existingUserId_users_id"
	}),
	buyerInviteConflicts_invitedBy: many(buyerInviteConflicts, {
		relationName: "buyerInviteConflicts_invitedBy_users_id"
	}),
	buyerInviteConflicts_resolvedBy: many(buyerInviteConflicts, {
		relationName: "buyerInviteConflicts_resolvedBy_users_id"
	}),
	recoveryCodes: many(recoveryCodes),
	materialContributors: many(materialContributors),
	userRoles_grantedBy: many(userRoles, {
		relationName: "userRoles_grantedBy_users_id"
	}),
	userRoles_userId: many(userRoles, {
		relationName: "userRoles_userId_users_id"
	}),
	idempotencyKeys: many(idempotencyKeys),
	licenseTemplateVersions: many(licenseTemplateVersions),
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
	user: one(users, {
		fields: [materialTransitions.actorId],
		references: [users.id]
	}),
	material: one(materials, {
		fields: [materialTransitions.materialId],
		references: [materials.id]
	}),
}));

export const materialsRelations = relations(materials, ({one, many}) => ({
	orderItems: many(orderItems),
	licenses: many(licenses),
	exclusiveHolds: many(exclusiveHolds),
	materialTransitions: many(materialTransitions),
	user_acknowledgedBy: one(users, {
		fields: [materials.acknowledgedBy],
		references: [users.id],
		relationName: "materials_acknowledgedBy_users_id"
	}),
	uploadForm: one(uploadForms, {
		fields: [materials.formVersion],
		references: [uploadForms.version]
	}),
	office: one(offices, {
		fields: [materials.officeId],
		references: [offices.id]
	}),
	user_reporterId: one(users, {
		fields: [materials.reporterId],
		references: [users.id],
		relationName: "materials_reporterId_users_id"
	}),
	user_reservedBy: one(users, {
		fields: [materials.reservedBy],
		references: [users.id],
		relationName: "materials_reservedBy_users_id"
	}),
	notifications: many(notifications),
	materialExports: many(materialExports),
	uploadSessions: many(uploadSessions),
	catalogListings: many(catalogListings),
	materialFiles: many(materialFiles),
	materialContributors: many(materialContributors),
}));

export const uploadSessionsRelations = relations(uploadSessions, ({one, many}) => ({
	user: one(users, {
		fields: [uploadSessions.createdBy],
		references: [users.id]
	}),
	materialFile_duplicateOfFileId: one(materialFiles, {
		fields: [uploadSessions.duplicateOfFileId],
		references: [materialFiles.id],
		relationName: "uploadSessions_duplicateOfFileId_materialFiles_id"
	}),
	materialFile_fileId: one(materialFiles, {
		fields: [uploadSessions.fileId],
		references: [materialFiles.id],
		relationName: "uploadSessions_fileId_materialFiles_id"
	}),
	material: one(materials, {
		fields: [uploadSessions.materialId],
		references: [materials.id]
	}),
	materialFiles: many(materialFiles, {
		relationName: "materialFiles_uploadSessionId_uploadSessions_id"
	}),
}));

export const materialFilesRelations = relations(materialFiles, ({one, many}) => ({
	uploadSessions_duplicateOfFileId: many(uploadSessions, {
		relationName: "uploadSessions_duplicateOfFileId_materialFiles_id"
	}),
	uploadSessions_fileId: many(uploadSessions, {
		relationName: "uploadSessions_fileId_materialFiles_id"
	}),
	materialExports_fileId: many(materialExports, {
		relationName: "materialExports_fileId_materialFiles_id"
	}),
	materialExports_sourceFileId: many(materialExports, {
		relationName: "materialExports_sourceFileId_materialFiles_id"
	}),
	materialFile_alignmentOriginalFileId: one(materialFiles, {
		fields: [materialFiles.alignmentOriginalFileId],
		references: [materialFiles.id],
		relationName: "materialFiles_alignmentOriginalFileId_materialFiles_id"
	}),
	materialFiles_alignmentOriginalFileId: many(materialFiles, {
		relationName: "materialFiles_alignmentOriginalFileId_materialFiles_id"
	}),
	materialFile_derivedFromId: one(materialFiles, {
		fields: [materialFiles.derivedFromId],
		references: [materialFiles.id],
		relationName: "materialFiles_derivedFromId_materialFiles_id"
	}),
	materialFiles_derivedFromId: many(materialFiles, {
		relationName: "materialFiles_derivedFromId_materialFiles_id"
	}),
	material: one(materials, {
		fields: [materialFiles.materialId],
		references: [materials.id]
	}),
	uploadSession: one(uploadSessions, {
		fields: [materialFiles.uploadSessionId],
		references: [uploadSessions.id],
		relationName: "materialFiles_uploadSessionId_uploadSessions_id"
	}),
}));

export const recoveryRequestsRelations = relations(recoveryRequests, ({one, many}) => ({
	user_approvedBy: one(users, {
		fields: [recoveryRequests.approvedBy],
		references: [users.id],
		relationName: "recoveryRequests_approvedBy_users_id"
	}),
	user_userId: one(users, {
		fields: [recoveryRequests.userId],
		references: [users.id],
		relationName: "recoveryRequests_userId_users_id"
	}),
	notifications: many(notifications),
}));

export const deviceAttestationKeysRelations = relations(deviceAttestationKeys, ({one}) => ({
	user: one(users, {
		fields: [deviceAttestationKeys.userId],
		references: [users.id]
	}),
}));

export const officesRelations = relations(offices, ({many}) => ({
	users: many(users),
	materials: many(materials),
}));

export const notificationRulesRelations = relations(notificationRules, ({one, many}) => ({
	user_createdBy: one(users, {
		fields: [notificationRules.createdBy],
		references: [users.id],
		relationName: "notificationRules_createdBy_users_id"
	}),
	user_updatedBy: one(users, {
		fields: [notificationRules.updatedBy],
		references: [users.id],
		relationName: "notificationRules_updatedBy_users_id"
	}),
	notifications: many(notifications),
	notificationRuleEscalations: many(notificationRuleEscalations),
}));

export const notificationsRelations = relations(notifications, ({one, many}) => ({
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
	notificationRule: one(notificationRules, {
		fields: [notifications.ruleId],
		references: [notificationRules.id]
	}),
	user: one(users, {
		fields: [notifications.userId],
		references: [users.id]
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

export const materialExportsRelations = relations(materialExports, ({one}) => ({
	materialFile_fileId: one(materialFiles, {
		fields: [materialExports.fileId],
		references: [materialFiles.id],
		relationName: "materialExports_fileId_materialFiles_id"
	}),
	material: one(materials, {
		fields: [materialExports.materialId],
		references: [materials.id]
	}),
	user: one(users, {
		fields: [materialExports.requestedBy],
		references: [users.id]
	}),
	materialFile_sourceFileId: one(materialFiles, {
		fields: [materialExports.sourceFileId],
		references: [materialFiles.id],
		relationName: "materialExports_sourceFileId_materialFiles_id"
	}),
}));

export const userPermissionsRelations = relations(userPermissions, ({one}) => ({
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
	user_userId: one(users, {
		fields: [userPermissions.userId],
		references: [users.id],
		relationName: "userPermissions_userId_users_id"
	}),
}));

export const systemSettingsRelations = relations(systemSettings, ({one}) => ({
	user: one(users, {
		fields: [systemSettings.updatedBy],
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

export const notificationRuleEscalationsRelations = relations(notificationRuleEscalations, ({one}) => ({
	notificationRule: one(notificationRules, {
		fields: [notificationRuleEscalations.ruleId],
		references: [notificationRules.id]
	}),
}));

export const userRolesRelations = relations(userRoles, ({one}) => ({
	user_grantedBy: one(users, {
		fields: [userRoles.grantedBy],
		references: [users.id],
		relationName: "userRoles_grantedBy_users_id"
	}),
	user_userId: one(users, {
		fields: [userRoles.userId],
		references: [users.id],
		relationName: "userRoles_userId_users_id"
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

export const licenseTemplatesRelations = relations(licenseTemplates, ({one, many}) => ({
	user: one(users, {
		fields: [licenseTemplates.createdBy],
		references: [users.id]
	}),
	listingOffers: many(listingOffers),
	licenseTemplateVersions: many(licenseTemplateVersions),
}));

export const catalogListingsRelations = relations(catalogListings, ({one, many}) => ({
	orderItems: many(orderItems),
	material: one(materials, {
		fields: [catalogListings.materialId],
		references: [materials.id]
	}),
	user: one(users, {
		fields: [catalogListings.updatedBy],
		references: [users.id]
	}),
	listingOffers: many(listingOffers),
}));

export const listingOffersRelations = relations(listingOffers, ({one}) => ({
	licenseTemplate: one(licenseTemplates, {
		fields: [listingOffers.licenseTemplateId],
		references: [licenseTemplates.id]
	}),
	catalogListing: one(catalogListings, {
		fields: [listingOffers.listingId],
		references: [catalogListings.id]
	}),
}));

export const licenseTemplateVersionsRelations = relations(licenseTemplateVersions, ({one, many}) => ({
	orderItems: many(orderItems),
	user: one(users, {
		fields: [licenseTemplateVersions.createdBy],
		references: [users.id]
	}),
	licenseTemplate: one(licenseTemplates, {
		fields: [licenseTemplateVersions.templateId],
		references: [licenseTemplates.id]
	}),
}));

export const buyerOrganizationsRelations = relations(buyerOrganizations, ({many}) => ({
	users: many(users),
	orders: many(orders),
	licenses: many(licenses),
	buyerInviteConflicts: many(buyerInviteConflicts),
}));

export const ledgerAccountsRelations = relations(ledgerAccounts, ({one, many}) => ({
	user: one(users, {
		fields: [ledgerAccounts.ownerId],
		references: [users.id]
	}),
	postings: many(postings),
}));

export const journalEntriesRelations = relations(journalEntries, ({one, many}) => ({
	user: one(users, {
		fields: [journalEntries.actorId],
		references: [users.id]
	}),
	journalEntry: one(journalEntries, {
		fields: [journalEntries.reversesEntryId],
		references: [journalEntries.id],
		relationName: "journalEntries_reversesEntryId_journalEntries_id"
	}),
	journalEntries: many(journalEntries, {
		relationName: "journalEntries_reversesEntryId_journalEntries_id"
	}),
	postings: many(postings),
}));

export const postingsRelations = relations(postings, ({one}) => ({
	ledgerAccount: one(ledgerAccounts, {
		fields: [postings.accountId],
		references: [ledgerAccounts.id]
	}),
	journalEntry: one(journalEntries, {
		fields: [postings.entryId],
		references: [journalEntries.id]
	}),
}));

export const ordersRelations = relations(orders, ({one, many}) => ({
	user: one(users, {
		fields: [orders.createdBy],
		references: [users.id]
	}),
	buyerOrganization: one(buyerOrganizations, {
		fields: [orders.organizationId],
		references: [buyerOrganizations.id]
	}),
	orderItems: many(orderItems),
	paymentEvents: many(paymentEvents),
}));

export const orderItemsRelations = relations(orderItems, ({one, many}) => ({
	licenseTemplateVersion: one(licenseTemplateVersions, {
		fields: [orderItems.licenseTemplateId],
		references: [licenseTemplateVersions.templateId]
	}),
	catalogListing: one(catalogListings, {
		fields: [orderItems.listingId],
		references: [catalogListings.id]
	}),
	material: one(materials, {
		fields: [orderItems.materialId],
		references: [materials.id]
	}),
	order: one(orders, {
		fields: [orderItems.orderId],
		references: [orders.id]
	}),
	licenses: many(licenses),
	exclusiveHolds: many(exclusiveHolds),
}));

export const licensesRelations = relations(licenses, ({one, many}) => ({
	material: one(materials, {
		fields: [licenses.materialId],
		references: [materials.id]
	}),
	orderItem: one(orderItems, {
		fields: [licenses.orderItemId],
		references: [orderItems.id]
	}),
	buyerOrganization: one(buyerOrganizations, {
		fields: [licenses.organizationId],
		references: [buyerOrganizations.id]
	}),
	licenseDownloadGrants: many(licenseDownloadGrants),
}));

export const exclusiveHoldsRelations = relations(exclusiveHolds, ({one}) => ({
	material: one(materials, {
		fields: [exclusiveHolds.materialId],
		references: [materials.id]
	}),
	orderItem: one(orderItems, {
		fields: [exclusiveHolds.orderItemId],
		references: [orderItems.id]
	}),
}));

export const licenseDownloadGrantsRelations = relations(licenseDownloadGrants, ({one}) => ({
	user: one(users, {
		fields: [licenseDownloadGrants.issuedTo],
		references: [users.id]
	}),
	license: one(licenses, {
		fields: [licenseDownloadGrants.licenseId],
		references: [licenses.id]
	}),
}));

export const paymentEventsRelations = relations(paymentEvents, ({one}) => ({
	order: one(orders, {
		fields: [paymentEvents.orderId],
		references: [orders.id]
	}),
}));

export const buyerInviteConflictsRelations = relations(buyerInviteConflicts, ({one}) => ({
	user_existingUserId: one(users, {
		fields: [buyerInviteConflicts.existingUserId],
		references: [users.id],
		relationName: "buyerInviteConflicts_existingUserId_users_id"
	}),
	user_invitedBy: one(users, {
		fields: [buyerInviteConflicts.invitedBy],
		references: [users.id],
		relationName: "buyerInviteConflicts_invitedBy_users_id"
	}),
	buyerOrganization: one(buyerOrganizations, {
		fields: [buyerInviteConflicts.organizationId],
		references: [buyerOrganizations.id]
	}),
	user_resolvedBy: one(users, {
		fields: [buyerInviteConflicts.resolvedBy],
		references: [users.id],
		relationName: "buyerInviteConflicts_resolvedBy_users_id"
	}),
}));
