import { describe, expect, it } from "vitest";
import { asksAck, notificationKind, ownerNews } from "../src/lib/notification-kind";
import { groupNotifications } from "../src/lib/editor";
import { defaultFanout, pendingChannels, ruleEvents } from "../src/lib/notification-policy";
import { reasonReaches } from "../src/lib/review";
import type { Notification } from "../src/lib/types";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const note = (patch: Partial<Notification>): Notification => ({ id: "70000000-0000-4000-8000-000000000001", type: "material.updated", title: "", material_id: "20000000-0000-4000-8000-000000000001", priority: "normal", state: "sent", assignment_state: null, escalation_level: 0, created_at: "2026-11-15T09:00:00Z", read_at: null, acknowledged_at: null, ...patch } as Notification);

describe("a notification says what happened", () => {
  it("has a word for each event that reaches the owner of a material", () => {
    const words = { "material.acknowledged": "seen", "material.change_requested": "changes", "material.rejected": "rejected", "material.accepted": "accepted", "material.published": "published", "upload.verified": "received" } as const;
    expect([...ownerNews].sort()).toEqual(Object.keys(words).sort());
    for (const [type, word] of Object.entries(words)) expect(notificationKind(note({ type })).word, type).toBe(word);
    expect(ar.shell.bell.kinds).toMatchObject({ seen: "شوهدت مادتك", changes: "طُلب تعديل على مادتك", rejected: "رُفضت مادتك", accepted: "قُبلت مادتك", published: "نُشرت مادتك", received: "وصل ملفك" });
    for (const m of [ar, en]) for (const word of Object.values(words)) expect((m.shell.bell.kinds as Record<string, string>)[word]).toBeTruthy();
  });
  it("keeps the word when the material is urgent, and marks urgency beside it", () => {
    expect(notificationKind(note({ type: "material.change_requested", priority: "urgent" }))).toEqual({ word: "changes", icon: "pencil", urgent: true });
    expect(notificationKind(note({ type: "material.acknowledged" })).urgent).toBe(false);
    expect((ar.shell.bell.kinds as Record<string, string>).urgent).toBeUndefined();
  });
  it("calls an arriving material an arrival, not a task assigned to the reader", () => {
    for (const type of ["material.created", "material.urgent_received"]) expect(notificationKind(note({ type, assignment_state: "assigned" })).word).toBe("incoming");
    expect(ar.shell.bell.kinds.incoming).toBe("مادة واردة");
    expect(notificationKind(note({ type: "material.resubmitted" })).word).toBe("resubmitted");
    expect(notificationKind(note({ type: "material.accepted_for_production", assignment_state: "assigned" })).word).toBe("production");
    expect(notificationKind(note({ type: "notification.escalated", assignment_state: "assigned" })).word).toBe("escalated");
    // مهمة المونتير وطلب الاستعادة كما كانا
    expect(notificationKind(note({ type: "assignment.created", assignment_id: "80000000-0000-4000-8000-000000000001" })).word).toBe("task");
    expect(notificationKind(note({ type: "auth.recovery_requested", material_id: null, recovery_request_id: "90000000-0000-4000-8000-000000000001" }))).toEqual({ word: "account", icon: "key", urgent: false });
    expect(notificationKind(note({ type: "material.updated", assignment_state: "assigned" })).word).toBe("task");
    for (const m of [ar, en]) for (const word of ["incoming", "resubmitted", "production", "escalated", "task", "account", "update", "store", "money", "upload"]) expect((m.shell.bell.kinds as Record<string, string>)[word], word).toBeTruthy();
  });
  it("asks no acknowledgement from the owner of a material, urgent or not", () => {
    for (const type of ownerNews) {
      expect(asksAck(note({ type, priority: "urgent" }))).toBe(false);
      expect(groupNotifications([note({ type, priority: "urgent" })], Date.parse("2026-11-15T10:00:00Z"))[0].name).toBe("today");
    }
    expect(asksAck(note({ type: "material.urgent_received", priority: "urgent", assignment_state: "assigned" }))).toBe(true);
    expect(groupNotifications([note({ type: "material.urgent_received", priority: "urgent", assignment_state: "assigned" })], Date.parse("2026-11-15T10:00:00Z"))[0].name).toBe("needsAck");
    expect(asksAck(note({ type: "material.urgent_received", priority: "urgent", state: "acknowledged" }))).toBe(false);
  });
  it("names the link of a recovery request and of a task", () => {
    for (const m of [ar, en]) { expect(m.notice.openRequest).toBeTruthy(); expect(m.notice.openRequest).not.toBe(m.notice.open); }
    expect(ar.notice.openRequest).toBe("افتح الطلب");
  });
});

describe("the rules page shows what happens without a rule", () => {
  it("lists the default routing of every event that notifies someone", () => {
    expect(defaultFanout.map(row => row.event)).toEqual(["material.created", "material.urgent_received", "material.acknowledged", "material.change_requested", "material.rejected", "material.accepted", "material.resubmitted", "material.accepted_for_production", "material.published", "upload.verified", "notification.escalated"]);
    expect(defaultFanout.filter(row => row.audience === "reporter").map(row => row.event)).toEqual(["material.acknowledged", "material.change_requested", "material.rejected", "material.accepted", "material.published", "upload.verified"]);
    expect(defaultFanout.filter(row => row.task).map(row => row.event)).toEqual(["material.created", "material.urgent_received", "material.accepted_for_production", "notification.escalated"]);
    // ما تستبدله قاعدة الإدارة: أحداث القواعد وحدها
    expect(defaultFanout.filter(row => row.ruleable).every(row => (ruleEvents as string[]).includes(row.event))).toBe(true);
    expect(defaultFanout.filter(row => !row.ruleable).map(row => row.event)).toEqual(["material.rejected", "material.accepted", "material.resubmitted", "notification.escalated"]);
    for (const m of [ar, en]) {
      for (const row of defaultFanout) expect((m.rules.defaults.events as Record<string, string>)[row.event], row.event).toBeTruthy();
      for (const audience of ["supervisors", "reporter", "producers", "chain"]) expect((m.rules.defaults.audiences as Record<string, string>)[audience]).toBeTruthy();
      expect(m.rules.replacesDefault).toContain("{event}");
    }
  });
  it("marks the channels nothing sends on yet", () => {
    expect(pendingChannels).toEqual(["web_push", "email", "telegram", "whatsapp", "sms"]);
    expect(ar.rules.notYet).toBe("غير مفعّل بعد"); expect(en.rules.notYet).toBeTruthy();
  });
});

describe("the transition dialog says where the reason goes", () => {
  it("reaches the reporter only for a change request and a rejection on the editorial track", () => {
    expect(reasonReaches("editorial", "needs_changes")).toBe(true); expect(reasonReaches("editorial", "rejected")).toBe(true);
    for (const to of ["acknowledged", "reviewing", "accepted", "final_review", "published", "in_production"]) expect(reasonReaches("editorial", to), to).toBe(false);
    for (const to of ["documented", "sellable", "blocked", "withdrawn"]) expect(reasonReaches("rights", to), to).toBe(false);
    expect(reasonReaches("technical", "pending")).toBe(false);
    for (const m of [ar, en]) { expect(m.review.reasonStays).toBeTruthy(); expect(m.review.reasonStays).not.toBe(m.review.previewText); }
  });
});
