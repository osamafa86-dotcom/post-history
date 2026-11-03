import type { Notification } from "./types";
import type { IconName } from "@/components/icon";

/**
 * أنواع أحداث Outbox كما في `contracts/schemas/outbox-event.json` (قائمة مغلقة، يطابقها اختبار). نوع الإشعار فئة لا نص: لا عنوان مادة ولا
 * اسم ولا مكان، فيمرّ من الـBFF إن كان من هذه القائمة وحدها، وإلا يُرسل فارغًا (ADR 0103). العنوان الحرّ يبقى محذوفًا كما كان (ADR 0090).
 */
export const notificationTypes = [
  "material.created", "material.urgent_received", "material.updated", "material.version_created", "material.technical_transition", "material.editorial_transition",
  "material.rights_transition", "material.acknowledged", "material.change_requested", "material.accepted_for_production", "material.reserved", "material.released",
  "material.contributors_set", "material.published", "upload.started", "upload.progress", "upload.proxy_received", "upload.original_received", "upload.verified",
  "upload.deduplicated", "upload.failed", "form.published", "ai.draft_ready", "notification.escalated", "auth.recovery_requested", "auth.recovery_approved",
  "user.status_changed", "auth.recovery_completed", "export.requested", "setting.changed", "catalog.listing_changed", "license.delivery_requested",
  "order.status_changed", "license.issued", "license.revoked", "payout.status_changed", "render.requested", "render.started", "render.completed", "render.failed",
  "assignment.created", "assignment.state_changed", "tag.suggestions_changed", "tag.rewritten", "platform_settings.changed",
  "user.roles_changed", "buyer_organization.status_changed",
] as const;
export const knownType = (value: unknown): string => typeof value === "string" && (notificationTypes as readonly string[]).includes(value) ? value : "";

/** المتجر في W10: الطلب والترخيص والإدراج (`order.*` و`license.*` و`catalog.*`). */
export const isStore = (n: Pick<Notification, "type">) => /^(order|license|catalog)\./.test(n.type);
export type PanelTab = "all" | "mine" | "store";
export const panelTabs: PanelTab[] = ["all", "mine", "store"];
/** تبويبات W10: «مهامي» لما أُسند إلى المستخدم (`assignment_state` أو `assignment_id`)، و«المتجر» بنوع الحدث. */
export function inTab(n: Notification, tab: PanelTab): boolean {
  return tab === "all" || (tab === "mine" ? !!n.assignment_state || !!n.assignment_id : isStore(n));
}
export const unread = (n: Notification) => !n.read_at && n.state !== "read" && n.state !== "acknowledged";
/** الترتيب (W10): العاجل أولًا ثم غير المقروء ثم الأحدث. الإشعار لا يحمل علم الحساسية في العقد، فلا يُدّعى ترتيب به. */
export function panelOrder(items: Notification[]): Notification[] {
  return [...items].sort((a, b) => Number(b.priority === "urgent") - Number(a.priority === "urgent") || Number(unread(b)) - Number(unread(a)) || Date.parse(b.created_at) - Date.parse(a.created_at));
}

export type KindWord = "urgent" | "task" | "store" | "money" | "upload" | "update";
/** كلمة البند وأيقونته (لا لون وحده): العاجل، ثم المهمة، ثم المتجر والمال والرفع بنوع الحدث، وإلا «تحديث على مادة». */
export function notificationKind(n: Notification): { word: KindWord; icon: IconName } {
  if (n.priority === "urgent") return { word: "urgent", icon: "bolt" };
  if (n.assignment_state || n.assignment_id || n.type.startsWith("assignment.")) return { word: "task", icon: "tasks" };
  if (isStore(n)) return { word: "store", icon: "store" };
  if (n.type.startsWith("payout.")) return { word: "money", icon: "money" };
  if (n.type.startsWith("upload.")) return { word: "upload", icon: "upload" };
  return { word: "update", icon: "inbox" };
}
