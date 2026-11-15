import { describe, expect, it } from "vitest";
import { historyRecord } from "../src/lib/privacy";
import { actorLabel } from "../src/lib/editor";
import type { TransitionRecord } from "../src/lib/types";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const supervisor = "10000000-0000-4000-8000-0000000000a1", reporter = "10000000-0000-4000-8000-0000000000b2";
const record = (patch: Partial<TransitionRecord>): TransitionRecord => ({ id: "50000000-0000-4000-8000-000000000001", track: "editorial", from: "inbox", to: "acknowledged", reason: "seen, source to be checked", actor_id: supervisor, actor_name: "مشرف المكتب", occurred_at: "2026-11-15T09:00:00Z", ...patch } as TransitionRecord);

describe("the material history says who and why to those who read the material", () => {
  it("gives staff the reason of every transition, cleaned and bounded, with the work name", () => {
    const staff = { id: "10000000-0000-4000-8000-0000000000c3", staff: true, owner: false };
    expect(historyRecord(record({}), staff)).toMatchObject({ reason: "seen, source to be checked", actor_name: "مشرف المكتب", actor_id: supervisor });
    expect(historyRecord(record({ track: "rights", from: "unknown", to: "documented", reason: "contract on file" }), staff).reason).toBe("contract on file");
    expect(historyRecord(record({ reason: "a\u0000b\u0007c\u001fd\ne" }), staff).reason).toBe("abcd\ne");
    expect(Array.from(historyRecord(record({ reason: "😀".repeat(2500) }), staff).reason)).toHaveLength(2000);
    expect(historyRecord(record({ reason: 7 as never }), staff).reason).toBe("");
    expect(historyRecord(record({ note_timecode_ms: 4200 }), staff).note_timecode_ms).toBe(4200);
    expect(historyRecord(record({ note_timecode_ms: -1 }), staff).note_timecode_ms).toBeNull();
    // لا حقل خارج القائمة
    expect(historyRecord({ ...record({}), gps: "never", device_id: "never" } as never, staff)).not.toHaveProperty("gps");
  });
  it("gives the owner the reasons that reach them and the ones they wrote, and no other", () => {
    const owner = { id: reporter, staff: false, owner: true };
    expect(historyRecord(record({ to: "needs_changes", from: "reviewing", reason: "reshoot the first take" }), owner).reason).toBe("reshoot the first take");
    expect(historyRecord(record({ to: "rejected", reason: "named source" }), owner).reason).toBe("named source");
    expect(historyRecord(record({ from: "needs_changes", to: "reviewing", actor_id: reporter, actor_name: null, reason: "reshot" }), owner).reason).toBe("reshot");
    expect(historyRecord(record({ track: "technical", from: "failed", to: "pending", actor_id: reporter, reason: "retry" }), owner).reason).toBe("retry");
    for (const to of ["acknowledged", "reviewing", "accepted", "published"]) expect(historyRecord(record({ to }), owner).reason, to).toBe("");
    expect(historyRecord(record({ track: "rights", from: "unknown", to: "documented" }), owner).reason).toBe("");
    // اسم العمل للطاقم وحده
    expect(historyRecord(record({ to: "rejected" }), owner)).not.toHaveProperty("actor_name");
    // قارئ ليس من الطاقم ولا صاحب المادة لا يصله سبب
    expect(historyRecord(record({ to: "rejected" }), { id: reporter, staff: false, owner: false }).reason).toBe("");
  });
  it("names the actor: the reader as «you», a colleague by work name or account number, and the system", () => {
    expect(actorLabel(record({}), { id: supervisor, staff: true }, "ar")).toBe(ar.material.actorYou);
    expect(actorLabel(record({}), { id: reporter, staff: true }, "ar")).toBe("مشرف المكتب");
    expect(actorLabel(record({ actor_name: null }), { id: reporter, staff: true }, "ar")).toBe(ar.admin.unnamed.replace("{id}", supervisor.slice(0, 8)));
    expect(actorLabel(record({ actor_id: null, actor_name: null }), { id: reporter, staff: true }, "en")).toBe(en.material.systemActor);
    // المراسل: «أنت» لما فعله، ولغيره الوصف المحايد بلا معرّف حساب
    expect(actorLabel(record({ actor_id: reporter, actor_name: null }), { id: reporter, staff: false }, "ar")).toBe(ar.material.actorYou);
    expect(actorLabel(record({ actor_name: null }), { id: reporter, staff: false }, "ar")).toBe(ar.material.neutralActor);
    expect(ar.material.actorYou).toBe("أنت"); expect(en.material.actorYou).toBeTruthy(); expect(ar.material.systemActor).toBeTruthy();
  });
});
