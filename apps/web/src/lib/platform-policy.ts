import type { components } from "@/generated/schema";
import { validText } from "./admin-text";

// هوية المنصة (A6، ADR 0099): أنواع العقد المولَّدة؛ يطابق contract-drift الحدود والأدوار مع OpenAPI.
export type PlatformSettings = components["schemas"]["PlatformSettings"];
export type PlatformSettingsUpdate = components["schemas"]["PlatformSettingsUpdate"];
type Role = components["schemas"]["RoleName"];
export const platformAdmins = ["system_admin"] as const satisfies readonly Role[];
export const platformFields = ["platform_name", "app_name", "watermark_text"] as const satisfies readonly (keyof PlatformSettingsUpdate)[];
export const platformLimits = { platform_name: 60, app_name: 40, watermark_text: 60 } as const satisfies Record<(typeof platformFields)[number], number>;

const dateTime = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

/** الحقول الثلاثة معًا، كلٌّ بقاعدة النص الحرّ وحدّه. */
export function platformInput(body: Record<string, unknown>): PlatformSettingsUpdate | null {
  if (Object.keys(body).sort().join() !== [...platformFields].sort().join()) return null;
  if (platformFields.some(field => !validText(body[field], platformLimits[field]))) return null;
  return { platform_name: body.platform_name as string, app_name: body.app_name as string, watermark_text: body.watermark_text as string };
}

export function safePlatformSettings(value: PlatformSettings): PlatformSettings {
  if (platformFields.some(field => typeof value[field] !== "string" || Array.from(value[field]).length > platformLimits[field]) || !Number.isSafeInteger(value.version) || value.version < 1 || !dateTime(value.updated_at)) throw new Error("Invalid platform settings");
  return { platform_name: value.platform_name, app_name: value.app_name, watermark_text: value.watermark_text, version: value.version, updated_at: value.updated_at };
}
