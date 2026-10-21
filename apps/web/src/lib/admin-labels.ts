import { messages, type Locale } from "./i18n";
import type { Permission } from "./types";

export function permissionLabel(permission: Permission, locale: Locale) {
  const t = messages[locale].admin;
  const labels: Record<Permission, string> = { "sensitive_location:read": t.location, "protected_source:read": t.source, "reporter_identity:read": t.identity };
  return labels[permission];
}
