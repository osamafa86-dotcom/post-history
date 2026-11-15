import type { Permission, ReporterIdentityAccess, ReporterIdentitySettingUpdate } from "./types";

// القيم التشغيلية يطابقها اختبار contract-drift مع OpenAPI، وليست نماذج بيانات بديلة.
export const permissions: Permission[] = ["sensitive_location:read", "protected_source:read", "reporter_identity:read"];
export const identityAccesses: ReporterIdentityAccess[] = ["separate", "protected_source"];
export const identityReasons: ReporterIdentitySettingUpdate["reason_code"][] = ["policy_change", "operational_need", "incident_response", "audit_finding"];
export const reasonLimits = { transition: 2000, permission: 500 } as const;
export const pageLimits = { min: 1, max: 100, default: 50 } as const;

/**
 * ما يحمله الحساب الآن من الصلاحيات المستقلة، من سجلها (العقد لا يعيدها في قائمة الحسابات): آخر حدث منح أو سحب لكل صلاحية. `complete`: السجل
 * قُرئ حتى آخره؛ صلاحية بلا حدث فيه غير ممنوحة، وفي سجل لم يكتمل مجهولة (`null`) فيُعرض لها الزرّان.
 */
export function heldPermissions(items: readonly { id: string; kind: string; permission?: Permission | string | null }[], complete: boolean): Record<Permission, boolean | null> {
  const latest = new Map<string, { id: bigint; granted: boolean }>();
  for (const item of items) {
    if ((item.kind !== "permission_granted" && item.kind !== "permission_revoked") || !item.permission || !/^[0-9]{1,19}$/.test(item.id)) continue;
    const id = BigInt(item.id), seen = latest.get(item.permission);
    if (!seen || id > seen.id) latest.set(item.permission, { id, granted: item.kind === "permission_granted" });
  }
  return Object.fromEntries(permissions.map(permission => [permission, latest.get(permission)?.granted ?? (complete ? false : null)])) as Record<Permission, boolean | null>;
}
