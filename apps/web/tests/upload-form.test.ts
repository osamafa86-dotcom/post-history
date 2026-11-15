import { describe, expect, it } from "vitest";
import { baseErrors, createFailure, pairSessions } from "../src/lib/upload-policy";
import { errorText, unavailableRequired, validate, webUnavailable } from "../src/lib/forms";
import { clearDraft, lastPlace, readDraft, rememberPlace, saveDraft, type UploadDraft } from "../src/lib/upload-draft";
import type { Field, Form } from "../src/lib/types";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

const base = { title: "عنوان صالح للمادة", governorate: "غزة", city: "دير البلح", shot_at: "", mode: "network", pseudonym: "" };
const now = Date.parse("2026-11-15T10:00:00Z");

describe("the upload form names each base field that is wrong", () => {
  it("accepts a complete base", () => { expect(baseErrors(base, now)).toEqual([]); });
  it("flags the title by its limits, counted in code points after trimming", () => {
    expect(baseErrors({ ...base, title: "abcd" }, now)).toEqual(["title"]);
    expect(baseErrors({ ...base, title: "     " }, now)).toEqual(["title"]);
    expect(baseErrors({ ...base, title: "😀".repeat(80) }, now)).toEqual([]);
    expect(baseErrors({ ...base, title: "x".repeat(81) }, now)).toEqual(["title"]);
  });
  it("flags a blank governorate and city, and a pseudonym that was chosen and left empty, in form order", () => {
    expect(baseErrors({ ...base, title: "", governorate: "  ", city: "", mode: "pseudonym", pseudonym: " " }, now)).toEqual(["title", "governorate", "city", "pseudonym"]);
    expect(baseErrors({ ...base, mode: "real_name", pseudonym: "" }, now)).toEqual([]);
  });
  it("flags a shooting time in the future, and accepts one a minute ago", () => {
    expect(baseErrors({ ...base, shot_at: "2031-05-01T10:00" }, now)).toEqual(["shot_at"]);
    expect(baseErrors({ ...base, shot_at: new Date(now - 60000).toISOString() }, now)).toEqual([]);
  });
});

describe("a field error says its limit", () => {
  const field = (patch: Partial<Field>) => ({ key: "k", type: "short_text", label: { ar: "حقل", en: "Field" }, required: false, ...patch }) as Field;
  it("gives the length, the value, the count and the date from the field's rules", () => {
    expect(errorText(field({ validation: { min_length: 2, max_length: 80 } }), "min_length", "ar")).toContain("2");
    expect(errorText(field({ validation: { min_length: 2, max_length: 80 } }), "max_length", "en")).toBe("Too long. Maximum length: 80 characters.");
    expect(errorText(field({ type: "number", validation: { min: 0, max: 100000 } }), "max", "en")).toBe("Too high. Maximum value: 100,000.");
    expect(errorText(field({ type: "multi_select", validation: { min_items: 1, max_items: 3 } }), "max_items", "ar")).toContain("3");
    expect(errorText(field({ type: "datetime", validation: { not_before: "2020-01-01T00:00:00Z" } }), "not_before", "en")).toContain("2020");
  });
  it("falls back to the plain sentence when the rule carries no limit", () => {
    expect(errorText(field({}), "required", "ar")).toBe(ar.validation.required);
    expect(errorText(field({}), "min_length", "en")).toBe(en.validation.min_length);
  });
});

describe("fields the web cannot fill yet", () => {
  const form: Form = { version: 3, published_at: "2026-11-01T00:00:00Z", published_by: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", fields: [
    { key: "release", type: "attachment", label: { ar: "البيان", en: "Release" }, required: true, material_types: ["press_conference"] },
    { key: "producer", type: "staff_member", label: { ar: "المنتج", en: "Producer" }, required: false },
    { key: "summary", type: "long_text", label: { ar: "ملخص", en: "Summary" }, required: false },
  ] } as Form;
  it("are the attachment and the staff member", () => { expect([...webUnavailable]).toEqual(["attachment", "staff_member"]); });
  it("do not fail validation when left empty, and are named when the form requires one of them", () => {
    expect(validate(form, "press_conference", {}, [], webUnavailable).valid).toBe(true);
    expect(validate(form, "press_conference", {}).valid).toBe(false);
    expect(unavailableRequired(form, "press_conference", {}, [], webUnavailable).map(f => f.key)).toEqual(["release"]);
    expect(unavailableRequired(form, "report", {}, [], webUnavailable)).toEqual([]);
  });
});

describe("a failed session creation is told apart from a refusal", () => {
  it("reads 5xx as our fault, 404 and 409 as a session that no longer accepts, 401 as the sign-in session", () => {
    expect(createFailure(502)).toBe("storage_error"); expect(createFailure(503)).toBe("storage_error");
    expect(createFailure(404)).toBe("not_accepted"); expect(createFailure(409)).toBe("not_accepted");
    expect(createFailure(401)).toBe("session_revoked"); expect(createFailure(422)).toBe("rejected"); expect(createFailure(429)).toBe("rejected");
  });
});

describe("one card per unfinished file", () => {
  const session = (id: string, material_id: string, size_bytes: number) => ({ id, material_id, kind: "original", size_bytes });
  const record = (key: string, material_id: string, size_bytes: number, session_id?: string) => ({ key, material_id, session_id, create: { kind: "original", size_bytes } });
  it("pairs a server session with its local record by id, and with a record that never learned its id by material, kind and size", () => {
    const sessions = [session("s1", "m1", 100), session("s2", "m1", 200), session("s3", "m2", 100)];
    const records = [record("a", "m1", 200), record("b", "m1", 100, "s1"), record("c", "m9", 5)];
    const { pairs, orphans } = pairSessions(sessions, records);
    expect(pairs.map(p => [p.session.id, p.record?.key ?? null])).toEqual([["s1", "b"], ["s2", "a"], ["s3", null]]);
    expect(orphans.map(r => r.key)).toEqual(["c"]);
  });
  it("never gives one record to two sessions", () => {
    const { pairs, orphans } = pairSessions([session("s1", "m1", 100), session("s2", "m1", 100)], [record("a", "m1", 100)]);
    expect(pairs.map(p => p.record?.key ?? null)).toEqual(["a", null]); expect(orphans).toEqual([]);
  });
});

describe("the upload draft survives a lost session for its owner only", () => {
  const store = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data }; };
  const draft: UploadDraft = { title: "عنوان", types: ["report"], tags: ["وسم"], governorate: "غزة", city: "رفح", shot_at: "2026-11-14T09:30", priority: "urgent" };
  it("returns what was saved to the same account, and nothing to another", () => {
    const s = store(); saveDraft("user-1", draft, now, s);
    expect(readDraft("user-1", now + 1000, s)).toEqual(draft);
    expect(readDraft("user-2", now + 1000, s)).toBeNull(); expect(s.data.size).toBe(0);
  });
  it("keeps no sensitivity answer, no pseudonym and no dynamic value", () => {
    const s = store(); saveDraft("user-1", { ...draft, sensitivity: { gate: "yes" }, pseudonym: "اسم", dynamic: { a: 1 } } as UploadDraft, now, s);
    expect(Object.keys(readDraft("user-1", now, s)!).sort()).toEqual(["city", "governorate", "priority", "shot_at", "tags", "title", "types"]);
  });
  it("expires after eight hours, drops a malformed entry, and is removed on demand", () => {
    const s = store(); saveDraft("user-1", draft, now, s);
    expect(readDraft("user-1", now + 8 * 3600000 + 1, s)).toBeNull();
    s.setItem("upload-draft", JSON.stringify({ user: "user-1", at: now, draft: { ...draft, types: ["nope"] } })); expect(readDraft("user-1", now, s)).toBeNull();
    s.setItem("upload-draft", "{"); expect(readDraft("user-1", now, s)).toBeNull();
    saveDraft("user-1", draft, now, s); clearDraft(s); expect(readDraft("user-1", now, s)).toBeNull();
  });
  it("an empty form saves nothing", () => { const s = store(); saveDraft("user-1", { ...draft, title: " ", types: [], tags: [], governorate: "", city: "", shot_at: "", priority: "normal" }, now, s); expect(s.data.size).toBe(0); });
  it("remembers the last place for the next material of the same account", () => {
    const s = store(); rememberPlace("user-1", "غزة", "رفح", s);
    expect(lastPlace("user-1", s)).toEqual({ governorate: "غزة", city: "رفح" }); expect(lastPlace("user-2", s)).toBeNull();
  });
});
