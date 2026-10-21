import type { components } from "@/generated/schema";
import { materialTypes, states } from "./query";
import { permissions } from "./admin-policy";

// قيم قواعد التنبيه (#203 بند 7)؛ يطابقها contract-drift مع OpenAPI، وليست نماذج بديلة.
export type RuleInput = components["schemas"]["NotificationRuleInput"];
export type Rule = components["schemas"]["NotificationRule"];
type Step = components["schemas"]["NotificationEscalationStep"];
export const ruleEvents: RuleInput["event_type"][] = ["material.created", "material.urgent_received", "material.updated", "material.version_created", "material.technical_transition", "material.editorial_transition", "material.rights_transition", "material.acknowledged", "material.change_requested", "material.accepted_for_production", "material.reserved", "material.released", "material.contributors_set", "material.published", "upload.started", "upload.proxy_received", "upload.original_received", "upload.verified", "upload.deduplicated", "upload.failed", "ai.draft_ready"];
export const channels: RuleInput["channels"] = ["in_app", "websocket", "apns", "fcm", "web_push", "email", "telegram", "whatsapp", "sms"];
// أدوار الطاقم وحدها مستلمون؛ أدوار المشترين في عقد v0.3 لا تُعرض ولا تُقبل هنا.
export const roles = ["system_admin", "editor_in_chief", "supervisor", "producer", "finance", "reporter", "rights_officer"] as const satisfies readonly components["schemas"]["RoleName"][];
export type StaffRole = typeof roles[number];
/** تسمية الدور من الموارد، وتسمية عامة لدور لا تعرفه الواجهة (مثل أدوار عقد أحدث). */
export const roleLabel = (names: Partial<Record<string, string>>, role: string, fallback: string) => names[role] ?? fallback;
export const scopeKinds: NonNullable<RuleInput["scope_kind"]>[] = ["all", "office", "governorate"];
export const ruleLimits = { name: 120, scope: 200, delay: 86400, digestMin: 15, digestMax: 1440, steps: 5, stepMin: 60, stepMax: 86400 } as const;

const keys = ["name", "event_type", "priorities", "material_types", "scope_kind", "scope_id", "recipient_roles", "recipient_permissions", "channels", "delay_seconds", "quiet_hours", "digest_interval_minutes", "assignment", "escalation", "enabled"];
const hhmm = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const subset = <T>(value: unknown, allowed: readonly T[], min = 0): value is T[] => Array.isArray(value) && value.length >= min && new Set(value).size === value.length && value.every(v => (allowed as readonly unknown[]).includes(v));
const int = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/** قاعدة كاملة صالحة بقواعد العقد، أو null. الخادم هو الحكم النهائي؛ هذا يمنع إرسال ما يُرفض حتمًا. */
export function ruleInput(body: Record<string, unknown>): RuleInput | null {
  if (Object.keys(body).some(key => !keys.includes(key))) return null;
  const b = body;
  if (typeof b.name !== "string" || !b.name.trim() || Array.from(b.name).length > ruleLimits.name || !ruleEvents.includes(b.event_type as RuleInput["event_type"])) return null;
  if (b.priorities !== null && !subset(b.priorities, states.priority, 1)) return null;
  if (b.material_types !== null && !subset(b.material_types, materialTypes, 1)) return null;
  if (!scopeKinds.includes(b.scope_kind as RuleInput["scope_kind"] & string) || typeof b.scope_id !== "string" || b.scope_id.length > ruleLimits.scope || (b.scope_kind === "all") !== (b.scope_id === "")) return null;
  if (!subset(b.recipient_roles, roles) || !subset(b.recipient_permissions, permissions) || (b.recipient_roles as unknown[]).length + (b.recipient_permissions as unknown[]).length === 0) return null;
  if (!subset(b.channels, channels, 1) || !int(b.delay_seconds, 0, ruleLimits.delay) || typeof b.assignment !== "boolean" || typeof b.enabled !== "boolean") return null;
  const quiet = b.quiet_hours as Record<string, unknown> | null;
  if (quiet !== null && (!quiet || typeof quiet !== "object" || Object.keys(quiet).sort().join() !== "end,start,timezone" || !hhmm.test(String(quiet.start)) || !hhmm.test(String(quiet.end)) || typeof quiet.timezone !== "string" || !quiet.timezone || quiet.timezone.length > 64)) return null;
  if (b.digest_interval_minutes !== null && !int(b.digest_interval_minutes, ruleLimits.digestMin, ruleLimits.digestMax)) return null;
  const steps = b.escalation;
  if (!Array.isArray(steps) || steps.length > ruleLimits.steps || (steps.length && !b.assignment)) return null;
  let last = 0;
  for (const [index, step] of steps.entries()) {
    const s = step as Record<string, unknown>;
    if (!s || typeof s !== "object" || Object.keys(s).sort().join() !== "after_seconds,channels,level,recipient_roles" || s.level !== index + 1 || !int(s.after_seconds, Math.max(ruleLimits.stepMin, last + 1), ruleLimits.stepMax) || !subset(s.recipient_roles, roles, 1) || !subset(s.channels, channels, 1)) return null;
    last = s.after_seconds as number;
  }
  return {
    name: b.name, event_type: b.event_type as RuleInput["event_type"], priorities: b.priorities as RuleInput["priorities"], material_types: b.material_types as RuleInput["material_types"],
    scope_kind: b.scope_kind as RuleInput["scope_kind"], scope_id: b.scope_id, recipient_roles: b.recipient_roles as RuleInput["recipient_roles"], recipient_permissions: b.recipient_permissions as RuleInput["recipient_permissions"],
    channels: b.channels as RuleInput["channels"], delay_seconds: b.delay_seconds as number, quiet_hours: quiet ? { start: String(quiet.start), end: String(quiet.end), timezone: String(quiet.timezone) } : null,
    digest_interval_minutes: b.digest_interval_minutes as number | null, assignment: b.assignment as boolean,
    escalation: (steps as Step[]).map(({ level, after_seconds, recipient_roles, channels }) => ({ level, after_seconds, recipient_roles, channels })), enabled: b.enabled as boolean,
  };
}
/** حقول الإدخال من قاعدة محفوظة، بمفاتيح العقد وحدها؛ الغائب يأخذ افتراضي العقد. */
export const inputOf = (rule: Rule): RuleInput => Object.fromEntries(keys.map(key => [key, (rule as Record<string, unknown>)[key] ?? (defaults as Record<string, unknown>)[key]])) as RuleInput;
/** القاعدة للمتصفح بقائمة بيضاء. */
export function safeRule(rule: Rule): Rule {
  return { ...inputOf(rule), id: rule.id, row_version: rule.row_version, created_at: rule.created_at, updated_at: rule.updated_at, created_by: rule.created_by ?? null, updated_by: rule.updated_by ?? null };
}
const defaults = { priorities: null, material_types: null, scope_kind: "all", scope_id: "", recipient_roles: [], recipient_permissions: [], delay_seconds: 0, quiet_hours: null, digest_interval_minutes: null, assignment: false, escalation: [], enabled: true };
export const emptyRule = (): RuleInput => ({ name: "", event_type: "material.urgent_received", channels: ["in_app"], ...defaults, recipient_roles: ["supervisor"] } as RuleInput);
