import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { run, totpCode, wrongCode } from "../scripts/invite-conflict-totp.mjs";
import { byName } from "../lib/catalog.mjs";
import { validateMeasurement } from "../lib/measurement.mjs";

const quiet = async (fn) => { const l = console.log, e = console.error; console.log = console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };

const SECRET_HEX = Buffer.from("12345678901234567890").toString("hex"); // سر RFC 6238 القياسي
const EXISTING = "existing@example.test";
const ADMIN = "aaaaaaaa-1111-4111-8111-111111111111";

/** خادم وهمي يقلّد طابور التعارضات: الدعوة المتعارضة تُردّ كالناجحة، والحسم يتحقق من TOTP ويمنع إعادته ويحدّ المحاولات. */
function fakeStack({ limit = 10, never429 = false } = {}) {
  const state = { conflicts: [], seq: 0, failures: 0, usedCodes: new Set() };
  const json = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const url = new URL(req.url, "http://x");
    const token = req.headers.authorization;
    if (req.method === "GET" && url.pathname === "/v1/auth/me") {
      if (token === "Bearer rep") return json(res, 200, { user_id: "rep", email: EXISTING, organization_id: null });
      return json(res, 200, { user_id: ADMIN, email: "admin@example.test", totp_enabled: true });
    }
    if (req.method === "POST" && url.pathname === "/v1/buyer-organizations") {
      const id = `org-${++state.seq}`;
      return json(res, 201, { id, legal_name: body.legal_name, display_name: body.display_name, country: body.country, billing_email: body.billing_email, seats: body.seats }, { etag: '"1"' });
    }
    if (req.method === "PUT" && url.pathname.startsWith("/v1/buyer-organizations/")) return json(res, 200, { status: "active" });
    if (req.method === "POST" && url.pathname.endsWith("/members")) {
      const orgId = url.pathname.split("/")[3];
      const c = { id: `conflict-${state.seq}-${state.conflicts.length}`, organization_id: orgId, email: body.email, state: "pending" };
      state.conflicts.push(c);
      // الرد بشكل الدعوة الناجحة: لا حقل يكشف التعارض
      return json(res, 201, { id: c.id, email: body.email, role: body.role, status: "invited", invite_token: "x".repeat(40), invite_token_expires_at: new Date().toISOString() });
    }
    if (req.method === "GET" && url.pathname === "/v1/buyer-invite-conflicts") {
      if (token === "Bearer b") return json(res, 403, { code: "forbidden_role" });
      const items = state.conflicts.filter((c) => c.state === (url.searchParams.get("state") ?? c.state));
      return json(res, 200, { items, next_cursor: null });
    }
    const m = url.pathname.match(/^\/v1\/buyer-invite-conflicts\/([^/]+)\/resolve$/);
    if (req.method === "POST" && m) {
      if (!never429 && state.failures >= limit) return json(res, 429, { code: "rate_limited" }, { "retry-after": "30" });
      const valid = new Set([-1, 0, 1].map((d) => totpCode(SECRET_HEX, Date.now() + d * 30_000)));
      if (!valid.has(body.totp_code) || state.usedCodes.has(body.totp_code)) { state.failures++; return json(res, 401, { code: "totp_required" }); }
      const c = state.conflicts.find((x) => x.id === m[1]);
      if (!c) return json(res, 404, { code: "not_found" });
      if (c.state !== "pending") return json(res, 409, { code: "invalid_transition" });
      state.usedCodes.add(body.totp_code);
      c.state = body.state;
      return json(res, 200, { ...c });
    }
    return json(res, 404, { code: "not_found" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

const envOf = (url) => ({
  ICT_API_URL: `${url}/v1`,
  ICT_TOKENS: JSON.stringify({ system_admin: "a", buyer_admin: "b", reporter: "rep" }),
  ICT_TOTP: JSON.stringify({ system_admin: SECRET_HEX }),
});

test("totpCode matches the RFC 6238 SHA-1 vector (T=59s, six digits)", () => {
  assert.equal(totpCode(SECRET_HEX, 59_000), "287082");
  assert.equal(totpCode(SECRET_HEX, 59_000 + 30_000), totpCode(SECRET_HEX, 89_000), "same step, same code");
  assert.notEqual(totpCode(SECRET_HEX, 59_000), totpCode(SECRET_HEX, 90_000), "next step, next code");
});

test("wrongCode never equals an accepted code (current or neighbouring step), even at a step boundary", () => {
  for (const t of [61_000, 89_999, 90_000, 119_999, 1_760_000_000_000]) {
    const w = wrongCode(SECRET_HEX, t);
    assert.match(w, /^[0-9]{6}$/);
    for (const d of [-1, 0, 1]) assert.notEqual(w, totpCode(SECRET_HEX, t + d * 30_000));
  }
});

test("happy path: correct code once, reuse 401, wrong codes cut at 429 with Retry-After, conflict untouched; a valid measurement", async () => {
  const { server, url } = await fakeStack({ limit: 10 });
  const { code, doc } = await quiet(() => run(["--dry-run"], envOf(url)));
  server.close();
  assert.equal(code, 0);
  assert.equal(doc.result, "partial");
  assert.equal(doc.metrics.wrong_attempts_before_429, 10, "the reuse counts as the first failure, the tenth wrong attempt hits the limit of ten");
  assert.equal(doc.metrics.retry_after_s, 30);
  assert.ok(validateMeasurement(doc).ok);
});

test("a server that never cuts off failed attempts fails the script", async () => {
  const { server, url } = await fakeStack({ never429: true });
  const { code, doc } = await quiet(() => run(["--dry-run"], { ...envOf(url), ICT_MAX_ATTEMPTS: "12" }));
  server.close();
  assert.equal(code, 1);
  assert.equal(doc.result, "fail");
});

test("without its environment the script measures nothing and exits 2; the row is in the catalog", async () => {
  assert.deepEqual(await quiet(() => run(["--dry-run"], {})), { code: 2, doc: null });
  assert.deepEqual(await quiet(() => run(["--dry-run"], { ICT_API_URL: "x", ICT_TOKENS: "{}", ICT_TOTP: "{}" })), { code: 2, doc: null });
  assert.ok(byName("invite-conflict-totp"));
});
