import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { MemoryStore } from "./memory-store";
import { material, me, task, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: ["https://media.example.test"], tusOrigins: [], trustForwardedFor: false };
const key = randomUUID(), item = material(2), row = task({ material_id: item.id });
const as = (...roles: Me["roles"][number]["name"][]): Me => ({ ...me, roles: roles.map(name => ({ name, scopes: [] })) });
const supervisor = as("supervisor"), producer = as("producer"), admin = as("system_admin"), reporter = as("reporter");
const due = () => new Date(Date.now() + 1800000).toISOString();

async function call(path: string, options: { method?: string; body?: unknown; user?: Me; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), id = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "GET";
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${id}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": key }, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (input: Request) => {
    if (input.url.endsWith("/auth/me")) return Response.json(options.user ?? supervisor);
    calls.push(input); return options.upstream ? options.upstream(input) : new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config, store, fetch }), calls };
}

describe("assignment BFF (ADR 0096, ADR 0097)", () => {
  it("lists a material's tasks for task readers through the whitelist, and hides work names from those who may not see them", async () => {
    const { result, calls } = await call(`materials/${item.id}/assignments?limit=5`, { upstream: () => Response.json({ items: [{ ...row, debug: "canary" }, { ...row, state: "paused" }] }) });
    expect(result.status).toBe(200); const text = await result.text(); expect(text).not.toContain("canary"); expect(JSON.parse(text).items).toHaveLength(1);
    expect(new URL(calls[0].url).searchParams.get("limit")).toBe("5"); expect(result.headers.get("Cache-Control")).toContain("no-store");
    for (const user of [reporter, as("rights_officer")]) { const denied = await call(`materials/${item.id}/assignments`, { user }); expect(denied.result.status).toBe(403); expect(denied.calls).toHaveLength(0); }
    expect((await call(`materials/${item.id}/assignments?limit=99`)).result.status).toBe(400);
    const one = await call(`assignments/${row.id}`, { user: admin, upstream: () => Response.json(row) }); expect(one.result.status).toBe(200); expect(await one.result.json()).toEqual(row);
    const bad = await call(`assignments/${row.id}`, { upstream: () => Response.json({ ...row, note: "سطر\nثانٍ" }) }); expect(bad.result.status).toBe(502);
  });
  it("serves «my tasks» to producers only, with a validated filter, and candidates to assigners only", async () => {
    const page = { items: [row], next_cursor: null, summary: { active: 1, overdue: 0, done_last_7_days: 2 } };
    const mine = await call("me/assignments?status=closed&limit=20", { user: producer, upstream: r => { expect(new URL(r.url).searchParams.get("status")).toBe("closed"); return Response.json(page); } });
    expect(mine.result.status).toBe(200); expect(await mine.result.json()).toEqual(page);
    for (const query of ["status=open", "status=active&status=closed", "limit=0", "extra=1"]) expect((await call(`me/assignments?${query}`, { user: producer })).result.status).toBe(400);
    expect((await call("me/assignments", { user: supervisor })).result.status).toBe(403);
    const candidates = await call("assignment-candidates", { upstream: () => Response.json({ items: [{ user_id: row.assignee_id, work_name: "مونتير", open_count: 0, urgent_open_count: 0, overdue_count: 0, email: "canary@example.test" }] }) });
    expect(candidates.result.status).toBe(200); expect(await candidates.result.text()).not.toContain("canary");
    for (const user of [producer, admin]) expect((await call("assignment-candidates", { user })).result.status).toBe(403);
  });
  it("forwards the browser key with a rebuilt body, refuses bad bodies before the server, and passes the assignment codes with machine details", async () => {
    const body = { assignee_id: row.assignee_id, due_at: due(), note: "ملاحظة" };
    const { result, calls } = await call(`materials/${item.id}/assignments`, { method: "POST", body, upstream: async r => { expect(await r.json()).toEqual(body); return Response.json(row, { status: 201 }); } });
    expect(result.status).toBe(201); expect(calls[0].headers.get("Idempotency-Key")).toBe(key); expect(calls[0].headers.get("If-Match")).toBeNull();
    for (const bad of [{ ...body, due_at: "2020-01-01T00:00:00Z" }, { ...body, note: "سطر\nثانٍ" }, { ...body, priority: "urgent" }]) { const r = await call(`materials/${item.id}/assignments`, { method: "POST", body: bad }); expect(r.result.status).toBe(422); expect(r.calls).toHaveLength(0); }
    expect((await call(`materials/${item.id}/assignments`, { method: "POST", body, user: producer })).result.status).toBe(403);
    const open = await call(`materials/${item.id}/assignments`, { method: "POST", body, upstream: () => Response.json({ code: "assignment_open", message: "canary", details: { assignment_id: row.id, canary: 1 } }, { status: 409 }) });
    expect(open.result.status).toBe(409); expect(await open.result.json()).toEqual({ code: "assignment_open", details: { assignment_id: row.id } });
    const notAllowed = await call(`materials/${item.id}/assignments`, { method: "POST", body, upstream: () => Response.json({ code: "assignment_not_allowed", details: { failed: ["editorial_state"] } }, { status: 409 }) });
    expect(await notAllowed.result.json()).toEqual({ code: "assignment_not_allowed", details: { failed: ["editorial_state"] } });
    const eligible = await call(`materials/${item.id}/assignments`, { method: "POST", body, upstream: () => Response.json({ code: "assignee_not_eligible", message: "canary" }, { status: 422 }) });
    expect(eligible.result.status).toBe(422); expect(await eligible.result.json()).toEqual({ code: "assignee_not_eligible" });
  });
  it("moves a task with a rebuilt body, the note only with returned", async () => {
    const moved = await call(`assignments/${row.id}/transitions`, { method: "POST", user: producer, body: { to: "returned", note: "سبب" }, upstream: async r => { expect(await r.json()).toEqual({ to: "returned", note: "سبب" }); return Response.json({ ...row, state: "returned", returned_by: row.assignee_id, return_note: "سبب", closed_at: "2026-11-03T14:40:00Z" }); } });
    expect(moved.result.status).toBe(200); expect((await moved.result.json()).state).toBe("returned");
    expect((await call(`assignments/${row.id}/transitions`, { method: "POST", user: producer, body: { to: "done", note: "سبب" } })).result.status).toBe(422);
    expect((await call(`assignments/${row.id}/transitions`, { method: "POST", user: admin, body: { to: "done" } })).result.status).toBe(403);
    const stale = await call(`assignments/${row.id}/transitions`, { method: "POST", user: producer, body: { to: "done" }, upstream: () => Response.json({ code: "invalid_transition", details: { from: "done", to: "done", canary: 1 } }, { status: 409 }) });
    expect(await stale.result.json()).toEqual({ code: "invalid_transition", details: { from: "done", to: "done" } });
  });
  it("requests and links the export package for the roles that may download the original, from a configured origin only", async () => {
    const state = { state: "ready", source_file_id: randomUUID(), file_id: randomUUID(), requested_by: me.user_id, requested_at: "2026-11-03T14:30:00Z", failure_reason: null };
    const read = await call(`materials/${item.id}/export`, { user: producer, upstream: () => Response.json(state) }); expect(read.result.status).toBe(200); expect(await read.result.json()).not.toHaveProperty("requested_by");
    expect((await call(`materials/${item.id}/export`, { user: supervisor })).result.status).toBe(403);
    const requested = await call(`materials/${item.id}/export`, { method: "POST", user: producer, upstream: () => Response.json({ ...state, state: "requested", file_id: null }, { status: 202 }) });
    expect(requested.result.status).toBe(202); expect(requested.calls[0].headers.get("Idempotency-Key")).toBe(key);
    expect((await call(`materials/${item.id}/export`, { method: "POST", user: producer, body: { source_file_id: state.source_file_id } })).result.status).toBe(422);
    const expires = new Date(Date.now() + 300000).toISOString();
    const link = await call(`materials/${item.id}/export/download-url`, { user: producer, upstream: () => Response.json({ url: "https://media.example.test/export/x?sig=1", expires_at: expires }) });
    expect(link.result.status).toBe(200); expect(await link.result.json()).toEqual({ url: "https://media.example.test/export/x?sig=1", expires_at: expires });
    expect((await call(`materials/${item.id}/export/download-url`, { user: producer, upstream: () => Response.json({ url: "https://elsewhere.example.test/x", expires_at: expires }) })).result.status).toBe(503);
    const early = await call(`materials/${item.id}/export/download-url`, { user: producer, upstream: () => Response.json({ code: "export_not_ready" }, { status: 409 }) });
    expect(early.result.status).toBe(409); expect(await early.result.json()).toEqual({ code: "export_not_ready" });
  });
});
