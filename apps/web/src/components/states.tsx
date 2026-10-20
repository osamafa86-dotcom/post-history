import { messages, type Locale } from "@/lib/i18n";
import type { Material } from "@/lib/types";
export type StateTrack = "technical_state" | "editorial_state" | "rights_state";
export function StateBadge({ track, value, locale }: { track: StateTrack; value: Material[StateTrack]; locale: Locale }) {
  const labels = messages[locale].states[track] as Record<string, string>;
  const tone = ["failed", "rejected", "blocked", "withdrawn"].includes(value) ? "bad" : ["verified", "accepted", "documented", "published", "sellable"].includes(value) ? "good" : "neutral";
  return <span className={`badge ${tone}`} data-track={track}>{labels[value] ?? messages[locale].notAvailable}</span>;
}
export function photographer(material: Material, locale: Locale) {
  const m = messages[locale];
  return material.display_name.mode === "network" ? m.networkName : material.display_name.mode === "pseudonym" ? material.display_name.pseudonym || m.nameUnavailable : m.nameUnavailable;
}
