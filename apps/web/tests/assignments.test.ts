import { describe, expect, it } from "vitest";
import { assignmentDetails, assignmentInput, byteSize, canAssign, dueAt, dueLabel, mediaDuration, nextStates, notificationTarget, rushes, safeAssignment, safeCandidate, safeExport, safeMyPage, taskOrder, transitionInput, validNote, type MaterialAssignment } from "../src/lib/assignment-policy";
import { rotation, wallMinutes, wallOrder } from "../src/lib/board";
import { safeNotification } from "../src/lib/privacy";
import type { Me, Material, Notification } from "../src/lib/types";
import { assignmentIds, material, me, task } from "./fixtures";

const ids = assignmentIds;
const user = (roles: Me["roles"][number]["name"][], id = me.user_id): Me => ({ ...me, user_id: id, roles: roles.map(name => ({ name, scopes: [] })) });

describe("assignment transitions as the web offers them (ADR 0096 table)", () => {
  it("lets the assignee move forward and return, and a manager only return; nothing after done or returned", () => {
    const producer = user(["producer"], ids.producer), supervisor = user(["supervisor"]), other = user(["producer"]);
    expect(nextStates(task(), producer)).toEqual(["acknowledged", "in_progress", "returned"]);
    expect(nextStates(task({ state: "acknowledged" }), producer)).toEqual(["in_progress", "returned"]);
    expect(nextStates(task({ state: "in_progress" }), producer)).toEqual(["done", "returned"]);
    expect(nextStates(task(), supervisor)).toEqual(["returned"]);
    expect(nextStates(task(), other)).toEqual([]);
    for (const state of ["done", "returned"] as const) { expect(nextStates(task({ state }), producer)).toEqual([]); expect(nextStates(task({ state }), supervisor)).toEqual([]); }
  });
  it("offers assigning only to supervisors and the editor-in-chief, on materials accepted for production", () => {
    const accepted = { ...material(1), editorial_state: "accepted" as const };
    expect(canAssign(user(["supervisor"]), accepted)).toBe(true); expect(canAssign(user(["editor_in_chief"]), { ...accepted, editorial_state: "final_review" })).toBe(true);
    expect(canAssign(user(["supervisor"]), { ...accepted, editorial_state: "inbox" })).toBe(false);
    for (const role of ["producer", "system_admin", "rights_officer", "reporter"] as const) expect(canAssign(user([role]), accepted)).toBe(false);
  });
});

describe("due presets and labels (W3, W5, M3)", () => {
  const now = new Date(2026, 10, 3, 14, 30, 0).getTime();
  it("computes 30 minutes, an hour and the end of today, and drops today in its last half hour", () => {
    expect(Date.parse(dueAt("30m", now)!) - now).toBe(1800000); expect(Date.parse(dueAt("1h", now)!) - now).toBe(3600000);
    expect(new Date(dueAt("today", now)!).getHours()).toBe(23); expect(dueAt("today", new Date(2026, 10, 3, 23, 40).getTime())).toBeNull();
  });
  it("reads overdue, soon, today, later and closed", () => {
    expect(dueLabel(task({ due_at: new Date(now - 3600000).toISOString(), overdue: true }), now)).toMatchObject({ kind: "overdue", ms: 3600000 });
    expect(dueLabel(task({ due_at: new Date(now + 18 * 60000).toISOString() }), now).kind).toBe("soon");
    expect(dueLabel(task({ due_at: new Date(2026, 10, 3, 23, 0).toISOString() }), now).kind).toBe("today");
    expect(dueLabel(task({ due_at: new Date(2026, 10, 5, 12, 0).toISOString() }), now).kind).toBe("later");
    expect(dueLabel(task({ state: "done", due_at: new Date(now - 3600000).toISOString(), overdue: false }), now).kind).toBe("closed");
  });
  it("orders my tasks overdue first, then by the nearest deadline", () => {
    const a = task({ id: "a", due_at: "2026-11-03T16:00:00Z" }), b = task({ id: "b", due_at: "2026-11-03T15:00:00Z" }), c = task({ id: "c", due_at: "2026-11-03T12:00:00Z", overdue: true });
    expect(taskOrder([a, b, c]).map(t => t.id)).toEqual(["c", "b", "a"]);
  });
});

describe("assignment whitelists in the BFF", () => {
  it("drops unknown fields, hides work names from those who may not see them, and fails closed on a bad row", () => {
    const raw = { ...task(), debug: "canary" } as MaterialAssignment;
    expect(safeAssignment(raw, true)).toEqual(task()); expect(JSON.stringify(safeAssignment(raw, true))).not.toContain("canary");
    const hidden = safeAssignment(raw, false)!; expect(hidden).not.toHaveProperty("assignee_name"); expect(hidden).not.toHaveProperty("assigned_by_name");
    for (const bad of [{ state: "paused" }, { note: "سطر\nثانٍ" }, { note: "\u202eمقلوب" }, { assignee_id: "x" }, { due_at: "tomorrow" }, { overdue: "yes" }] as Partial<MaterialAssignment>[]) expect(safeAssignment(task(bad), true)).toBeNull();
    expect(safeAssignment(task({ assignee_name: "اسم\u202e" }), true)!.assignee_name).toBeNull();
  });
  it("keeps candidates to ids, a work name and counts; pages and summaries to their fields", () => {
    expect(safeCandidate({ user_id: ids.producer, work_name: "مونتير", open_count: 2, urgent_open_count: 1, overdue_count: 0, email: "x@example.test" } as never)).toEqual({ user_id: ids.producer, work_name: "مونتير", open_count: 2, urgent_open_count: 1, overdue_count: 0 });
    expect(safeCandidate({ user_id: ids.producer, work_name: null, open_count: -1, urgent_open_count: 0, overdue_count: 0 })).toBeNull();
    const page = safeMyPage({ items: [task(), task({ state: "paused" as never })], next_cursor: "c".repeat(3000), summary: { active: 3, overdue: -1, done_last_7_days: 7 } }, true);
    expect(page.items).toHaveLength(1); expect(page.next_cursor).toBeNull(); expect(page.summary).toEqual({ active: 3, overdue: 0, done_last_7_days: 7 });
    expect(safeExport({ state: "ready", source_file_id: ids.material, file_id: ids.task, requested_by: ids.producer, requested_at: "2026-11-03T14:30:00Z", failure_reason: null })).toEqual({ state: "ready", source_file_id: ids.material, file_id: ids.task, requested_at: "2026-11-03T14:30:00Z", failure_reason: null });
    expect(safeExport({ state: "built" as never, source_file_id: null, file_id: null, requested_at: null })).toBeNull();
  });
  it("rebuilds the assign and transition bodies from the contract fields only", () => {
    const now = Date.parse("2026-11-03T14:30:00Z"), due = "2026-11-03T15:00:00Z";
    expect(assignmentInput({ assignee_id: ids.producer, due_at: due, note: "ملاحظة" }, now)).toEqual({ assignee_id: ids.producer, due_at: due, note: "ملاحظة" });
    for (const bad of [{ assignee_id: ids.producer, due_at: "2026-11-03T14:00:00Z" }, { assignee_id: ids.producer, due_at: "2026-12-04T15:00:00Z" }, { assignee_id: "me", due_at: due }, { assignee_id: ids.producer, due_at: due, note: " ملاحظة" }, { assignee_id: ids.producer, due_at: due, note: "x".repeat(501) }, { assignee_id: ids.producer, due_at: due, priority: "urgent" }])
      expect(assignmentInput(bad, now)).toBeNull();
    expect(transitionInput({ to: "returned", note: "سبب" })).toEqual({ to: "returned", note: "سبب" }); expect(transitionInput({ to: "done" })).toEqual({ to: "done" });
    for (const bad of [{ to: "assigned" }, { to: "done", note: "سبب" }, { to: "returned", note: "سطر\nثانٍ" }, { to: "done", state: "done" }]) expect(transitionInput(bad)).toBeNull();
    expect(validNote("x".repeat(500))).toBe(true); expect(validNote("")).toBe(false);
  });
  it("passes machine details of the assignment codes only", () => {
    expect(assignmentDetails("assignment_open", { assignment_id: ids.task, note: "canary" })).toEqual({ assignment_id: ids.task });
    expect(assignmentDetails("assignment_not_allowed", { failed: ["editorial_state", "canary"] })).toEqual({ failed: ["editorial_state"] });
    expect(assignmentDetails("invalid_transition", { from: "done", to: "returned" })).toEqual({ from: "done", to: "returned" });
    expect(assignmentDetails("invalid_transition", { from: "canary", to: "returned" })).toEqual({});
  });
});

describe("notifications open their task (W10 → W6)", () => {
  it("keeps assignment_id through the notification whitelist and links to the task before the material", () => {
    const n = { id: "60000000-0000-4000-8000-000000000001", type: "assignment.created", title: "مهمة جديدة", material_id: ids.material, assignment_id: ids.task, priority: "urgent", state: "sent", assignment_state: "assigned", created_at: "2026-11-03T14:30:00Z" } as Notification;
    const safe = safeNotification(n); expect(safe.assignment_id).toBe(ids.task); expect(safe.title).toBe("");
    expect(notificationTarget(safe, "ar")).toBe(`/ar/tasks/${ids.task}`);
    expect(notificationTarget({ ...safe, assignment_id: null }, "en")).toBe(`/en/materials/${ids.material}`);
    expect(safeNotification({ ...n, assignment_id: "not-a-uuid" })).not.toHaveProperty("assignment_id");
  });
});

describe("rushes, sizes and the wall (W6, W4)", () => {
  it("counts originals with their total size, and formats sizes and durations with Latin digits", () => {
    const item = { ...material(1), files: [{ id: "a", kind: "original", state: "verified", size_bytes: 420_000_000, duration_ms: 102_000, created_at: "2026-11-03T14:30:00Z" }, { id: "b", kind: "original", state: "verified", size_bytes: 780_000_000, created_at: "2026-11-03T14:30:00Z" }, { id: "c", kind: "proxy", state: "verified", size_bytes: 1, created_at: "2026-11-03T14:30:00Z" }] } as Material;
    expect(rushes(item)).toMatchObject({ count: 2, size: 1_200_000_000 }); expect(byteSize(1_200_000_000)).toBe("1.2 GB"); expect(byteSize(412_000_000)).toBe("412 MB");
    expect(mediaDuration(134_000)).toBe("2:14"); expect(mediaDuration(3_723_000)).toBe("1:02:03"); expect(mediaDuration(null)).toBeNull();
  });
  it("orders the wall urgent first then newest, twelve tiles a page, and shows HH:MM", () => {
    const tile = (i: number, priority: Material["priority"], at: string): Material => ({ ...material(i), priority, created_at: at });
    const items = [tile(1, "normal", "2026-11-03T14:00:00Z"), tile(2, "urgent", "2026-11-03T12:00:00Z"), tile(3, "important", "2026-11-03T14:10:00Z"), tile(4, "urgent", "2026-11-03T13:00:00Z")];
    expect(wallOrder(items).map(m => m.id)).toEqual([items[3].id, items[1].id, items[2].id, items[0].id]);
    const many = Array.from({ length: 25 }, (_, i) => tile(i + 1, "normal", "2026-11-03T12:00:00Z"));
    expect(rotation(many, 0, 12)).toMatchObject({ pages: 3 }); expect(rotation(many, 2, 12).shown).toHaveLength(1);
    expect(wallMinutes(new Date(2026, 10, 3, 14, 38, 9).getTime())).toBe("14:38");
  });
});
