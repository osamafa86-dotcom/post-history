import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run as reservation } from "../scripts/reservation-conflict.mjs";
import { run as occ } from "../scripts/optimistic-concurrency.mjs";
import { run as quorum } from "../scripts/admin-quorum.mjs";
import { run as delivery, allowedPayloadKeys } from "../scripts/notification-delivery.mjs";
import { run as downloadUrl, inspectLink } from "../scripts/download-url.mjs";
import { validateMeasurement } from "../lib/measurement.mjs";
import { EXIT_PENDING } from "../lib/pending.mjs";

const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const json = (status, body, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json", ...headers } });
const ON = { CORE_ACCEPTANCE: "1" };
const TOKENS = Object.fromEntries(["reporter", "supervisor", "supervisor_b", "producer", "producer_b", "editor_in_chief", "system_admin", "victim"].map((r) => [r, r]));

/** A small in-memory API: just the routes the core-gate scripts call. Token = user id. `bug` switches on one defect. */
function fakeApi({ bug = null } = {}) {
  const mats = new Map(), inbox = new Map(), events = [], keys = new Map(), status = new Map();
  const notify = (to, n) => { inbox.set(to, [...(inbox.get(to) ?? []), { id: randomUUID(), state: "delivered", priority: "normal", created_at: "2026-10-20T00:00:00Z", ...n }]); };
  const view = (m) => ({ ...m });
  const etag = (m) => ({ etag: `"${m.row_version}"` });
  return async (url, init) => {
    const u = new URL(url), path = u.pathname.replace(/^\/v1/, ""), method = init.method, h = init.headers;
    const token = (h.authorization ?? "").replace("Bearer ", "") || null;
    const body = init.body ? JSON.parse(init.body) : {};
    if (!token) return json(401, { code: "unauthorized" });
    if (status.get(token) === "suspended") return json(401, { code: "unauthorized" });
    let r;
    if (path === "/forms/current") return json(200, { version: 1 });
    if (path === "/auth/me") return json(200, { id: token });
    if (method === "POST" && path === "/materials") {
      const m = { id: randomUUID(), title: body.title, editorial_state: "inbox", reserved_by: null, row_version: 1 };
      mats.set(m.id, m);
      notify("supervisor", { type: "material.created", material_id: m.id, title: bug === "leak" ? `مادة ${body.gps.lat}` : "مادة واردة #1" });
      if (bug === "stray") notify("supervisor_b", { type: "material.created", material_id: m.id, title: "x" });
      events.push({ type: "material.created", payload: { material_id: m.id, priority: "normal", ...(bug === "payload" ? { title: body.title } : {}) } });
      return json(201, view(m), etag(m));
    }
    if ((r = path.match(/^\/materials\/([^/]+)(\/\w+)?$/))) {
      const m = mats.get(r[1]);
      if (!m) return json(404, { code: "not_found" });
      const ifm = h["if-match"];
      if (method === "GET" && !r[2]) return json(200, view(m), etag(m));
      if (method !== "GET" && ifm && bug !== "ignore-if-match" && ifm !== `"${m.row_version}"`) return json(412, { code: "precondition_failed" });
      if (method === "PATCH") { m.title = body.title; m.row_version++; return json(200, view(m), etag(m)); }
      if (r[2] === "/transitions") { m.editorial_state = body.to; m.row_version++; return json(200, view(m), etag(m)); }
      if (r[2] === "/reservation" && method === "POST") {
        const k = h["idempotency-key"];
        if (keys.has(k)) return json(200, keys.get(k));
        await new Promise((x) => setImmediate(x));
        if (m.reserved_by && m.reserved_by !== token && bug !== "double-reserve") return json(409, { code: "already_reserved" });
        m.reserved_by = token; m.editorial_state = "in_production";
        const res = { material_id: m.id, reserved_by: token, reserved_at: "x", releases_at: "y" };
        keys.set(k, res); events.push({ type: "material.reserved", payload: { material_id: m.id, priority: "normal", reserved_by: token } });
        return json(200, res);
      }
    }
    if (path === "/events") return json(200, { items: events.filter((e) => e.type === u.searchParams.get("type")), next_after: null });
    if (path === "/notifications") return json(200, { items: inbox.get(token) ?? [], next_cursor: null, unread_count: 0 });
    if ((r = path.match(/^\/notifications\/([^/]+)\/ack$/))) {
      const n = (inbox.get(token) ?? []).find((x) => x.id === r[1]);
      if (!n) return json(404, {});
      const m = mats.get(n.material_id); m.editorial_state = "acknowledged";
      notify("reporter", { type: "material.acknowledged", material_id: m.id, title: "شوهدت" });
      events.push({ type: "material.acknowledged", payload: { material_id: m.id, priority: "normal" } });
      return json(204);
    }
    if ((r = path.match(/^\/users\/([^/]+)\/status$/))) {
      const target = r[1];
      if (token !== "system_admin") return json(403, { code: "forbidden" });
      if (target === "system_admin" || target === "system_admin_b") return json(403, { code: "admin_quorum_required" });
      status.set(target, body.status); return json(204);
    }
    return json(404, { code: "not_found" });
  };
}
const setEnv = (extra) => ({ ...ON, ...extra });

test("core-gate scripts are pending without the flag and write nothing", async () => {
  for (const f of [reservation, occ, quorum, delivery, downloadUrl]) assert.equal((await quiet(() => f(["--dry-run"], {}))).code, EXIT_PENDING);
});

test("reservation-conflict: one winner per round passes; two winners fail", async () => {
  const env = setEnv({ RESERVE_API_URL: "http://x/v1", RESERVE_TOKENS: JSON.stringify(TOKENS) });
  const ok = await quiet(() => reservation(["--dry-run"], env, { fetchImpl: fakeApi() }));
  assert.equal(ok.code, 0); assert.equal(ok.doc.result, "pass"); assert.ok(validateMeasurement(ok.doc).ok);
  const few = await quiet(() => reservation(["--dry-run"], { ...env, RESERVE_ROUNDS: "5" }, { fetchImpl: fakeApi() }));
  assert.equal(few.doc.result, "partial");
  const bad = await quiet(() => reservation(["--dry-run"], env, { fetchImpl: fakeApi({ bug: "double-reserve" }) }));
  assert.equal(bad.code, 1); assert.equal(bad.doc.result, "fail");
});

test("optimistic-concurrency: one 200 and one 412 per round passes; ignoring If-Match fails", async () => {
  const env = setEnv({ OCC_API_URL: "http://x/v1", OCC_TOKENS: JSON.stringify(TOKENS) });
  const ok = await quiet(() => occ(["--dry-run"], env, { fetchImpl: fakeApi() }));
  assert.equal(ok.code, 0); assert.equal(ok.doc.result, "pass"); assert.ok(validateMeasurement(ok.doc).ok);
  const bad = await quiet(() => occ(["--dry-run"], env, { fetchImpl: fakeApi({ bug: "ignore-if-match" }) }));
  assert.equal(bad.code, 1);
});

test("admin-quorum: the API half is partial alone, pass with the command line, and a refused-then-accepted CLI is judged by exit codes", async () => {
  const base = { QUORUM_API_URL: "http://x/v1", QUORUM_TOKENS: JSON.stringify(TOKENS), QUORUM_USERS: JSON.stringify({ system_admin_id: "system_admin", system_admin_b_id: "system_admin_b", victim_id: "victim" }) };
  const alone = await quiet(() => quorum(["--dry-run"], setEnv(base), { fetchImpl: fakeApi() }));
  assert.equal(alone.code, 0); assert.equal(alone.doc.result, "partial"); assert.equal(alone.doc.metrics.cli_checked, false);
  const withCli = await quiet(() => quorum(["--dry-run"], setEnv({ ...base, QUORUM_CLI_ONE: "exit 3", QUORUM_CLI_GUARD: "exit 4", QUORUM_CLI_TWO: "test -n \"$TARGET_ID\"" }), { fetchImpl: fakeApi() }));
  assert.equal(withCli.doc.result, "pass");
  const lax = await quiet(() => quorum(["--dry-run"], setEnv({ ...base, QUORUM_CLI_ONE: "true", QUORUM_CLI_GUARD: "exit 4", QUORUM_CLI_TWO: "true" }), { fetchImpl: fakeApi() }));
  assert.equal(lax.code, 1, "a single approver accepted by the command line is a failure");
});

test("notification-delivery: right recipients and keys pass (partial below 20 runs); a stray recipient, a leaked coordinate or an off-list payload key fail", async () => {
  const env = setEnv({ NOTIF_API_URL: "http://x/v1", NOTIF_TOKENS: JSON.stringify(TOKENS), NOTIF_RUNS: "3" });
  const ok = await quiet(() => delivery(["--dry-run"], env, { fetchImpl: fakeApi() }));
  assert.equal(ok.code, 0); assert.equal(ok.doc.result, "partial"); assert.equal(ok.doc.metrics.reporter_told, 3); assert.ok(validateMeasurement(ok.doc).ok);
  for (const bug of ["stray", "leak", "payload"]) assert.equal((await quiet(() => delivery(["--dry-run"], env, { fetchImpl: fakeApi({ bug }) }))).code, 1, bug);
  assert.deepEqual(allowedPayloadKeys("material.reserved").includes("reserved_by"), true);
  assert.equal(allowedPayloadKeys("not.a.type"), null);
});

test("download-url: links carry ids only and signature parameters", () => {
  const ok = "https://s3.example/derived/1b9e1f4e-2c3d-4e5f-8a7b-9c0d1e2f3a4b/2b9e1f4e-2c3d-4e5f-8a7b-9c0d1e2f3a4b/proxy-480p.mp4?X-Amz-Expires=600&X-Amz-Signature=abc";
  assert.deepEqual(inspectLink(ok, { filenameStems: ["dl-1234"] }), []);
  assert.ok(inspectLink("https://s3.example/derived/dl-1234-clip.mov?X-Amz-Signature=a", { filenameStems: ["dl-1234"] }).length);
  assert.ok(inspectLink(`${ok}&filename=clip`).length, "an unexpected query parameter is flagged");
});
