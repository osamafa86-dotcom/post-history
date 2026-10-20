import { readFileSync } from "node:fs";
import type { Form, Material, Me, Session } from "../src/lib/types";
export const me: Me = { user_id: "10000000-0000-4000-8000-000000000001", email: "fixture@example.test", roles: [], permissions: [], totp_enabled: true };
export const tokens = (): Session => ({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", user_id: me.user_id, roles: [], expires_at: new Date(Date.now() + 600000).toISOString() });
export const form = JSON.parse(readFileSync(new URL("../../../tools/acceptance/form-conformance/forms/main.json", import.meta.url), "utf8")) as Form;
export function material(index = 1): Material {
  return {
    id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`, version: 1, reporter_id: me.user_id, office_id: null,
    title: `مادة اختبار اصطناعية ${String(index).padStart(3, "0")}`, material_types: ["report"], governorate: index % 2 ? "غزة" : "القدس", city: "مدينة اختبار",
    shot_at: new Date(Date.UTC(2026, 9, 19, 12, 0, index)).toISOString(), priority: index % 5 === 0 ? "urgent" : "normal",
    sensitivity: { minors: false, injured: false, graphic: false }, display_name: { mode: "network" }, form_version: form.version,
    dynamic_fields: {}, technical_state: "verified", editorial_state: "inbox", rights_state: "unknown",
    files: [
      { id: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`, kind: "proxy", state: "verified", mime_type: "video/mp4", receipt_number: `RCPT-20261020-${String(index).padStart(6, "0")}`, created_at: "2026-10-19T12:00:00Z" },
      { id: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`, kind: "thumbnail", state: "verified", mime_type: "image/png", created_at: "2026-10-19T12:00:00Z" },
      { id: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`, kind: "original", state: "verified", mime_type: "video/mp4", created_at: "2026-10-19T12:00:00Z" },
    ],
    created_at: "2026-10-19T12:00:00Z", updated_at: "2026-10-19T12:00:00Z", redacted_field_keys: [],
  };
}
