import { describe, expect, it } from "vitest";
import { safeRecoveryRequest } from "../src/lib/recovery-policy";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const id = "70000000-0000-4000-8000-000000000001", user = "10000000-0000-4000-8000-0000000000b2", office = "30000000-0000-4000-8000-000000000001";
const detail = (patch: Record<string, unknown> = {}, account: Record<string, unknown> = {}) => ({ id, state: "pending_approval", created_at: "2026-11-15T09:00:00Z", approved_by: null, expires_at: "2026-11-16T09:00:00Z",
  account: { user_id: user, work_name: "مراسل الجنوب", roles: ["reporter"], office_id: office, office_name: { ar: "مكتب غزة", en: "Gaza office" }, ...account }, ...patch }) as never;

describe("the recovery request as its approver reads it", () => {
  it("keeps the account's internal identity and the request's state, and nothing else", () => {
    expect(safeRecoveryRequest({ ...(detail() as object), email: "never@example.test", legal_name: "never", reset_token: "never", account: { ...((detail() as { account: object }).account), email: "never@example.test", legal_name: "never", phone: "never" } } as never)).toEqual({
      id, state: "pending_approval", created_at: "2026-11-15T09:00:00Z", expires_at: "2026-11-16T09:00:00Z", approved_by: null,
      account: { user_id: user, work_name: "مراسل الجنوب", roles: ["reporter"], office_id: office, office_name: { ar: "مكتب غزة", en: "Gaza office" } },
    });
  });
  it("drops what it cannot trust instead of showing it", () => {
    const safe = safeRecoveryRequest(detail({ approved_by: "not-an-id", expires_at: "soon" }, { work_name: " padded ", roles: ["reporter", "never-display-canary", "reporter"], office_id: "x", office_name: { ar: 7, en: "o" } }));
    expect(safe).toMatchObject({ approved_by: null, expires_at: null, account: { work_name: null, roles: ["reporter"], office_id: null, office_name: null } });
    for (const bad of [undefined, detail({ id: "x" }), detail({ state: "open" }), detail({ created_at: "then" }), detail({}, { user_id: "x" }), { ...(detail() as object), account: null }]) expect(() => safeRecoveryRequest(bad as never)).toThrow();
  });
  it("has words for the account, each state and the confirmation that names the account", () => {
    for (const m of [ar, en]) {
      const t = m.recovery.approve as Record<string, unknown>;
      for (const key of ["account", "roles", "office", "noOffice", "requestedAt", "expiresAt", "loadFailed"]) expect(t[key], key).toBeTruthy();
      for (const state of ["pending_approval", "approved", "rejected", "expired"]) { expect((t.states as Record<string, string>)[state]).toBeTruthy(); }
      for (const state of ["approved", "rejected", "expired"]) expect((t.closed as Record<string, string>)[state]).toBeTruthy();
      expect(t.confirmAccount).toContain("{name}");
    }
    expect(ar.recovery.approve.confirmAccount).toBe("ستعتمد استعادة حساب «{name}».");
  });
});
