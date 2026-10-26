import type { Material, Notification, TransitionRecord } from "./types";
import { tracks } from "./review";

// مساعدات عرض لتدفق المحرر (#385، docs/design/specs/editor.md)؛ لا تقرر صلاحية ولا حالة، الخادم هو الحكم.
export type Track = (typeof tracks)[number];

/** العاجل الوارد الذي لم يُطَّلع عليه بعد في الصفحة الحالية، الأقدم أولًا. */
export const urgentUnacknowledged = (items: Material[]) => items.filter(m => m.priority === "urgent" && m.editorial_state === "inbox").sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

/** mm:ss منذ لحظة معينة، للعدّاد الحي (الساعات تُضاف حين تتجاوز ستين دقيقة). */
export function clock(from: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(from)) / 1000)), h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** موضع في المشغّل بالمللي ثانية بصيغة mm:ss. */
export const timecode = (ms: number) => clock(new Date(0).toISOString(), ms);

/** آخر حدث لكل مسار من سجل الانتقالات، لبطاقات الحالة الثلاث. */
export function lastEvents(records: TransitionRecord[]) {
  const last: Partial<Record<Track, TransitionRecord>> = {};
  for (const record of records) {
    if (!(tracks as readonly string[]).includes(record.track)) continue;
    const held = last[record.track as Track];
    if (!held || Date.parse(record.occurred_at) > Date.parse(held.occurred_at)) last[record.track as Track] = record;
  }
  return last;
}

/** الخط الزمني تنازليًا، مصفّى بمسار واحد إن طُلب؛ المسارات لا تُدمج. */
export const timeline = (records: TransitionRecord[], track: Track | null) => records.filter(r => !track || r.track === track).sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));

export type NotificationGroup = { key: string; items: Notification[]; head: Notification; needsAck: boolean; unread: boolean };
export type Section = "needsAck" | "today" | "yesterday" | "older";
const needsAck = (n: Notification) => n.priority === "urgent" && !n.acknowledged_at && n.state !== "acknowledged";
const unread = (n: Notification) => !n.read_at && (n.state === "sent" || n.state === "delivered");

/** إشعارات المادة نفسها خلال 24 ساعة صف واحد بعدّاد، والأقسام: يحتاج إقرارًا ثم اليوم وأمس وأقدم. */
export function groupNotifications(items: Notification[], now: number) {
  const sorted = [...items].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)), groups: NotificationGroup[] = [];
  for (const item of sorted) {
    const into = item.material_id ? groups.find(g => g.head.material_id === item.material_id && Date.parse(g.head.created_at) - Date.parse(item.created_at) < 86400000) : undefined;
    if (into) { into.items.push(item); into.needsAck ||= needsAck(item); into.unread ||= unread(item); }
    else groups.push({ key: item.id, items: [item], head: item, needsAck: needsAck(item), unread: unread(item) });
  }
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const section = (g: NotificationGroup): Section => g.needsAck ? "needsAck" : Date.parse(g.head.created_at) >= start.getTime() ? "today" : Date.parse(g.head.created_at) >= start.getTime() - 86400000 ? "yesterday" : "older";
  const order: Section[] = ["needsAck", "today", "yesterday", "older"];
  return order.map(name => ({ name, groups: groups.filter(g => section(g) === name) })).filter(s => s.groups.length);
}
