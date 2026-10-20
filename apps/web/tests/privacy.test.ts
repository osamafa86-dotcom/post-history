import { describe, expect, it } from "vitest";
import { mayReadField, redactValues, safeMaterial, safeForm } from "../src/lib/privacy";
import { validate, visibleFields } from "../src/lib/forms";
import { materialQuery } from "../src/lib/query";
import type { Field, Form, Permission } from "../src/lib/types";
import { form, material } from "./fixtures";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

describe("independent sensitive permissions", () => {
  const field = (key: string, type: Field["type"], sensitive: boolean) => ({ key, type, sensitive, label: { ar: key, en: key }, required: false }) as unknown as Field;
  const source = field("protected_source", "short_text", true), location = field("precise_location", "location", false), both = field("combined", "location", true);
  for (const [permissions, locationAllowed, sourceAllowed] of [
    [[], false, false], [["sensitive_location:read"], true, false], [["protected_source:read"], false, true], [["sensitive_location:read", "protected_source:read"], true, true],
  ] as [Permission[], boolean, boolean][]) {
    it(`independently gates location=${locationAllowed} and source=${sourceAllowed}`, () => {
      expect(mayReadField(location, permissions)).toBe(locationAllowed); expect(mayReadField(source, permissions)).toBe(sourceAllowed); expect(mayReadField(both, permissions)).toBe(locationAllowed && sourceAllowed);
      const schema: Form = { version: 1, fields: [source, location] };
      const values = redactValues({ protected_source: "source-canary", precise_location: "location-canary", unknown: "unknown-canary" }, schema, permissions);
      expect(Object.hasOwn(values, source.key)).toBe(sourceAllowed); expect(Object.hasOwn(values, location.key)).toBe(locationAllowed); expect(values.unknown).toBeUndefined();
    });
  }
  it("fails closed when the historical form is unavailable and strips even authorized GPS from v0", () => {
    const raw = { ...material(), gps: { lat: 33.123, lng: 44.987 }, dynamic_fields: { unknown: "canary" } };
    const result = safeMaterial(raw, ["sensitive_location:read", "protected_source:read"]);
    expect(result.dynamic_fields).toEqual({}); expect(result.gps).toBeUndefined();
  });
  it("never renders a conditional child of a hidden sensitive field", () => {
    const child = { ...field("child", "short_text", false), required: true, condition: { field: source.key, equals: "yes" } };
    expect(visibleFields({ version: 1, fields: [source, child] }, "report", { [source.key]: "yes" }, [])).toEqual([]);
  });
  it("honors server-side redacted keys even when the client has both permissions", () => {
    expect(redactValues({ [source.key]: "canary" }, { version: 1, fields: [source] }, ["protected_source:read"], [source.key])).toEqual({});
  });
  it("removes a hidden field's default value before sending the schema to the browser", () => {
    const schema: Form = { version: 1, fields: [{ ...source, default: "canary-default" }, location] };
    expect(JSON.stringify(safeForm(schema, []))).not.toContain("canary-default");
    expect(safeForm(schema, ["protected_source:read"]).fields).toHaveLength(1);
  });
});

it("accepts only explicit contract columns and rejects sensitive/unknown filters", () => {
  expect(materialQuery(new URLSearchParams("technical_state=verified&governorate=Gaza&limit=100"))).toEqual({ technical_state: "verified", governorate: "Gaza", limit: 100 });
  for (const query of ["gps=1,2", "sort=dynamic_fields", "limit=101", "limit=5&limit=10", "reporter_id=not-an-id", "rights_state=approved", "shot_after=tomorrow"]) expect(() => materialQuery(new URLSearchParams(query))).toThrow();
});

it("does not mutate submitted values while checking Unicode and conditional fields", () => {
  const values = { short_title: "😀😀" }, before = structuredClone(values);
  validate(form, "report", values); expect(values).toEqual(before);
});

it("has complete Arabic and English resource parity", () => {
  const keys = (value: object, prefix = ""): string[] => Object.entries(value).flatMap(([key, child]) => typeof child === "object" ? keys(child, `${prefix}${key}.`) : [`${prefix}${key}`]).sort();
  expect(keys(ar)).toEqual(keys(en));
});
