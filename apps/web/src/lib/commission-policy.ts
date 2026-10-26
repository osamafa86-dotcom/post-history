import type { components } from "@/generated/schema";
import { materialTypes, uuid } from "./query";
import { licenseTypes } from "./license-policy";

// قواعد العمولة (v0.3، ADR 0025 الجزء 6)؛ يطابقها contract-drift مع OpenAPI، وليست نماذج بديلة.
export type CommissionRule = components["schemas"]["CommissionRule"];
export type CommissionRuleInput = components["schemas"]["CommissionRuleInput"];
type Scope = components["schemas"]["CommissionScope"];
type Role = components["schemas"]["RoleName"];
export const commissionReaders = ["system_admin", "finance"] as const satisfies readonly Role[];
export const commissionWriters = ["system_admin"] as const satisfies readonly Role[];
export const commissionScopes = ["material", "reporter", "material_type", "default"] as const satisfies readonly Scope[];
export const basisPointsMax = 10000;

const keys = ["scope", "scope_id", "license_type", "platform_basis_points", "effective_from"];
const dateTime = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

/** معرّف النطاق بقاعدة العقد: لا شيء للافتراضية، وuuid للمادة والمراسل، وقيمة MaterialType لنوع المادة. */
export function validScopeId(scope: Scope, id: unknown) {
  if (scope === "default") return id === null;
  if (scope === "material_type") return (materialTypes as readonly unknown[]).includes(id);
  return typeof id === "string" && uuid.test(id);
}

/** إصدار قاعدة صالح بقواعد العقد، أو null. التعارض مع قاعدة قائمة يحكم فيه الخادم (409). */
export function commissionInput(body: Record<string, unknown>): CommissionRuleInput | null {
  const b = body;
  if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).sort().join() !== [...keys].sort().join()) return null;
  if (!(commissionScopes as readonly unknown[]).includes(b.scope) || !validScopeId(b.scope as Scope, b.scope_id)) return null;
  if (b.license_type !== null && !(licenseTypes as readonly unknown[]).includes(b.license_type)) return null;
  if (!Number.isSafeInteger(b.platform_basis_points) || (b.platform_basis_points as number) < 0 || (b.platform_basis_points as number) > basisPointsMax || !dateTime(b.effective_from)) return null;
  return { scope: b.scope as Scope, scope_id: b.scope_id as string | null, license_type: b.license_type as CommissionRuleInput["license_type"], platform_basis_points: b.platform_basis_points as number, effective_from: b.effective_from };
}

/** القاعدة للمتصفح بقائمة بيضاء. */
export function safeCommissionRule(r: CommissionRule): CommissionRule {
  return { id: r.id, scope: r.scope, scope_id: r.scope_id ?? null, license_type: r.license_type ?? null, platform_basis_points: r.platform_basis_points, effective_from: r.effective_from, created_by: r.created_by, created_at: r.created_at };
}

const ruleKey = (r: CommissionRule) => [r.scope, r.scope_id ?? "", r.license_type ?? ""].join("|");
/** معرّفات القواعد السارية عند اللحظة المعطاة: لكل نطاق ونوع أحدث effective_from لا يتجاوزها. */
export function currentRules(rules: CommissionRule[], at: number) {
  const best = new Map<string, CommissionRule>();
  for (const rule of rules) {
    const from = Date.parse(rule.effective_from), key = ruleKey(rule), held = best.get(key);
    if (from <= at && (!held || from > Date.parse(held.effective_from))) best.set(key, rule);
  }
  return new Set([...best.values()].map(rule => rule.id));
}
export const emptyRule = (): CommissionRuleInput => ({ scope: "default", scope_id: null, license_type: null, platform_basis_points: 3000, effective_from: "" });
