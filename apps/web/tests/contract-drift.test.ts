import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { actionPath, actionRoutes } from "../src/server/review-actions";
import { identityAccesses, identityReasons, pageLimits, permissions, reasonLimits } from "../src/lib/admin-policy";
import { states } from "../src/lib/query";
import { uploadRoles } from "../src/lib/upload-policy";
import { channels, roles, ruleEvents, ruleLimits, scopeKinds } from "../src/lib/notification-policy";

const { load } = createRequire(import.meta.url)("js-yaml") as { load: (text: string) => unknown };
const contract = load(readFileSync(new URL("../../../contracts/openapi.yaml", import.meta.url), "utf8"));
function at(...path: string[]): unknown {
  return path.reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || !(key in value)) throw new Error(`Missing contract path: ${path.join(".")}`);
    return (value as Record<string, unknown>)[key];
  }, contract);
}
describe("BFF policy remains aligned with the checked-in OpenAPI contract", () => {
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
    expect(roles).toEqual(at("components", "schemas", "RoleName", "enum")); expect(scopeKinds).toEqual(input("scope_kind", "enum"));
    expect([ruleLimits.name, ruleLimits.scope, ruleLimits.delay, ruleLimits.digestMin, ruleLimits.digestMax, ruleLimits.steps, ruleLimits.stepMin, ruleLimits.stepMax]).toEqual([input("name", "maxLength"), input("scope_id", "maxLength"), input("delay_seconds", "maximum"), input("digest_interval_minutes", "minimum"), input("digest_interval_minutes", "maximum"), input("escalation", "maxItems"), step("after_seconds", "minimum"), step("after_seconds", "maximum")]);
  });
  it("opens desktop upload to exactly the roles the contract allows", () => {
    for (const [path, method] of [["/materials", "post"], ["/uploads", "post"], ["/uploads/{id}/web-ingest-token", "post"]]) expect([...uploadRoles]).toEqual(at("paths", path, method, "x-roles"));
  });
  it("keeps transition choices aligned with the three contract state enums", () => {
    for (const [key, schema] of [["technical_state", "TechnicalState"], ["editorial_state", "EditorialState"], ["rights_state", "RightsState"]] as const) expect(states[key]).toEqual(at("components", "schemas", schema, "enum"));
  });
});
