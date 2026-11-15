import { describe, expect, it } from "vitest";
import { creatableRoles, officeInput, safeOffice, staffAccountInput } from "../src/lib/staff-policy";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const office = "30000000-0000-4000-8000-000000000001";

describe("what the administrator may create from the page", () => {
  it("offers every staff role and the reporter, and never the system administrator or a buyer", () => {
    expect(creatableRoles).toEqual(["editor_in_chief", "supervisor", "producer", "finance", "rights_officer", "reporter"]);
    for (const role of ["system_admin", "buyer_admin", "buyer_member", "owner"]) expect(staffAccountInput({ email: "a@example.test", role })).toBeNull();
    expect(staffAccountInput({ email: "a@example.test", role: "producer", roles: ["system_admin"] })).toBeNull();
  });
  it("builds the account as the contract takes it: scope for a supervisor, an office for a reporter, a work name for staff only", () => {
    expect(staffAccountInput({ email: " Staff@Example.test ", role: "producer", work_name: "مونتير المساء" })).toEqual({ email: "Staff@Example.test", role: "producer", work_name: "مونتير المساء", scope_kind: "all", scope_id: "" });
    expect(staffAccountInput({ email: "s@example.test", role: "supervisor", scope_kind: "office", scope_id: office })).toEqual({ email: "s@example.test", role: "supervisor", scope_kind: "office", scope_id: office });
    expect(staffAccountInput({ email: "s@example.test", role: "supervisor", scope_kind: "governorate", scope_id: "gaza", work_name: null })).toEqual({ email: "s@example.test", role: "supervisor", scope_kind: "governorate", scope_id: "gaza" });
    expect(staffAccountInput({ email: "r@example.test", role: "reporter", office_id: office })).toEqual({ email: "r@example.test", role: "reporter", scope_kind: "all", scope_id: "", office_id: office });
    for (const bad of [
      { email: "not-an-email", role: "producer" }, { email: "a@example.test" }, { email: "a@example.test", role: "producer", work_name: " padded " },
      { email: "r@example.test", role: "reporter" }, { email: "r@example.test", role: "reporter", office_id: "x" }, { email: "r@example.test", role: "reporter", office_id: office, work_name: "مراسل" },
      { email: "s@example.test", role: "supervisor", scope_kind: "office", scope_id: "not-an-id" }, { email: "s@example.test", role: "supervisor", scope_kind: "all", scope_id: office },
      { email: "p@example.test", role: "producer", scope_kind: "office", scope_id: office }, { email: "p@example.test", role: "producer", extra: 1 },
    ]) expect(staffAccountInput(bad as never), JSON.stringify(bad)).toBeNull();
  });
  it("takes an office by two names and a governorate, and shows one by a closed list", () => {
    expect(officeInput({ name_ar: "مكتب الشمال", name_en: "North office", governorate: "north_gaza" })).toEqual({ name_ar: "مكتب الشمال", name_en: "North office", governorate: "north_gaza" });
    for (const bad of [{ name_ar: " مكتب ", name_en: "o", governorate: "g" }, { name_ar: "م", name_en: "a‮b", governorate: "g" }, { name_ar: "م", name_en: "o" }, { name_ar: "م", name_en: "o", governorate: "g", id: office }]) expect(officeInput(bad as never)).toBeNull();
    expect(safeOffice({ id: office, name_ar: "مكتب غزة", name_en: "Gaza office", governorate: "gaza", address: "never" } as never)).toEqual({ id: office, name_ar: "مكتب غزة", name_en: "Gaza office", governorate: "gaza" });
    expect(safeOffice({ id: "x", name_ar: "م", name_en: "o", governorate: "g" } as never)).toBeNull();
  });
  it("has the words of the two forms in both languages", () => {
    for (const m of [ar, en]) {
      const t = m.admin.create as Record<string, unknown>;
      for (const key of ["title", "lead", "email", "role", "workName", "scope", "office", "chooseOffice", "submit", "done", "emailTaken", "invalid", "noAdmin", "limited", "officesTitle", "officesLead", "nameAr", "nameEn", "governorate", "addOffice", "officeExists", "officeDone", "noOffices"]) expect(t[key], key).toBeTruthy();
    }
    expect(ar.admin.createNote).not.toContain("مدير الخادم");
  });
});
