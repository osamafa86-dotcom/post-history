import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { actionPath, actionRoutes } from "../src/server/review-actions";
import { identityAccesses, identityReasons, pageLimits, permissions, reasonLimits } from "../src/lib/admin-policy";
import { states } from "../src/lib/query";
import * as buyers from "../src/lib/buyer-policy";
import * as issued from "../src/lib/issued-licenses";
import * as orders from "../src/lib/order-policy";
import { uploadRoles } from "../src/lib/upload-policy";
import { catalogRoles, licenseTypes } from "../src/server/catalog";
import { channels, roles, ruleEvents, ruleLimits, scopeKinds } from "../src/lib/notification-policy";
import * as license from "../src/lib/license-policy";
import * as listing from "../src/lib/listing-policy";
import * as commission from "../src/lib/commission-policy";
import * as refunds from "../src/lib/refund-policy";
import * as conflicts from "../src/lib/invite-conflict-policy";
import { formReaders, formWriters } from "../src/lib/form-admin";

const { load } = createRequire(import.meta.url)("js-yaml") as { load: (text: string) => unknown };
const contract = load(readFileSync(new URL("../../../contracts/openapi.yaml", import.meta.url), "utf8"));
function at(...path: string[]): unknown {
  return path.reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || !(key in value)) throw new Error(`Missing contract path: ${path.join(".")}`);
    return (value as Record<string, unknown>)[key];
  }, contract);
}
describe("BFF policy remains aligned with the checked-in OpenAPI contract", () => {
  it("matches form administration roles and publication preconditions", () => {
    expect(formReaders).toEqual(at("paths", "/forms", "get", "x-roles"));
    expect(formWriters).toEqual(at("paths", "/forms", "post", "x-roles"));
    expect(at("paths", "/forms", "post", "parameters")).toEqual(expect.arrayContaining([{ $ref: "#/components/parameters/IdempotencyKey" }, { $ref: "#/components/parameters/IfMatch" }]));
  });
  it("matches permission and reporter identity enums, including coded reasons", () => {
    expect(permissions).toEqual(at("components", "schemas", "Permission", "enum"));
    expect(identityAccesses).toEqual(at("components", "schemas", "ReporterIdentityAccess", "enum"));
    expect(identityReasons).toEqual(at("components", "schemas", "ReporterIdentitySettingUpdate", "properties", "reason_code", "enum"));
  });
  it("matches reason length and pagination limits", () => {
    expect(reasonLimits.transition).toBe(at("components", "schemas", "Transition", "properties", "reason", "maxLength"));
    expect(reasonLimits.permission).toBe(at("paths", "/users/{id}/permissions/{permission}", "put", "requestBody", "content", "application/json", "schema", "properties", "reason", "maxLength"));
    expect(pageLimits).toEqual({ min: at("components", "parameters", "Limit", "schema", "minimum"), max: at("components", "parameters", "Limit", "schema", "maximum"), default: at("components", "parameters", "Limit", "schema", "default") });
  });
  it("only forwards supported write paths and methods with contract idempotency", () => {
    for (const route of actionRoutes) for (const method of route.methods) {
      expect(at("paths", route.path, method, "parameters")).toContainEqual({ $ref: "#/components/parameters/IdempotencyKey" });
      expect(actionPath(route.path.slice(1).replace("{id}", "10000000-0000-4000-8000-000000000002").replace("{permission}", "reporter_identity:read"), method)).toBe(true);
    }
    expect(actionPath("admin/settings/reporter-identity/extra", "PUT")).toBe(false);
    expect(actionPath("admin/settings/reporter-identity", "DELETE")).toBe(false);
    expect(actionPath("users/10000000-0000-4000-8000-000000000002/status", "POST")).toBe(false);
  });
  it("keeps notification rule choices and limits aligned with the contract", () => {
    const input = (...p: string[]) => at("components", "schemas", "NotificationRuleInput", "properties", ...p), step = (...p: string[]) => at("components", "schemas", "NotificationEscalationStep", "properties", ...p);
    expect(ruleEvents).toEqual(input("event_type", "enum")); expect(channels).toEqual(at("components", "schemas", "NotificationChannel", "enum"));
    expect(at("components", "schemas", "RoleName", "enum")).toEqual(expect.arrayContaining([...roles])); expect(scopeKinds).toEqual(input("scope_kind", "enum"));
    expect([ruleLimits.name, ruleLimits.scope, ruleLimits.delay, ruleLimits.digestMin, ruleLimits.digestMax, ruleLimits.steps, ruleLimits.stepMin, ruleLimits.stepMax]).toEqual([input("name", "maxLength"), input("scope_id", "maxLength"), input("delay_seconds", "maximum"), input("digest_interval_minutes", "minimum"), input("digest_interval_minutes", "maximum"), input("escalation", "maxItems"), step("after_seconds", "minimum"), step("after_seconds", "maximum")]);
  });
  it("opens desktop upload to exactly the roles the contract allows", () => {
    for (const [path, method] of [["/materials", "post"], ["/uploads", "post"], ["/uploads/{id}/web-ingest-token", "post"]]) expect([...uploadRoles]).toEqual(at("paths", path, method, "x-roles"));
  });
  it("keeps catalog roles and license types aligned with v0.3", () => {
    // أدوار المشترين (#192) تُضاف إلى x-roles قبل حساب المؤسسة في الويب (#203 بند 31)؛ الواجهة تبقى على أدوار العقد وحدها.
    for (const path of ["/catalog", "/catalog/{listing_id}", "/catalog/{listing_id}/preview-url"]) expect([...catalogRoles]).toEqual(at("paths", path, "get", "x-roles"));
    expect([...licenseTypes]).toEqual(at("components", "schemas", "LicenseType", "enum"));
  });
  it("keeps license template roles, choices and limits aligned with v0.3", () => {
    const field = (...p: string[]) => at("components", "schemas", "LicenseTemplateFields", "properties", ...p);
    for (const path of ["/license-templates", "/license-templates/{template_id}"]) expect([...license.templateRoles]).toEqual(at("paths", path, "get", "x-roles"));
    for (const [path, method] of [["/license-templates", "post"], ["/license-templates/{template_id}", "put"]]) expect([...license.templateWriters]).toEqual(at("paths", path, method, "x-roles"));
    expect([...license.licenseTypes]).toEqual(at("components", "schemas", "LicenseType", "enum")); expect([...license.currencies]).toEqual(at("components", "schemas", "Currency", "enum"));
    expect([...license.usageMedia]).toEqual(field("usage_media", "items", "enum")); expect([...license.deliverables]).toEqual(field("deliverables", "items", "enum")); expect([...license.prohibitions]).toEqual(field("prohibitions", "items", "enum"));
    const l = license.templateLimits;
    expect([l.text, l.countries, l.termMin, l.termMax, l.hoursMin, l.hoursMax, l.amountMax]).toEqual([at("components", "schemas", "LocalizedText", "properties", "ar", "maxLength"), field("territory", "properties", "countries", "maxItems"), field("term_days", "minimum"), field("term_days", "maximum"), field("exclusivity_hours", "minimum"), field("exclusivity_hours", "maximum"), at("components", "schemas", "Money", "properties", "amount_minor", "maximum")]);
  });
  it("keeps catalog listing roles, states and limits aligned with v0.3", () => {
    const field = (...p: string[]) => at("components", "schemas", "CatalogListingFields", "properties", ...p);
    expect([...listing.listingReaders]).toEqual(at("paths", "/materials/{id}/listing", "get", "x-roles"));
    for (const method of ["post", "put"]) expect([...listing.listingWriters]).toEqual(at("paths", "/materials/{id}/listing", method, "x-roles"));
    expect([...listing.listingStates]).toEqual(at("components", "schemas", "ListingState", "enum"));
    expect([listing.listingLimits.offers, listing.listingLimits.shots]).toEqual([field("offers", "maxItems"), field("shot_list", "maxItems")]);
  });
  it("keeps buyer organization roles, choices and limits aligned with v0.3", () => {
    const roles = (path: string, method: string) => at("paths", path, method, "x-roles");
    expect([...buyers.organizationAdmins]).toEqual(roles("/buyer-organizations", "get")); expect(roles("/buyer-organizations", "post")).toEqual(["system_admin"]);
    expect([...buyers.organizationReaders]).toEqual(roles("/buyer-organizations/{org_id}", "get")); expect([...buyers.organizationEditors]).toEqual(roles("/buyer-organizations/{org_id}", "put"));
    for (const [path, method] of [["/buyer-organizations/{org_id}/members", "get"], ["/buyer-organizations/{org_id}/members", "post"], ["/buyer-organizations/{org_id}/members/{user_id}", "put"]]) expect([...buyers.memberManagers]).toEqual(roles(path, method));
    expect([...buyers.buyerRoles]).toEqual(at("components", "schemas", "BuyerRole", "enum")); expect([...buyers.organizationStatuses]).toEqual(at("components", "schemas", "BuyerOrganizationStatus", "enum"));
    expect([...buyers.memberStatuses]).toEqual(at("components", "schemas", "BuyerMemberUpdate", "properties", "status", "enum"));
    const f = (...p: string[]) => at("components", "schemas", "BuyerOrganizationFields", "properties", ...p);
    expect([buyers.organizationLimits.legalName, buyers.organizationLimits.email, buyers.organizationLimits.seatsMin, buyers.organizationLimits.seatsMax]).toEqual([f("legal_name", "maxLength"), f("billing_email", "maxLength"), f("seats", "minimum"), f("seats", "maximum")]);
  });
  it("keeps commission rule roles, scopes and limits aligned with v0.3", () => {
    expect([...commission.commissionReaders]).toEqual(at("paths", "/commission-rules", "get", "x-roles")); expect([...commission.commissionWriters]).toEqual(at("paths", "/commission-rules", "post", "x-roles"));
    expect([...commission.commissionScopes]).toEqual(at("components", "schemas", "CommissionScope", "enum"));
    const f = (...p: string[]) => at("components", "schemas", "CommissionRuleFields", "properties", ...p);
    expect(commission.basisPointsMax).toBe(f("platform_basis_points", "maximum")); expect(f("platform_basis_points", "minimum")).toBe(0);
    expect(at("components", "schemas", "CommissionRuleFields", "required")).toEqual(["scope", "scope_id", "license_type", "platform_basis_points", "effective_from"]);
  });
  it("keeps refund roles, reasons, statuses and limits aligned with v0.3", () => {
    expect([...refunds.refundReaders]).toEqual(at("paths", "/orders/{order_id}/refunds", "get", "x-roles")); expect([...refunds.refundWriters]).toEqual(at("paths", "/orders/{order_id}/refunds", "post", "x-roles"));
    expect([...refunds.refundReasons]).toEqual(at("components", "schemas", "RefundReason", "enum")); expect([...refunds.refundStatuses]).toEqual(at("components", "schemas", "Refund", "properties", "status", "enum"));
    expect(refunds.refundLimits.items).toBe(at("components", "schemas", "RefundCreate", "properties", "order_item_ids", "maxItems"));
    expect(at("components", "schemas", "RefundCreate", "additionalProperties")).toBe(false);
  });
  it("keeps the invite conflict queue aligned with #361", () => {
    for (const [path, method] of [["/buyer-invite-conflicts", "get"], ["/buyer-invite-conflicts/{conflict_id}/resolve", "post"]]) expect([...conflicts.conflictRoles]).toEqual(at("paths", path, method, "x-roles"));
    expect([...conflicts.conflictStates]).toEqual(at("components", "schemas", "BuyerInviteConflictState", "enum"));
    expect([...conflicts.resolveStates]).toEqual(at("components", "schemas", "BuyerInviteConflictResolve", "properties", "state", "enum"));
    expect(at("components", "schemas", "BuyerInviteConflictResolve", "required")).toEqual(["state", "totp_code"]); expect(at("components", "schemas", "BuyerInviteConflictResolve", "additionalProperties")).toBe(false);
  });
  it("keeps issued license roles and statuses aligned with v0.3", () => {
    for (const path of ["/licenses", "/licenses/{license_id}"]) expect([...issued.licenseReaders]).toEqual(at("paths", path, "get", "x-roles"));
    expect([...issued.licenseDownloaders]).toEqual(at("paths", "/licenses/{license_id}/download-url", "post", "x-roles"));
    expect([...issued.licenseStatuses]).toEqual(at("components", "schemas", "LicenseStatus", "enum"));
  });
  it("keeps order roles, statuses and limits aligned with v0.3", () => {
    for (const path of ["/orders", "/orders/{order_id}"]) expect([...orders.orderReaders]).toEqual(at("paths", path, "get", "x-roles"));
    for (const path of ["/orders", "/orders/{order_id}/checkout", "/orders/{order_id}/cancel"]) expect([...orders.orderWriters]).toEqual(at("paths", path, "post", "x-roles"));
    expect([...orders.orderStatuses]).toEqual(at("components", "schemas", "OrderStatus", "enum")); expect(orders.orderLimits.items).toBe(at("components", "schemas", "OrderCreate", "properties", "items", "maxItems"));
  });
  it("keeps transition choices aligned with the three contract state enums", () => {
    for (const [key, schema] of [["technical_state", "TechnicalState"], ["editorial_state", "EditorialState"], ["rights_state", "RightsState"]] as const) expect(states[key]).toEqual(at("components", "schemas", schema, "enum"));
  });
});
