import { describe, expect, it } from "vitest";
import { clock, groupNotifications, lastEvents, timecode, timeline, urgentUnacknowledged } from "../src/lib/editor";
import type { Material, Notification, TransitionRecord } from "../src/lib/types";
import { material } from "./fixtures";

const record = (id: string, track: TransitionRecord["track"], at: string): TransitionRecord => ({ id, track, from: "a", to: "b", reason: "", actor_id: null, occurred_at: at });
const note = (id: string, material_id: string | null, at: string, patch: Partial<Notification> = {}): Notification => ({ id, type: "material.received", material_id, priority: "normal", state: "delivered", created_at: at, read_at: null, acknowledged_at: null, escalation_level: 0, ...patch } as Notification);

describe("editor flow helpers (#385)", () => {
  it("lists urgent materials nobody has seen yet, oldest first", () => {
    const items: Material[] = [{ ...material(1), priority: "urgent", created_at: "2026-10-26T10:05:00Z" }, { ...material(2), priority: "urgent", created_at: "2026-10-26T10:00:00Z" }, { ...material(3), priority: "urgent", editorial_state: "acknowledged" }, { ...material(4), priority: "normal" }];
    expect(urgentUnacknowledged(items).map(m => m.id)).toEqual([items[1].id, items[0].id]);
  });
  it("counts up as mm:ss and shows hours past the hour", () => {
    expect(clock("2026-10-26T10:00:00Z", Date.parse("2026-10-26T10:01:05Z"))).toBe("01:05");
    expect(clock("2026-10-26T10:00:00Z", Date.parse("2026-10-26T11:02:03Z"))).toBe("1:02:03");
    expect(timecode(42000)).toBe("00:42");
  });
  it("keeps the three tracks apart: last event per track and a per-track timeline filter", () => {
    const records = [record("1", "editorial", "2026-10-26T10:00:00Z"), record("2", "rights", "2026-10-26T11:00:00Z"), record("3", "editorial", "2026-10-26T12:00:00Z")];
    const last = lastEvents(records); expect(last.editorial?.id).toBe("3"); expect(last.rights?.id).toBe("2"); expect(last.technical).toBeUndefined();
    expect(timeline(records, null).map(r => r.id)).toEqual(["3", "2", "1"]); expect(timeline(records, "editorial").map(r => r.id)).toEqual(["3", "1"]);
  });
  it("groups a material's alerts within 24 hours and sections them, urgent unacknowledged first", () => {
    const now = Date.parse("2026-10-26T15:00:00");
    const sections = groupNotifications([
      note("a", "m1", new Date(now - 3600000).toISOString()), note("b", "m1", new Date(now - 7200000).toISOString()),
      note("c", "m2", new Date(now - 26 * 3600000).toISOString()), note("d", "m3", new Date(now - 60000).toISOString(), { priority: "urgent" }),
      note("e", null, new Date(now - 5 * 86400000).toISOString(), { state: "read", read_at: "2026-10-21T10:00:00Z" }),
    ], now);
    expect(sections.map(s => s.name)).toEqual(["needsAck", "today", "yesterday", "older"]);
    expect(sections[1].groups[0].items.map(n => n.id)).toEqual(["a", "b"]); expect(sections[0].groups[0].head.id).toBe("d");
    expect(sections[3].groups[0].unread).toBe(false);
  });
});
