import test from "node:test";
import assert from "node:assert/strict";
import { checkUploadContract, responseValidator } from "../scripts/upload-contract.mjs";
import { checkOutbox } from "../scripts/outbox-transaction.mjs";
import { checkStateIndependence } from "../scripts/material-state-independence.mjs";
import { checkSensitiveVisibility } from "../scripts/sensitive-material-visibility.mjs";
import { validateMeasurement, newResult, finish } from "../lib/measurement.mjs";

const objectResponse = { content: { "application/json": { schema: { type: "object" } } } };
const contract = { components: {}, paths: {
  "/materials": { post: { responses: { 201: objectResponse } } },
  "/uploads": { post: { responses: { 201: objectResponse } }, get: { responses: { 200: objectResponse } } },
  "/uploads/{id}": { get: { responses: { 200: objectResponse } } },
} };

function mockHttp(handlers) {
  const calls = [];
  const call = async (token, method, path, options = {}) => {
    calls.push({ token, method, path, options });
    const handler = handlers[`${method} ${path.split("?")[0]}`] ?? handlers[`${method} *`];
    if (!handler) throw new Error(`no mock for ${method} ${path}`);
    return typeof handler === "function" ? await handler(options.body, options) : handler;
  };
  return { calls, call, get: (token, path) => call(token, "GET", path) };
}

const material = (id = "material-1") => ({ id, technical_state: "pending", editorial_state: "inbox", rights_state: "unknown", sensitivity: { graphic: false } });

function uploadMock({ duplicate = false } = {}) {
  const session = { id: "session-1", material_id: "material-1" };
  return mockHttp({
    "GET /forms/current": { status: 200, body: { version: 1 } },
    "POST /materials": { status: 201, body: material() },
    "POST /uploads": (body) => body.client_sha256 ? { status: 201, body: session } : { status: 422, body: {} },
    "GET /uploads": { status: 200, body: { items: duplicate ? [session, session] : [session] } },
    "GET /uploads/session-1": { status: 200, body: session },
  });
}

test("upload-contract proves replay keeps one session and rejects a missing client digest", async () => {
  const http = uploadMock();
  const out = await checkUploadContract({ http, token: "reporter-token", api: contract });
  assert.deepEqual(out.fails, []);
  assert.equal(out.metrics.duplicate_session_count, 1);
  assert.equal(out.metrics.replay_same_resource, true);
  const writes = http.calls.filter((c) => c.method === "POST" && c.path === "/uploads");
  assert.equal(writes.length, 3);
  assert.equal(writes[1].options.key, writes[2].options.key);
});

test("upload-contract catches a second resource returned by the list", async () => {
  const out = await checkUploadContract({ http: uploadMock({ duplicate: true }), token: "t", api: contract });
  assert.ok(out.fails.some((f) => f.includes("no second session")));
});

test("responseValidator reports body drift and a missing operation schema", () => {
  const validate = responseValidator(contract);
  assert.deepEqual(validate("/uploads/{id}", "get", 200, {}), []);
  assert.ok(validate("/uploads/{id}", "get", 200, null).length > 0);
  assert.ok(validate("/uploads/{id}", "get", 201, {}).some((e) => e.includes("no JSON schema")));
});

function outboxMock({ omitEvent = false } = {}) {
  const events = { material: [], upload: [] };
  const db = { query: async (sql, params) => {
    if (sql.includes("FROM outbox_events WHERE aggregate_type")) {
      const rows = events[params[0]].filter((e) => e.aggregate_id === params[1]);
      return { rows: omitEvent ? [] : rows };
    }
    throw new Error(`unexpected query: ${sql}`);
  } };
  const m = material();
  const http = mockHttp({
    "GET /forms/current": { status: 200, body: { version: 1 } },
    "POST /materials": () => {
      if (!events.material.some((e) => e.aggregate_id === m.id && e.type === "material.created")) events.material.push({ aggregate_id: m.id, type: "material.created" });
      return { status: 201, body: m };
    },
    "POST /uploads": () => {
      if (!events.upload.some((e) => e.aggregate_id === "session-1")) events.upload.push({ aggregate_id: "session-1", type: "upload.started" });
      return { status: 201, body: { id: "session-1" } };
    },
    "POST /materials/material-1/transitions": () => {
      if (!events.material.some((e) => e.type === "material.editorial_transition")) events.material.push({ aggregate_id: m.id, type: "material.editorial_transition" });
      return { status: 200, body: { ...m, editorial_state: "acknowledged" } };
    },
  });
  return { db, http };
}

test("outbox-transaction checks three writes and stays partial without fault injection", async () => {
  const { db, http } = outboxMock();
  const out = await checkOutbox({ db, http, tokens: { reporter: "r", supervisor: "s" } });
  assert.deepEqual(out.fails, []);
  assert.equal(out.metrics.writes_checked, 3);
  assert.equal(out.metrics.atomicity_checked, false);
  assert.equal(out.metrics.replay_duplicate_events, 0);
  const doc = finish(newResult("outbox-transaction"), out.fails.length ? "fail" : "partial", out.metrics);
  assert.ok(validateMeasurement(doc).ok);
});

test("outbox-transaction fails when a committed write has no event", async () => {
  const { db, http } = outboxMock({ omitEvent: true });
  const out = await checkOutbox({ db, http, tokens: { reporter: "r", supervisor: "s" } });
  assert.ok(out.fails.some((f) => f.includes("material.created persisted once")));
});

function stateMock() {
  let current = material();
  return mockHttp({
    "GET /forms/current": { status: 200, body: { version: 1 } },
    "POST /materials": { status: 201, body: current },
    "POST /materials/material-1/transitions": (body) => {
      current = { ...current, [`${body.track}_state`]: body.to };
      return { status: 200, body: current };
    },
    "GET /materials/material-1": () => ({ status: 200, body: current }),
    "GET /materials/material-1/transitions": { status: 200, body: { items: [
      { track: "editorial", to: "acknowledged" }, { track: "rights", to: "documented" },
    ] } },
  });
}

test("material-state-independence requires two separate tracks and an unchanged technical state", async () => {
  const out = await checkStateIndependence({ http: stateMock(), tokens: { reporter: "r", supervisor: "s", rights_officer: "o" } });
  assert.deepEqual(out.fails, []);
  assert.equal(out.metrics.technical_state_unchanged, true);
  assert.equal(out.metrics.editorial_state, "acknowledged");
  assert.equal(out.metrics.rights_state, "documented");
});

function sensitiveMock({ leak = false } = {}) {
  const m = { ...material(), sensitivity: { graphic: true } };
  return mockHttp({
    "GET /forms/current": { status: 200, body: { version: 1 } },
    "POST /materials": { status: 201, body: m },
    "GET /materials": { status: 200, body: { items: leak ? [m] : [] } },
    "GET /catalog": { status: 200, body: { items: [] } },
    "GET /dashboard/newsroom": { status: 200, body: { items: [] } },
    "GET /materials/material-1/export": { status: 403, body: {} },
    "GET /materials/material-1/export/download-url": { status: 404, body: {} },
    "POST /materials/material-1/export": { status: 403, body: {} },
  });
}

test("sensitive-material-visibility accepts hidden lists and rejected exports", async () => {
  const out = await checkSensitiveVisibility({ http: sensitiveMock(), tokens: { reporter: "r", producer: "p" } });
  assert.deepEqual(out.fails, []);
  assert.equal(out.metrics.sensitive_id_occurrences, 0);
});

test("sensitive-material-visibility catches a material id in any checked list", async () => {
  const out = await checkSensitiveVisibility({ http: sensitiveMock({ leak: true }), tokens: { reporter: "r", producer: "p" } });
  assert.equal(out.metrics.sensitive_id_occurrences, 2);
  assert.ok(out.fails.some((f) => f.includes("hides sensitive material")));
});
