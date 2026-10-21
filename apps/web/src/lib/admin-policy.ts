import type { Permission, ReporterIdentityAccess, ReporterIdentitySettingUpdate } from "./types";

// القيم التشغيلية يطابقها اختبار contract-drift مع OpenAPI، وليست نماذج بيانات بديلة.
export const permissions: Permission[] = ["sensitive_location:read", "protected_source:read", "reporter_identity:read"];
export const identityAccesses: ReporterIdentityAccess[] = ["separate", "protected_source"];
export const identityReasons: ReporterIdentitySettingUpdate["reason_code"][] = ["policy_change", "operational_need", "incident_response", "audit_finding"];
export const reasonLimits = { transition: 2000, permission: 500 } as const;
export const pageLimits = { min: 1, max: 100, default: 50 } as const;
