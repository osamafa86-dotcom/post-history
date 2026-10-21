import type { Contributor, Material, Me, RoleName, Transition } from "./types";
import { uuid } from "./query";

export const tracks = ["technical", "editorial", "rights"] as const;
export const hasRole = (me: Me, ...roles: RoleName[]) => me.roles.some(role => roles.includes(role.name));
export const stateColumn = { technical: "technical_state", editorial: "editorial_state", rights: "rights_state" } as const;

// مساعد عرض فقط؛ الخادم يقرر النطاق وصلاحية الحجز عند كل كتابة.
export function transitionOptions(material: Material, me: Me, track: Transition["track"]): string[] {
  if (track === "technical") return material.technical_state === "failed" && hasRole(me, "reporter") && material.reporter_id === me.user_id ? ["pending"] : [];
  if (track === "rights") {
    if (material.rights_state === "sellable" && hasRole(me, "rights_officer", "editor_in_chief")) return ["blocked", "withdrawn"];
    if (!hasRole(me, "rights_officer")) return [];
    // الحالة التجارية sellable مؤجلة وفق نطاق التأسيس.
    return ({ unknown: ["documented"], documented: ["blocked"], blocked: ["documented"] } as Record<string, string[]>)[material.rights_state] ?? [];
  }
  if (hasRole(me, "supervisor")) {
    const options = ({ inbox: ["acknowledged", "rejected"], acknowledged: ["reviewing", "rejected"], reviewing: ["needs_changes", "accepted", "rejected"] } as Record<string, string[]>)[material.editorial_state];
    if (options) return options;
  }
  if (material.editorial_state === "needs_changes" && hasRole(me, "reporter") && material.reporter_id === me.user_id) return ["reviewing"];
  if (material.editorial_state === "in_production" && hasRole(me, "producer") && material.reserved_by === me.user_id) return ["final_review", "accepted"];
  if (hasRole(me, "editor_in_chief")) return material.editorial_state === "final_review" ? ["published", "in_production"] : material.editorial_state === "published" ? ["final_review"] : [];
  return [];
}
export const contributorRoles = ["photographer", "reporter", "editor", "fixer"] as const satisfies readonly Contributor["role"][];
export function validContributors(value: unknown): value is Contributor[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  let sum = 0; const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.user_id !== "string" || !uuid.test(item.user_id) || !contributorRoles.includes(item.role) || typeof item.share_percent !== "number" || !Number.isFinite(item.share_percent)) return false;
    const cents = Math.round(item.share_percent * 100);
    if (cents < 0 || cents > 10000 || Math.abs(cents - item.share_percent * 100) > 1e-8 || seen.has(item.user_id)) return false;
    seen.add(item.user_id); sum += cents;
  }
  return sum === 10000;
}
export function materialTag(response: Response, material: Material): string | null {
  const tag = response.headers.get("ETag");
  if (tag && /^"[0-9]{1,19}"$/.test(tag)) return tag;
  return Number.isSafeInteger(material.row_version) && material.row_version! >= 0 ? `"${material.row_version}"` : null;
}
