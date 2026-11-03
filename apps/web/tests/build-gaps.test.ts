import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Field, Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { MemoryStore } from "./memory-store";
import { material, me, task, tokens } from "./fixtures";
import { rolesInput, safeStaffRoles, sameRoles } from "../src/lib/staff-policy";
import { rejectionInput, safeOrganization, type Organization } from "../src/lib/buyer-policy";
import { materialTagsInput, validMaterialTags } from "../src/lib/tag-policy";
import { newField, storeBlocked, urgentLocked, validForm, withToggles } from "../src/lib/form-admin";
import { matchesType, rowThumb } from "../src/lib/inbox-tabs";
import { safeAssignment, transitionInput } from "../src/lib/assignment-policy";
import { safeMaterial } from "../src/lib/privacy";
import { safeUploadSession, uploadInput } from "../src/server/uploads";

// فجوات البناء على الويب (ADR 0104، 0105): القوائم البيضاء والمدخلات والـBFF للأدوار والرفض والوسوم والنسخة المُنتَجة والمصغّرة.
const hidden = { rlm: "\u200F", nbsp: "\u00A0" };
const officeId = "0f1e2d3c-4b5a-4697-8877-665544332211";

describe("staff roles (A1)", () => {
  it("accepts staff roles once each, scopes on the supervisor alone, and never the administrator or buyer roles", () => {
    expect(rolesInput({ roles: [{ name: "supervisor", scopes: [{ kind: "governorate", id: "محافظة ١" }, { kind: "office", id: officeId }] }, { name: "producer", scopes: [] }] }))
      .toEqual({ roles: [{ name: "supervisor", scopes: [{ kind: "governorate", id: "محافظة ١" }, { kind: "office", id: officeId }] }, { name: "producer", scopes: [] }] });
    for (const roles of [[], [{ name: "system_admin", scopes: [] }], [{ name: "buyer_admin", scopes: [] }], [{ name: "producer", scopes: [] }, { name: "producer", scopes: [] }],
      [{ name: "producer", scopes: [{ kind: "office", id: officeId }] }], [{ name: "supervisor", scopes: [{ kind: "governorate", id: ` محافظة` }] }],
      [{ name: "supervisor", scopes: [{ kind: "governorate", id: `محا${hidden.rlm}فظة` }] }], [{ name: "supervisor", scopes: [{ kind: "office", id: "not-a-uuid" }] }],
      [{ name: "supervisor", scopes: [{ kind: "organization", id: officeId }] }]]) expect(rolesInput({ roles })).toBeNull();
    expect(rolesInput({ roles: [{ name: "producer", scopes: [] }], user_id: me.user_id })).toBeNull();
  });
  it("whitelists the roles read and compares role sets without order", () => {
    const read = safeStaffRoles({ user_id: me.user_id, roles: [{ name: "supervisor", scopes: [{ kind: "governorate", id: "محافظة ١" }, { kind: "governorate", id: `x${hidden.nbsp}` }] }], canary: "never-display-canary" } as never);
    expect(read).toEqual({ user_id: me.user_id, roles: [{ name: "supervisor", scopes: [{ kind: "governorate", id: "محافظة ١" }] }] });
    expect(sameRoles([{ name: "producer", scopes: [] }, { name: "reporter", scopes: [] }], [{ name: "reporter", scopes: [] }, { name: "producer", scopes: [] }])).toBe(true);
    expect(sameRoles([{ name: "supervisor", scopes: [] }], [{ name: "supervisor", scopes: [{ kind: "office", id: officeId }] }])).toBe(false);
  });
});

describe("buyer rejection (A5)", () => {
  const org = { id: randomUUID(), legal_name: "مؤسسة", display_name: { ar: "مؤسسة", en: "Org" }, country: "QA", billing_email: "b@example.test", seats: 2, status: "rejected", active_members: 0, verified_at: null, rejection_reason: "duplicate_organization", created_at: "2026-11-03T09:00:00Z", updated_at: "2026-11-03T09:00:00Z" } as Organization;
  it("takes one closed reason and shows it only on a rejected organization", () => {
    expect(rejectionInput({ reason_code: "other" })).toEqual({ reason_code: "other" });
    expect(rejectionInput({ reason_code: "free text" })).toBeNull(); expect(rejectionInput({ reason_code: "other", note: "x" })).toBeNull();
    expect(safeOrganization(org).rejection_reason).toBe("duplicate_organization");
    expect(safeOrganization({ ...org, status: "pending_verification" })).not.toHaveProperty("rejection_reason");
    expect(safeOrganization({ ...org, rejection_reason: "never-display-canary" as never })).not.toHaveProperty("rejection_reason");
  });
});

describe("form field toggles (A3)", () => {
  const field = (patch: Partial<Field>) => ({ ...newField("short_text", "note"), label: { ar: "ملاحظة", en: "Note" }, ...patch }) as Field;
  it("a new field is shown in urgent and kept from the store; required locks urgent on, and staff names, files and sensitive fields never go to the store", () => {
    expect(newField("number", "n")).toMatchObject({ show_in_urgent: true, send_to_store: false });
    expect(withToggles(field({ required: true, show_in_urgent: false }))).toMatchObject({ show_in_urgent: true });
    expect(withToggles(field({ type: "staff_member", send_to_store: true }))).toMatchObject({ send_to_store: false });
    expect(urgentLocked({ required: true })).toBe(true); expect(storeBlocked({ type: "attachment" })).toBe(true); expect(storeBlocked({ type: "number", sensitive: true })).toBe(true); expect(storeBlocked({ type: "number" })).toBe(false);
    const form = (fields: Field[]) => ({ version: 2, fields });
    expect(validForm(form([field({ show_in_urgent: false, send_to_store: true })]))).toBe(true);
    expect(validForm(form([field({ required: true, show_in_urgent: false })]))).toBe(false);
    expect(validForm(form([{ ...field({ type: "staff_member", send_to_store: true }) }]))).toBe(false);
  });
});

describe("inbox thumbnails and type chips (W1)", () => {
  it("draws the verified thumbnail the server names, nothing for a sensitive material, and filters by type on the loaded page", () => {
    const item = { ...material(1), thumbnail_file_id: randomUUID() };
    expect(rowThumb(item, false)).toEqual({ kind: "thumbnail", id: item.thumbnail_file_id }); expect(rowThumb(item, true)).toEqual({ kind: "sensitive" });
    expect(rowThumb({ ...item, thumbnail_file_id: null, material_types: ["photos"] }, false)).toEqual({ kind: "icon", photos: true });
    expect(matchesType(item, "")).toBe(true); expect(matchesType(item, "report")).toBe(true); expect(matchesType(item, "photos")).toBe(false);
  });
  it("passes thumbnail_file_id only when it names a verified thumbnail on the material, and passes valid tags", () => {
    const item = material(1), thumb = item.files.find(file => file.kind === "thumbnail")!.id, proxy = item.files.find(file => file.kind === "proxy")!.id;
    expect(safeMaterial({ ...item, thumbnail_file_id: thumb, tags: ["أ"] }, []).thumbnail_file_id).toBe(thumb);
    expect(safeMaterial({ ...item, thumbnail_file_id: proxy }, []).thumbnail_file_id).toBeNull();
    expect(safeMaterial({ ...item, thumbnail_file_id: randomUUID() }, []).thumbnail_file_id).toBeNull();
    expect(safeMaterial({ ...item, tags: ["أ"] }, []).tags).toEqual(["أ"]);
  });
});

describe("produced file on the task (W6)", () => {
  it("carries produced_file_id with «done» only, and shows it on a done task only", () => {
    const file = randomUUID();
    expect(transitionInput({ to: "done", produced_file_id: file })).toEqual({ to: "done", produced_file_id: file });
    expect(transitionInput({ to: "in_progress", produced_file_id: file })).toBeNull(); expect(transitionInput({ to: "done", produced_file_id: "x" })).toBeNull();
    expect(safeAssignment(task({ state: "done", produced_file_id: file }), true)?.produced_file_id).toBe(file);
    expect(safeAssignment(task({ state: "in_progress", produced_file_id: file }), true)).not.toHaveProperty("produced_file_id");
  });
  it("uploads an original or a produced file, never a proxy, and returns the resulting file id", () => {
    const body = { material_id: randomUUID(), kind: "produced", size_bytes: 10, filename: "edit.mp4", client_sha256: "a".repeat(64) };
    expect(uploadInput(body).kind).toBe("produced"); expect(() => uploadInput({ ...body, kind: "proxy" })).toThrow();
    const session = { id: randomUUID(), material_id: body.material_id, kind: "produced", state: "verified", size_bytes: 10, bytes_received: 10, expires_at: "2026-11-04T09:00:00Z", created_at: "2026-11-03T09:00:00Z", file_id: randomUUID(), upload_token: "never-display-canary" };
    expect(safeUploadSession(session as never).file_id).toBe(session.file_id); expect(JSON.stringify(safeUploadSession(session as never))).not.toContain("canary");
    expect(safeUploadSession({ ...session, file_id: "x" } as never).file_id).toBeNull();
  });
});

describe("desk tags (W2)", () => {
  it("replaces the whole list: up to 12 valid tags without repeats, and the empty list clears", () => {
    expect(materialTagsInput({ tags: ["أ", "ب"] })).toEqual({ tags: ["أ", "ب"] }); expect(materialTagsInput({ tags: [] })).toEqual({ tags: [] });
    expect(materialTagsInput({ tags: ["أ", "أ"] })).toBeNull(); expect(materialTagsInput({ tags: Array.from({ length: 13 }, (_, i) => `t${i}`) })).toBeNull();
    expect(materialTagsInput({ tags: [`أ${hidden.rlm}`] })).toBeNull(); expect(materialTagsInput({ tags: ["أ"], version: 2 })).toBeNull(); expect(validMaterialTags(["a".repeat(41)])).toBe(false);
  });
});

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: ["https://media.example.test"], tusOrigins: [], trustForwardedFor: false };
const as = (...names: Me["roles"][number]["name"][]): Me => ({ ...me, roles: names.map(name => ({ name, scopes: [] })) });
async function call(path: string, options: { method?: string; body?: unknown; user?: Me; headers?: Record<string, string>; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), id = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "GET";
  const headers: Record<string, string> = { Cookie: `${config.cookieName}=${id}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID(), ...options.headers };
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (input: Request) => {
    if (input.url.endsWith("/auth/me")) return Response.json(options.user ?? as("system_admin"));
    calls.push(input); return options.upstream ? options.upstream(input) : new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config, store, fetch }), calls };
}

describe("BFF for the build-gap writes", () => {
  const other = "10000000-0000-4000-8000-000000000003";
  it("reads and replaces staff roles for the administrator only; not one's own, not the administrator role, and the key is forwarded", async () => {
    expect((await call(`users/${other}/roles`, { user: as("supervisor") })).result.status).toBe(403);
    const read = await call(`users/${other}/roles`, { upstream: () => Response.json({ user_id: other, roles: [{ name: "producer", scopes: [] }], canary: "never-display-canary" }) });
    expect(read.result.status).toBe(200); expect(await read.result.json()).toEqual({ user_id: other, roles: [{ name: "producer", scopes: [] }] });
    const admin = await call(`users/${other}/roles`, { method: "PUT", body: { roles: [{ name: "system_admin", scopes: [] }] } }); expect(admin.result.status).toBe(422); expect(admin.calls).toHaveLength(0);
    const self = await call(`users/${me.user_id}/roles`, { method: "PUT", body: { roles: [{ name: "producer", scopes: [] }] } }); expect(self.result.status).toBe(403); expect(self.calls).toHaveLength(0);
    const key = randomUUID(), body = { roles: [{ name: "supervisor", scopes: [{ kind: "governorate", id: "محافظة ١" }] }] };
    const put = await call(`users/${other}/roles`, { method: "PUT", body, headers: { "Idempotency-Key": key }, upstream: async r => { expect(await r.json()).toEqual(body); return Response.json({ user_id: other, ...body }); } });
    expect(put.result.status).toBe(200); expect(put.calls[0].headers.get("Idempotency-Key")).toBe(key);
  });
  it("rejects a join request with a closed reason and If-Match, for the administrator only", async () => {
    const org = randomUUID();
    expect((await call(`buyer-organizations/${org}/rejection`, { method: "POST", user: as("finance"), body: { reason_code: "other" }, headers: { "If-Match": '"1"' } })).result.status).toBe(403);
    const bad = await call(`buyer-organizations/${org}/rejection`, { method: "POST", body: { reason_code: "مجاني" }, headers: { "If-Match": '"1"' } }); expect(bad.result.status).toBe(422); expect(bad.calls).toHaveLength(0);
    const missing = await call(`buyer-organizations/${org}/rejection`, { method: "POST", body: { reason_code: "other" } }); expect(missing.result.status).toBe(428); expect(missing.calls).toHaveLength(0);
    const rejected = { id: org, legal_name: "x", display_name: { ar: "x", en: "x" }, country: "QA", billing_email: "b@example.test", seats: 1, status: "rejected", active_members: 0, verified_at: null, rejection_reason: "other", created_at: "2026-11-03T09:00:00Z", updated_at: "2026-11-03T09:00:00Z", canary: "never-display-canary" };
    const done = await call(`buyer-organizations/${org}/rejection`, { method: "POST", body: { reason_code: "other" }, headers: { "If-Match": '"1"' }, upstream: () => Response.json(rejected, { headers: { ETag: '"2"' } }) });
    expect(done.result.status).toBe(200); expect(done.calls[0].headers.get("If-Match")).toBe('"1"'); const json = await done.result.json(); expect(json.rejection_reason).toBe("other"); expect(JSON.stringify(json)).not.toContain("canary");
    const stale = await call(`buyer-organizations/${org}/rejection`, { method: "POST", body: { reason_code: "other" }, headers: { "If-Match": '"1"' }, upstream: () => Response.json({ message: "canary" }, { status: 412 }) }); expect(stale.result.status).toBe(412);
  });
  it("replaces desk tags for the supervisor and the editor-in-chief with If-Match, returns the new row version, and passes 412 through", async () => {
    const item = material(1), path = `materials/${item.id}/tags`;
    expect((await call(path, { method: "PUT", user: as("producer"), body: { tags: [] }, headers: { "If-Match": '"17"' } })).result.status).toBe(403);
    const missing = await call(path, { method: "PUT", user: as("supervisor"), body: { tags: ["أ"] } }); expect(missing.result.status).toBe(428); expect(missing.calls).toHaveLength(0);
    const ok = await call(path, { method: "PUT", user: as("editor_in_chief"), body: { tags: ["أ"] }, headers: { "If-Match": '"17"' }, upstream: () => Response.json({ ...item, tags: ["أ"], row_version: 18, gps: { lat: 1, lng: 2 } }) });
    expect(ok.result.status).toBe(200); expect(ok.result.headers.get("ETag")).toBe('"18"'); const body = await ok.result.text(); expect(body).not.toContain("gps"); expect(JSON.parse(body).tags).toEqual(["أ"]);
    const stale = await call(path, { method: "PUT", user: as("supervisor"), body: { tags: [] }, headers: { "If-Match": '"16"' }, upstream: () => Response.json({ message: "canary" }, { status: 412 }) }); expect(stale.result.status).toBe(412);
  });
  it("issues a produced file link to production roles only when the file is a verified produced file of that material", async () => {
    const item = material(1), produced = randomUUID(), withProduced = { ...item, files: [...item.files, { id: produced, kind: "produced", state: "verified", mime_type: "video/mp4", created_at: "2026-11-03T09:00:00Z" }] };
    const link = { url: "https://media.example.test/p?sig=1", expires_at: new Date(Date.now() + 300000).toISOString() };
    const upstream = (r: Request) => r.url.endsWith("/download-url") ? Response.json(link) : Response.json(withProduced);
    const got = await call(`materials/${item.id}/files/${produced}/produced-url`, { user: as("editor_in_chief"), upstream }); expect(got.result.status).toBe(200); expect(await got.result.json()).toEqual(link);
    const reporter = await call(`materials/${item.id}/files/${produced}/produced-url`, { user: as("reporter"), upstream }); expect(reporter.result.status).toBe(403); expect(reporter.calls).toHaveLength(0);
    const proxy = item.files.find(file => file.kind === "proxy")!.id, notProduced = await call(`materials/${item.id}/files/${proxy}/produced-url`, { user: as("supervisor"), upstream });
    expect(notProduced.result.status).toBe(404); expect(notProduced.calls.every(r => !r.url.endsWith("/download-url"))).toBe(true);
  });
});
