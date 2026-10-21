import type { PermissionHistoryEntry, ReporterIdentitySetting } from "./types";
import { identityAccesses, identityReasons, permissions } from "./admin-policy";
import { uuid } from "./query";

const date = (value: string) => /^\d{4}-\d\d-\d\dT[\d:.+-]+Z?$/.test(value) && value.length <= 40 && Number.isFinite(Date.parse(value));
export function safeIdentitySetting(item: ReporterIdentitySetting): ReporterIdentitySetting {
  if (!identityAccesses.includes(item.access) || !date(item.updated_at)) throw new Error("Invalid setting response");
  return { access: item.access, updated_at: item.updated_at, updated_by: item.updated_by && uuid.test(item.updated_by) ? item.updated_by : null };
}
export function safePermissionHistory(item: PermissionHistoryEntry): PermissionHistoryEntry | null {
  if (!/^[0-9]{1,19}$/.test(item.id) || !date(item.occurred_at)) return null;
  const common = { id: item.id, kind: item.kind, actor_id: item.actor_id && uuid.test(item.actor_id) ? item.actor_id : null, occurred_at: item.occurred_at,
    reason_code: identityReasons.find(code => code === item.reason_code) ?? null };
  if (item.kind === "setting_changed" && item.setting === "reporter_legal_name_access" && item.value && identityAccesses.includes(item.value)) {
    return { ...common, permission: null, setting: "reporter_legal_name_access", value: item.value };
  }
  if ((item.kind === "permission_granted" || item.kind === "permission_revoked") && item.permission && permissions.includes(item.permission)) {
    return { ...common, permission: item.permission, setting: null, value: null, reason_code: null };
  }
  return null;
}
