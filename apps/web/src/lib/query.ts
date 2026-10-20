import type { Material, MaterialQuery, MaterialType } from "./types";

export const states = {
  technical_state: ["pending", "proxy_received", "original_received", "verified", "failed"],
  editorial_state: ["inbox", "acknowledged", "reviewing", "needs_changes", "accepted", "in_production", "final_review", "published", "rejected"],
  rights_state: ["unknown", "documented", "sellable", "blocked", "withdrawn"],
  priority: ["urgent", "important", "normal"],
} as const satisfies { [K in "technical_state" | "editorial_state" | "rights_state" | "priority"]: readonly Material[K][] };
export const materialTypes = ["breaking", "report", "interview", "raw_footage", "aerial", "press_conference", "eyewitness", "photos"] as const satisfies readonly MaterialType[];
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
export function materialQuery(params: URLSearchParams): MaterialQuery {
  const result: Record<string, string | number> = {};
  const allowed = new Set(["governorate", "reporter_id", "shot_after", "shot_before", "cursor", "limit", ...Object.keys(states)]);
  for (const [key, value] of params) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw new Error("Invalid query");
    if (!value) continue;
    if (key in states && !(states[key as keyof typeof states] as readonly string[]).includes(value)) throw new Error("Invalid state");
    if (key === "reporter_id" && !uuid.test(value)) throw new Error("Invalid reporter");
    if ((key === "shot_after" || key === "shot_before") && (!dateTime.test(value) || !Number.isFinite(Date.parse(value)))) throw new Error("Invalid date");
    if ((key === "governorate" && value.length > 64) || value.length > 2048) throw new Error("Query too long");
    if (key === "limit") {
      if (!/^\d+$/.test(value) || +value < 1 || +value > 100) throw new Error("Invalid limit");
      result[key] = +value;
    } else result[key] = value;
  }
  return result as MaterialQuery;
}
