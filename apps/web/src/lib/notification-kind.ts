import type { Notification } from "./types";
import type { IconName } from "@/components/icon";

/**
 * أنواع أحداث Outbox كما في `contracts/schemas/outbox-event.json` (قائمة مغلقة، يطابقها اختبار). نوع الإشعار فئة لا نص: لا عنوان مادة ولا
 * اسم ولا مكان، فيمرّ من الـBFF إن كان من هذه القائمة وحدها، وإلا يُرسل فارغًا (ADR 0103). العنوان الحرّ يبقى محذوفًا كما كان (ADR 0090).
 */
export const notificationTypes = [
  "material.created", "material.urgent_received", "material.updated", "material.version_created", "material.technical_transition", "material.editorial_transition",
  "material.rights_transition", "material.acknowledged", "material.change_requested", "material.accepted_for_production", "material.reserved", "material.released",
  "material.contributors_set", "material.published", "material.rejected", "material.accepted", "material.resubmitted", "upload.started", "upload.progress", "upload.proxy_received", "upload.original_received", "upload.verified",
  "upload.deduplicated", "upload.failed", "form.published", "ai.draft_ready", "notification.escalated", "auth.recovery_requested", "auth.recovery_approved",
  "user.status_changed", "auth.recovery_completed", "export.requested", "setting.changed", "catalog.listing_changed", "license.delivery_requested",
  "order.status_changed", "license.issued", "license.revoked", "payout.status_changed", "render.requested", "render.started", "render.completed", "render.failed",
  "assignment.created", "assignment.state_changed", "tag.suggestions_changed", "tag.rewritten", "platform_settings.changed",
  "user.roles_changed", "buyer_organization.status_changed", "auth.passkey_added", "auth.passkey_revoked", "auth.recovery_codes_generated",
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

export type KindWord = "seen" | "changes" | "rejected" | "accepted" | "published" | "received" | "incoming" | "resubmitted" | "production" | "escalated" | "task" | "store" | "money" | "upload" | "account" | "update";
/** كلمة لكل نوع حدث له معنى واحد عند قارئه (ADR 0121): ما يصل صاحب المادة، وما يصل الطاقم عن مادة واردة أو معادة أو مقبولة للإنتاج أو مصعَّدة. */
const byType: Record<string, { word: KindWord; icon: IconName }> = {
  "material.acknowledged": { word: "seen", icon: "preview" }, "material.change_requested": { word: "changes", icon: "pencil" }, "material.rejected": { word: "rejected", icon: "ban" },
  "material.accepted": { word: "accepted", icon: "check" }, "material.published": { word: "published", icon: "globe" }, "upload.verified": { word: "received", icon: "upload" },
  "material.created": { word: "incoming", icon: "inbox" }, "material.urgent_received": { word: "incoming", icon: "inbox" }, "material.resubmitted": { word: "resubmitted", icon: "refresh" },
  "material.accepted_for_production": { word: "production", icon: "film" }, "notification.escalated": { word: "escalated", icon: "alert" },
};
/** ما يصل صاحب المادة خبرًا عن مادته: لا يُطلب منه إقرار ولو كانت عاجلة. */
export const ownerNews = ["material.acknowledged", "material.change_requested", "material.rejected", "material.accepted", "material.published", "upload.verified"] as const;
/** هل يُعرض «إقرار الاطّلاع»: لا لخبر صاحب المادة، ولا لما أُقرّ. */
export const asksAck = (n: Pick<Notification, "type" | "state" | "acknowledged_at">) => !(ownerNews as readonly string[]).includes(n.type) && !n.acknowledged_at && n.state !== "acknowledged";
/**
 * كلمة البند وأيقونته (لا لون وحده): طلب استعادة الحساب (ADR 0108)، ثم مهمة المونتير، ثم كلمة النوع، ثم المهمة من قاعدة، ثم المتجر والمال والرفع بنوع
 * الحدث، وإلا «تحديث على مادة». العاجل علَم بجانب الكلمة لا بديل عنها: «طُلب تعديل على مادتك» تبقى كذلك في مادة عاجلة.
 */
export function notificationKind(n: Notification): { word: KindWord; icon: IconName; urgent: boolean } {
  const urgent = n.priority === "urgent", kind = (word: KindWord, icon: IconName) => ({ word, icon, urgent });
  if (n.recovery_request_id || n.type.startsWith("auth.recovery_")) return kind("account", "key");
  if (n.assignment_id || n.type.startsWith("assignment.")) return kind("task", "tasks");
  if (byType[n.type]) return { ...byType[n.type], urgent };
  if (n.assignment_state) return kind("task", "tasks");
  if (isStore(n)) return kind("store", "store");
  if (n.type.startsWith("payout.")) return kind("money", "money");
  if (n.type.startsWith("upload.")) return kind("upload", "upload");
  return kind("update", "inbox");
}
