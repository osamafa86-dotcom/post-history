import { describe, expect, it } from "vitest";
import { materialTag, transitionOptions, validContributors } from "../src/lib/review";
import { safeNotification, safeTransition } from "../src/lib/privacy";
import type { Me, RoleName } from "../src/lib/types";
import { material, me } from "./fixtures";

function roleUser(...roles: RoleName[]): Me { return { ...me, roles: roles.map(name => ({ name, scopes: [] })) }; }
describe("review action visibility", () => {
  it("keeps state tracks independent and does not treat sensitive permissions as a role", () => {
    const item = { ...material(), editorial_state: "reviewing" as const };
    expect(transitionOptions(item, roleUser("supervisor"), "editorial")).toEqual(["needs_changes", "accepted", "rejected"]);
    expect(transitionOptions(item, roleUser("supervisor"), "rights")).toEqual([]);
    expect(transitionOptions(item, roleUser("rights_officer"), "rights")).toEqual(["documented"]);
    expect(transitionOptions(item, { ...me, permissions: ["sensitive_location:read", "protected_source:read"] }, "editorial")).toEqual([]);
    expect(transitionOptions(item, roleUser("system_admin"), "editorial")).toEqual([]);
  });
  it("requires the reporter's own failed material and producer's own reservation", () => {
    const item = { ...material(), technical_state: "failed" as const, editorial_state: "in_production" as const, reserved_by: me.user_id };
    expect(transitionOptions(item, roleUser("reporter"), "technical")).toEqual(["pending"]);
    expect(transitionOptions({ ...item, reporter_id: "other" }, roleUser("reporter"), "technical")).toEqual([]);
    expect(transitionOptions(item, roleUser("producer"), "editorial")).toEqual(["final_review", "accepted"]);
    expect(transitionOptions({ ...item, reserved_by: null }, roleUser("producer"), "editorial")).toEqual([]);
  });
  it("does not offer server-owned technical advances or foundation-excluded commercial transitions", () => {
    expect(transitionOptions(material(), roleUser("reporter", "system_admin"), "technical")).toEqual([]);
    expect(transitionOptions({ ...material(), rights_state: "documented" }, roleUser("rights_officer"), "rights")).toEqual(["sellable", "blocked"]);
  });
  it("uses the row revision, never the content version, for conditional writes", () => {
    expect(materialTag(new Response(), { ...material(), version: 5, row_version: 17 })).toBe('"17"');
    expect(materialTag(new Response(), material())).toBeNull();
    expect(materialTag(new Response(null, { headers: { ETag: '"19"' } }), material())).toBe('"19"');
    expect(materialTag(new Response(null, { headers: { ETag: 'W/"5"' } }), material())).toBeNull();
  });
});
it("validates contributor totals in integer hundredths, unique users and two decimal places", () => {
  const one = { user_id: me.user_id, role: "reporter", share_percent: 100 };
  expect(validContributors([one])).toBe(true);
  const two = { ...one, user_id: "10000000-0000-4000-8000-000000000002", share_percent: 66.67 };
  expect(validContributors([{ ...one, share_percent: 33.33 }, two])).toBe(true);
  for (const value of [[], [one, one], [{ ...one, share_percent: 99.99 }], [{ ...one, share_percent: NaN }], [{ ...one, share_percent: 100.001 }], [{ ...one, user_id: "bad" }], [{ ...one, role: "system_admin" }]]) expect(validContributors(value)).toBe(false);
});
it("drops free-text notification content, history reasons and unexpected sensitive fields", () => {
  const notice = safeNotification({ id: me.user_id, title: "canary", type: "canary", material_id: "canary", priority: "normal", state: "sent", created_at: "2026-10-20T00:00:00Z" });
  expect(JSON.stringify(notice)).not.toContain("canary"); expect(notice.material_id).toBeNull();
  const record = safeTransition({ id: me.user_id, track: "editorial", from: "canary", to: "acknowledged", reason: "canary", actor_id: "canary", occurred_at: "2026-10-20T00:00:00Z" });
  expect(JSON.stringify(record)).not.toContain("canary"); expect(record.to).toBe("acknowledged");
});
