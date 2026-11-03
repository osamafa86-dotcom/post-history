import test from "node:test";
import assert from "node:assert/strict";
import { checkUploadContract, responseValidator } from "../scripts/upload-contract.mjs";
import { checkOutbox, assertOutboxFaultTarget, assertSyntheticOutboxDatabase, injectMaterialOutboxFailure } from "../scripts/outbox-transaction.mjs";
import { checkStateIndependence } from "../scripts/material-state-independence.mjs";
import { checkSensitiveVisibility } from "../scripts/sensitive-material-visibility.mjs";
import { validateMeasurement, newResult, finish, ROOT } from "../lib/measurement.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

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

/**
 * The catalog with the sale gate of ADR 0118: `listed` answers 409 listing_conditions_unmet until the database holds the published version
 * and the verified original (the mock database records them), as the server's assertListable does. `gate: false` is a server that lists on
 * rights alone; `seeds: false` a database write that does not reach the material.
 */
function sensitiveMock({ leak = false, catalogStatus = 200, gate = true, seeds = true, tell404 = false, stray404Id = false } = {}) {
  // the server's 404: the contract's Error with a fresh request_id per response, the same value as the x-request-id header
  let requests = 0;
  const missing = (message = "Not found.") => () => {
    const id = `00000000-0000-4000-8000-${String(++requests).padStart(12, "0")}`;
    return { status: 404, body: { code: "not_found", message, request_id: id }, headers: { "x-request-id": stray404Id ? "other" : id } };
  };
  const notFound = missing();
  const item = (id) => ({ listing_id: id });
  const approved = new Set(), verified = new Set(), listed = new Set();
  const db = {
    queries: [],
    async query(text, params) {
      db.queries.push({ text, params });
      if (seeds && /UPDATE materials SET editorial_state = 'published', technical_state = 'verified'/.test(text)) approved.add(params[0]);
      if (seeds && /INSERT INTO material_files/.test(text) && /'original', 'verified'/.test(text)) verified.add(params[0]);
      return { rows: [] };
    },
  };
  const read = (id) => () => ({ status: 200, body: { ...material(id), rights_state: "sellable", ...(approved.has(id) ? { editorial_state: "published", technical_state: "verified" } : {}) } });
  const listing = (id, listingId) => () => {
    const failed = [...(approved.has(id) ? [] : ["editorial_state"]), ...(approved.has(id) && verified.has(id) ? [] : ["technical_state"])];
    if (listed.has(id)) return { status: 409, body: { code: "listing_exists" } };
    if (gate && failed.length) return { status: 409, body: { code: "listing_conditions_unmet", message: "A listed material needs editorial approval of its version and a verified original.", details: { failed } } };
    listed.add(id);
    return { status: 201, body: { id: listingId, material_id: id, state: "listed" } };
  };
  const http = mockHttp({
    "GET /auth/me": { status: 200, body: { user_id: "buyer-1", organization_id: "org-1" } },
    "GET /buyer-organizations/org-1": { status: 200, body: { id: "org-1", status: "active" } },
    "GET /forms/current": { status: 200, body: { version: 1 } },
    "POST /materials": (body) => ({ status: 201, body: material(body.title.endsWith("control") ? "control-1" : "sensitive-1") }),
    "POST /materials/control-1/transitions": { status: 200, body: material("control-1") },
    "POST /materials/sensitive-1/transitions": { status: 200, body: material("sensitive-1") },
    "POST /license-templates": { status: 201, body: { id: "licence-1" } },
    "GET /materials/control-1": read("control-1"),
    "GET /materials/sensitive-1": read("sensitive-1"),
    "POST /materials/control-1/listing": listing("control-1", "listing-control"),
    "POST /materials/sensitive-1/listing": listing("sensitive-1", "listing-sensitive"),
    "PATCH /materials/sensitive-1": { status: 200, body: { ...material("sensitive-1"), sensitivity: { graphic: true } } },
    "GET /materials/sensitive-1/listing": { status: 200, body: { state: "suspended", suspended_reason: "sensitive_flagged" } },
    "GET /catalog": { status: catalogStatus, body: { items: leak ? [item("listing-control"), item("listing-sensitive")] : [item("listing-control")] } },
    "GET /catalog/listing-control": { status: 200, body: item("listing-control") },
    "GET /catalog/listing-sensitive": leak ? { status: 200, body: item("listing-sensitive") } : tell404 ? missing("Listing suspended.") : notFound,
    "GET *": notFound,
  });
  return { http, db };
}

const sensitiveTokens = { reporter: "r", rights_officer: "o", system_admin: "a", buyer_admin: "b" };

test("sensitive-material-visibility proves buyer exclusion with a visible offered control", async () => {
  const out = await checkSensitiveVisibility({ ...sensitiveMock(), tokens: sensitiveTokens });
  assert.deepEqual(out.fails, []);
  assert.equal(out.metrics.positive_control_visible, true);
  assert.equal(out.metrics.sensitive_id_occurrences, 0);
  assert.equal(out.metrics.catalog_checks, 4);
  assert.equal(out.metrics.listing_gate_refused_unmet, true);
});

test("sensitive-material-visibility lists through the sale gate: refused on rights alone, then listed once both materials meet the three conditions", async () => {
  const { http, db } = sensitiveMock();
  const out = await checkSensitiveVisibility({ http, db, tokens: sensitiveTokens });
  assert.deepEqual(out.fails, []);
  const listings = http.calls.filter((c) => c.method === "POST" && c.path.endsWith("/listing")).map((c) => c.path);
  assert.deepEqual(listings, ["/materials/control-1/listing", "/materials/control-1/listing", "/materials/sensitive-1/listing"]);
  for (const id of ["control-1", "sensitive-1"]) {
    assert.ok(db.queries.some((q) => q.text.startsWith("UPDATE materials") && q.params[0] === id), `${id} approved and verified`);
    assert.ok(db.queries.some((q) => q.text.startsWith("INSERT INTO material_files") && q.params[0] === id), `${id} has a verified original`);
  }
  // rights stay with the API transitions: documented then sellable for each material, and no SQL touches rights_state
  assert.equal(http.calls.filter((c) => c.method === "POST" && c.path.endsWith("/transitions")).length, 4);
  assert.ok(db.queries.every((q) => !/rights_state/.test(q.text)));
  const firstSeed = http.calls.findIndex((c) => c.path === "/materials/control-1"), firstListing = http.calls.findIndex((c) => c.path === "/materials/control-1/listing");
  assert.ok(firstListing < firstSeed, "the refused attempt comes before the conditions are met");
});

test("sensitive-material-visibility measures nothing without the database for the sale conditions", async () => {
  const { http } = sensitiveMock();
  const out = await checkSensitiveVisibility({ http, tokens: sensitiveTokens });
  assert.ok(out.fails.some((f) => f.includes("sale-condition database")));
  assert.equal(out.metrics.catalog_checks, 0);
  assert.equal(http.calls.length, 0);
});

test("sensitive-material-visibility fails a server that lists on rights alone", async () => {
  const out = await checkSensitiveVisibility({ ...sensitiveMock({ gate: false }), tokens: sensitiveTokens });
  assert.equal(out.metrics.listing_gate_refused_unmet, false);
  assert.ok(out.fails.some((f) => f.includes("listing with sellable rights alone is refused")));
  assert.ok(out.fails.some((f) => f.includes("refusal names the unmet sale conditions")));
});

test("sensitive-material-visibility fails when the seeded conditions do not reach the material", async () => {
  const out = await checkSensitiveVisibility({ ...sensitiveMock({ seeds: false }), tokens: sensitiveTokens });
  assert.ok(out.fails.some((f) => f.includes("control meets the three sale conditions")));
  assert.ok(out.fails.some((f) => f.includes("control listed with an offer")));
  assert.ok(out.fails.some((f) => f.includes("minimum real catalog checks")));
});

test("sensitive-material-visibility sets aside only the 404's correlation id: another message fails, and so does a request_id that is not the header", async () => {
  const told = await checkSensitiveVisibility({ ...sensitiveMock({ tell404: true }), tokens: sensitiveTokens });
  assert.ok(told.fails.some((f) => f.includes("missing-listing shape")));
  const stray = await checkSensitiveVisibility({ ...sensitiveMock({ stray404Id: true }), tokens: sensitiveTokens });
  assert.deepEqual(stray.fails.map((f) => f.split(":")[0]), ["404 request_id is only the response's correlation id"]);
});

test("sensitive-material-visibility catches a leak in search or direct read", async () => {
  const out = await checkSensitiveVisibility({ ...sensitiveMock({ leak: true }), tokens: sensitiveTokens });
  assert.equal(out.metrics.sensitive_id_occurrences, 1);
  assert.ok(out.fails.some((f) => f.includes("absent from the same search")));
  assert.ok(out.fails.some((f) => f.includes("direct read is not found")));
});

test("sensitive-material-visibility never turns an absent catalog route into a pass", async () => {
  const out = await checkSensitiveVisibility({ ...sensitiveMock({ catalogStatus: 404 }), tokens: sensitiveTokens });
  assert.ok(out.fails.some((f) => f.includes("buyer catalog search")));
  assert.ok(out.fails.some((f) => f.includes("offered control appears")));
});

test("sensitive-material-visibility by name: an environment without the database measures nothing, and the connection closes after a run", async () => {
  const env = { SENSITIVE_API_URL: "http://127.0.0.1:9/v1", SENSITIVE_TOKENS: JSON.stringify(sensitiveTokens) };
  const { run } = await import("../scripts/sensitive-material-visibility.mjs");
  const missing = await run(["--dry-run"], env);
  assert.equal(missing.code, 2); assert.equal(missing.doc, null);
  const { http, db } = sensitiveMock();
  let ended = 0;
  const done = await run(["--dry-run"], { ...env, SENSITIVE_DATABASE_URL: "postgres://127.0.0.1:9/acceptance_tmp" }, { http, connectDb: async () => ({ query: db.query.bind(db), end: async () => { ended++; } }) });
  assert.equal(done.code, 0); assert.equal(done.doc.result, "pass"); assert.equal(ended, 1);
});

test("outbox fault target refuses non-local hosts and non-temporary databases before connection", () => {
  assert.throws(() => assertOutboxFaultTarget("postgres://db.example.invalid/postgres"), /REFUSED/);
  assert.throws(() => assertOutboxFaultTarget("postgres://127.0.0.1/postgres"), /temporary\/test/);
  assert.deepEqual(assertOutboxFaultTarget("postgres://db/acceptance_tmp", "db"), { host: "db", database: "acceptance_tmp" });
  assert.throws(() => assertOutboxFaultTarget("postgres://other/acceptance_tmp", "db"), /REFUSED/);
});

test("outbox content guard refuses real users before creating any database object", async () => {
  const queries = [];
  const db = { query: async (sql) => { queries.push(sql); return { rows: [{ count: 1 }] }; } };
  await assert.rejects(() => assertSyntheticOutboxDatabase(db), /synthetic test users only/);
  assert.equal(queries.length, 1);
  assert.ok(!queries.some((q) => q.includes("CREATE")));
});

test("outbox fault injection drops trigger and function when the API call fails", async () => {
  const queries = [];
  const db = { query: async (sql) => {
    queries.push(sql);
    if (sql.includes("FROM users")) return { rows: [{ count: 0 }] };
    if (sql.includes("count(*)")) return { rows: [{ count: 0 }] };
    return { rows: [] };
  } };
  const http = mockHttp({
    "GET /auth/me": { status: 200, body: { user_id: "00000000-0000-4000-8000-000000000001" } },
    "POST /materials": () => { throw new Error("injected transport failure"); },
  });
  await assert.rejects(() => injectMaterialOutboxFailure({ db, http, token: "r", formVersion: 1 }), /transport failure/);
  assert.ok(queries.some((q) => q.startsWith("DROP TRIGGER IF EXISTS acceptance_outbox_fault_")));
  assert.ok(queries.some((q) => q.startsWith("DROP FUNCTION IF EXISTS public.acceptance_outbox_fault_")));
});

test("responseValidator applies the repository Material schema to an incomplete body", () => {
  const api = YAML.parse(readFileSync(join(ROOT, "contracts/openapi.yaml"), "utf8"));
  api.paths = { "/probe": { get: { responses: { 200: { content: { "application/json": { schema: { $ref: "#/components/schemas/Material" } } } } } } } };
  const errors = responseValidator(api)("/probe", "get", 200, {});
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => e.includes("required")));
});
