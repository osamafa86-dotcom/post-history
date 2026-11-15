import { describe, expect, it } from "vitest";
import { boundProblems, newField, validForm } from "../src/lib/form-admin";
import type { Form } from "../src/lib/types";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

type Field = Form["fields"][number];
const field = (type: Field["type"], key: string, validation: Record<string, unknown>) => ({ ...newField(type, key), label: { ar: "حقل", en: "Field" }, validation: { ...(newField(type, key).validation ?? {}), ...validation } }) as Field;
const form = (fields: Field[]): Form => ({ version: 2, fields } as Form);

describe("a field whose lower bound is above its upper bound is not published", () => {
  it("finds the crossed pair of each kind and names the field", () => {
    const crossed = form([field("short_text", "headline", { min_length: 10, max_length: 5 }), field("number", "crew", { min: 8, max: 2 }), field("multi_select", "themes", { min_items: 2, max_items: 1 }), field("long_text", "notes", { min_length: 3, max_length: 3 })]);
    expect(boundProblems(crossed)).toEqual([{ key: "headline", low: "min_length", high: "max_length" }, { key: "crew", low: "min", high: "max" }, { key: "themes", low: "min_items", high: "max_items" }]);
    expect(validForm(crossed)).toBe(false);
  });
  it("accepts equal bounds and a single bound", () => {
    const fine = form([field("short_text", "code", { min_length: 4, max_length: 4 }), field("number", "count", { min: 0 }), field("number", "ratio", { min: -1.5, max: 1.5 }), field("long_text", "story", { max_length: 500 })]);
    expect(boundProblems(fine)).toEqual([]); expect(validForm(fine)).toBe(true);
  });
  it("has a message that names the field and both bounds, and its own words for publishing and discarding", () => {
    for (const m of [ar, en]) {
      for (const slot of ["{field}", "{low}", "{high}"]) expect(m.formsAdmin.boundsCrossed).toContain(slot);
      expect(m.formsAdmin.confirmPublish).toContain("{version}"); expect(m.formsAdmin.confirmDiscard).toBeTruthy();
      expect(m.formsAdmin.confirmPublish).not.toBe(m.confirm); expect(m.formsAdmin.confirmDiscard).not.toBe(m.confirm);
    }
    expect(ar.formsAdmin.confirmDiscard).toBe("ألغِ المسودة");
  });
});
