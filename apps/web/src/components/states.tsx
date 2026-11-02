import { messages, type Locale } from "@/lib/i18n";
import type { Material } from "@/lib/types";
import { Icon, type IconName } from "./icon";
export type StateTrack = "technical_state" | "editorial_state" | "rights_state";
export type StateTone = "ok" | "warn" | "muted" | "brand" | "danger";

/**
 * نغمة كل حالة من `color.material-state.*` في الرموز v2: فنية (جاهزة ok، تُعالَج muted، فشلت danger)، تحريرية (قيد المراجعة warn، معتمدة ok،
 * مرفوضة danger)، حقوق (داخلي muted، للعرض brand، مقيّد warn). ومعها أيقونة، فلا تُقال الحالة باللون وحده (design-system-v2.md المبدأ 5).
 */
export function stateTone(track: StateTrack, value: string): { tone: StateTone; icon: IconName } {
  if (track === "technical_state") return value === "verified" ? { tone: "ok", icon: "check" } : value === "failed" ? { tone: "danger", icon: "alert" } : { tone: "muted", icon: "clock" };
  if (track === "editorial_state") return ["accepted", "in_production", "final_review", "published"].includes(value) ? { tone: "ok", icon: "check" } : value === "rejected" ? { tone: "danger", icon: "x" } : { tone: "warn", icon: "pencil" };
  return value === "sellable" ? { tone: "brand", icon: "store" } : ["blocked", "withdrawn"].includes(value) ? { tone: "warn", icon: "ban" } : { tone: "muted", icon: "clock" };
}

/** شارة الحالة (`State badge`): أيقونة وكلمة بنغمة الحالة؛ الحالات الثلاث شارات منفصلة دائمًا. */
export function StateBadge({ track, value, locale }: { track: StateTrack; value: Material[StateTrack]; locale: Locale }) {
  const labels = messages[locale].states[track] as Record<string, string>, { tone, icon } = stateTone(track, value);
  return <span className={`badge state ${tone}`} data-track={track} data-state={value}><Icon name={icon} size={14} />{labels[value] ?? messages[locale].notAvailable}</span>;
}
export function photographer(material: Material, locale: Locale) {
  const m = messages[locale];
  return material.display_name.mode === "network" ? m.networkName : material.display_name.mode === "pseudonym" ? material.display_name.pseudonym || m.nameUnavailable : m.nameUnavailable;
}
