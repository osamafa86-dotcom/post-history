import { describe, expect, it } from "vitest";
import { heldPermissions } from "../src/lib/admin-policy";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const entry = (id: number, kind: string, permission: string | null) => ({ id: String(id), kind, permission, actor_id: null, occurred_at: `2026-11-15T09:00:${String(id).padStart(2, "0")}Z`, reason_code: null, setting: null, value: null }) as never;

describe("which independent permissions an account holds now", () => {
  it("follows the latest event of each permission, whatever the order of the page", () => {
    const items = [entry(5, "permission_revoked", "protected_source:read"), entry(4, "permission_granted", "reporter_identity:read"), entry(3, "permission_granted", "protected_source:read"), entry(2, "setting_changed", null), entry(1, "permission_granted", "sensitive_location:read")];
    expect(heldPermissions(items, true)).toEqual({ "sensitive_location:read": true, "protected_source:read": false, "reporter_identity:read": true });
    expect(heldPermissions([...items].reverse(), true)).toEqual({ "sensitive_location:read": true, "protected_source:read": false, "reporter_identity:read": true });
  });
  it("is not granted when the whole history has no event for it, and unknown when the history was not read to its end", () => {
    expect(heldPermissions([], true)).toEqual({ "sensitive_location:read": false, "protected_source:read": false, "reporter_identity:read": false });
    expect(heldPermissions([entry(1, "permission_granted", "sensitive_location:read")], false)).toEqual({ "sensitive_location:read": true, "protected_source:read": null, "reporter_identity:read": null });
  });
  it("has words for the state and names an account once in its row label", () => {
    for (const m of [ar, en]) { expect(m.admin.held).toBeTruthy(); expect(m.admin.notHeld).toBeTruthy(); expect(m.admin.permissionsHelp).not.toContain("القائمة لا تعيد"); }
    expect(ar.admin.manage).toBe("إدارة {name}"); expect(ar.tags.sourceReporters).toBe("غير مقترحة"); expect(ar.security.codesPrint).toBeTruthy();
  });
});
