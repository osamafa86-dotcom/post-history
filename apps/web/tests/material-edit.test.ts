import { describe, expect, it } from "vitest";
import { changedFields, changeRequest, editErrors, editInput, editableStates } from "../src/lib/material-edit";
import type { TransitionRecord } from "../src/lib/types";

const material = { title: "عنوان المادة الأصلي", governorate: "غزة", city: "رفح", material_types: ["report", "interview"] as ("report" | "interview")[] };

describe("the owner edits the descriptive fields of a material before it is accepted", () => {
  it("is open in every state before acceptance, and closed once accepted or rejected", () => {
    expect([...editableStates]).toEqual(["inbox", "acknowledged", "reviewing", "needs_changes"]);
  });
  it("names the wrong fields in form order", () => {
    expect(editErrors({ ...material, title: "abcd", city: " ", material_types: [] })).toEqual(["title", "city", "material_types"]);
    expect(editErrors(material)).toEqual([]);
  });
  it("sends only what changed, trimmed, with the types in catalogue order, and nothing when nothing changed", () => {
    expect(changedFields(material, { ...material, title: "  عنوان مصحّح للمادة " })).toEqual({ title: "عنوان مصحّح للمادة" });
    expect(changedFields(material, { ...material, material_types: ["interview", "report"] })).toBeNull();
    expect(changedFields(material, { ...material, city: "خان يونس", material_types: ["report"] })).toEqual({ city: "خان يونس", material_types: ["report"] });
    expect(changedFields(material, { ...material })).toBeNull();
  });
  it("the BFF accepts the four fields only, each within its limits", () => {
    expect(editInput({ title: " عنوان مصحّح للمادة " })).toEqual({ title: "عنوان مصحّح للمادة" });
    expect(editInput({ material_types: ["interview", "breaking"] })).toEqual({ material_types: ["breaking", "interview"] });
    for (const body of [{}, { title: "abcd" }, { priority: "urgent" }, { title: "عنوان صالح", sensitivity: { minors: false } }, { material_types: [] }, { material_types: ["nope"] }, { material_types: ["report", "report"] }, { governorate: " " }, { city: "x".repeat(65) }, { tags: ["a"] }, { dynamic_fields: {} }])
      expect(editInput(body as Record<string, unknown>)).toBeNull();
  });
});

describe("the supervisor's request shown to the owner", () => {
  const record = (id: string, to: string, at: string, reason = ""): TransitionRecord => ({ id, track: "editorial", from: "reviewing", to, actor_id: null, occurred_at: at, reason }) as TransitionRecord;
  it("is the latest change request, whichever way the log is ordered", () => {
    const log = [record("1", "needs_changes", "2026-11-15T00:12:00Z", "الأولى"), record("2", "reviewing", "2026-11-15T00:13:00Z"), record("3", "needs_changes", "2026-11-15T00:46:00Z", "الثانية")];
    expect(changeRequest(log)?.reason).toBe("الثانية"); expect(changeRequest([...log].reverse())?.reason).toBe("الثانية");
    expect(changeRequest([record("2", "reviewing", "2026-11-15T00:13:00Z")])).toBeNull(); expect(changeRequest(null)).toBeNull();
  });
});
