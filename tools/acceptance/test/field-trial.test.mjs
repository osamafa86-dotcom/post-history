import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { parseTarget, accountsFromEnv, remoteSeed } from "../lib/target.mjs";
import { totp } from "../lib/totp.mjs";
import { runPack, plan, envFor } from "../field-trial/pack.mjs";

const quiet = async (fn) => { const l = [console.log, console.error]; console.log = console.error = () => {}; try { return await fn(); } finally { [console.log, console.error] = l; } };

test("--target must be https, with plain http only for loopback", () => {
  assert.equal(parseTarget("https://trial.example.test").apiUrl, "https://trial.example.test/v1");
  assert.equal(parseTarget("http://127.0.0.1:3000").tusUrl, "http://127.0.0.1:3000/files/");
  assert.equal(parseTarget("https://h.test", { FT_TUS_URL: "https://ingest.h.test/files/" }).tusUrl, "https://ingest.h.test/files/");
  assert.throws(() => parseTarget("http://trial.example.test"), /https/);
  assert.throws(() => parseTarget("not a url"), /URL/);
});

test("accounts come from FT_ACCOUNTS; the required roles are named when missing, a password-less entry is refused", () => {
  assert.deepEqual(accountsFromEnv({}).missing, ["reporter", "reporter_b", "supervisor_b"]);
  const ok = { reporter: { email: "a@x.test", password: "p" }, reporter_b: { email: "b@x.test", password: "p" } };
  assert.deepEqual(accountsFromEnv({ FT_ACCOUNTS: JSON.stringify(ok) }).missing, ["supervisor_b"]);
  assert.throws(() => accountsFromEnv({ FT_ACCOUNTS: JSON.stringify({ reporter: { email: "a@x.test" } }) }), /needs email and password/);
  assert.throws(() => accountsFromEnv({ FT_ACCOUNTS: "{" }), /not valid JSON/);
});

test("the pack runs nothing without --confirm or without the accounts, and skips dynamic-fields unless allowed", async () => {
  assert.ok(plan({}).includes("dynamic-fields"), "dynamic-fields always runs (read-only on a trial host)");
  assert.equal(await quiet(() => runPack({ target: "https://h.test" }, {})), 2, "no --confirm");
  assert.equal(await quiet(() => runPack({ target: "https://h.test", confirm: true }, {})), 2, "no accounts");
  assert.equal(await quiet(() => runPack({ target: "http://h.test", confirm: true }, {})), 2, "plain http");
});

// a stub of the public API: just enough for the seed
const ADMIN_SECRET = "0a".repeat(20);
async function stubApi({ admin = "totp" } = {}) {
  const calls = [];
  const state = { suspended: false, adminCodes: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push(`${req.method} ${req.url}`);
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/v1/auth/login") {
        const b = JSON.parse(body), who = b.email.split("@")[0];
        if (who === "system_admin") {
          if (state.suspended) return send(401, { code: "invalid_credentials" });
          if (admin === "totp") {
            if (!b.totp_code) return send(401, { code: "totp_required" });
            state.adminCodes.push(b.totp_code);
            if (b.totp_code !== totp(ADMIN_SECRET)) return send(401, { code: "invalid_credentials" });
          }
        }
        return send(200, { access_token: `tok-${who}` });
      }
      if (req.url === "/v1/auth/logout") return send(204, {});
      if (req.url === "/v1/forms/current") return send(200, { version: 3 });
      if (req.url === "/v1/forms/2") return send(200, { version: 2 });
      if (req.url === "/v1/materials") return send(201, { id: `m-${JSON.parse(body).governorate}` });
      if (req.url.endsWith("/transitions")) return send(200, {});
      if (req.url === "/v1/notifications") return send(200, { items: [{ id: "n-1" }] });
      if (req.url === "/v1/uploads") return send(201, { id: "u-1", upload_token: "ut" });
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, calls, state, close: () => { server.close(); server.closeAllConnections(); } };
}

test("remoteSeed makes the fixtures through the API only and keeps the other office's tokens out of the role map", async () => {
  const s = await stubApi();
  try {
    const roles = ["reporter", "reporter_b", "supervisor_b", "system_admin", "producer"];
    const accounts = Object.fromEntries(roles.map((r) => [r, { email: `${r}@x.test`, password: "pw", ...(r === "system_admin" ? { totp_secret: ADMIN_SECRET } : {}) }]));
    const seed = await remoteSeed({ apiUrl: s.url, accounts, adminNeeded: true });
    assert.deepEqual(Object.keys(seed.tokens).sort(), ["producer", "reporter", "system_admin"]);
    assert.equal(seed.allTokens.reporter_b, "tok-reporter_b");
    assert.equal(seed.fixtures.other_reporter_material_id, "m-khan_younis");
    assert.equal(seed.fixtures.other_reporter_notification_id, "n-1");
    assert.equal(seed.fixtures.other_reporter_upload_id, "u-1");
    assert.equal(seed.canaries.coordinates.length, 4);
    assert.equal(seed.formVersion, 3);
    // the env each script reads
    const target = { url: "https://h.test", apiUrl: s.url, tusUrl: "https://h.test/files/" };
    const env = envFor(target, seed, accounts, {});
    assert.equal(env.UPLOAD_TOKEN, "tok-reporter");
    assert.equal(env.REVOKE_ADMIN_TOKEN, undefined, "session-revocation no longer takes an administrator token");
    assert.ok(!env.TENANT_TOKENS.includes("system_admin") && !env.PII_TOKENS.includes("system_admin"), "the matrices run without the administrator");
    assert.ok(env.DYN_TOKENS.includes("system_admin"), "only dynamic-fields (publishing a form) gets it");
    assert.ok(!env.TENANT_TOKENS.includes("reporter_b"));
    assert.equal(JSON.parse(env.PII_CANARIES).length, 4);
  } finally { s.close(); }
});

test("a failed login stops the seed and names the role, never the password", async () => {
  const server = http.createServer((_req, res) => { res.writeHead(401); res.end("{}"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(() => remoteSeed({ apiUrl: `http://127.0.0.1:${server.address().port}/v1`, accounts: { reporter: { email: "r@x.test", password: "secret-pw" } } }),
      (e) => /login failed \(401\) for reporter/.test(e.message) && !e.message.includes("secret-pw"));
  } finally { server.close(); server.closeAllConnections(); }
});

test("the administrator is not logged in unless a step needs it, and a password-only administrator is refused and logged out", async () => {
  const s = await stubApi({ admin: "none" });
  try {
    const accounts = Object.fromEntries(["reporter", "reporter_b", "supervisor_b", "system_admin"].map((r) => [r, { email: `${r}@x.test`, password: "pw" }]));
    const seed = await remoteSeed({ apiUrl: s.url, accounts });
    assert.ok(!("system_admin" in seed.allTokens), "no admin login without adminNeeded");
    await assert.rejects(() => remoteSeed({ apiUrl: s.url, accounts, adminNeeded: true }), /password alone: TOTP is not enrolled, refused/);
    assert.ok(s.calls.includes("POST /v1/auth/logout"), "the password-only session was logged out");
  } finally { s.close(); }
});

test("with TOTP enrolled the administrator logs in with a fresh code", async () => {
  const s = await stubApi();
  try {
    const accounts = { reporter: { email: "reporter@x.test", password: "pw" }, system_admin: { email: "system_admin@x.test", password: "pw" } };
    await assert.rejects(() => remoteSeed({ apiUrl: s.url, accounts, adminNeeded: true }), /needs a TOTP code for system_admin/);
  } finally { s.close(); }
});

const packAccounts = () => ({
  reporter: { email: "reporter@x.test", password: "pw" }, reporter_b: { email: "reporter_b@x.test", password: "pw" }, supervisor_b: { email: "supervisor_b@x.test", password: "pw" },
  system_admin: { email: "system_admin@x.test", password: "pw", totp_secret: ADMIN_SECRET },
});

test("publishing a form (the administrator) is refused for any host but the local machine", async () => {
  const env = { FT_ACCOUNTS: JSON.stringify(packAccounts()), FT_SUSPEND_ADMIN_CMD: "true" };
  assert.equal(await quiet(() => runPack({ target: "https://trial.example.test", confirm: true, "allow-publish-form": true }, env)), 2);
});

test("a local run that needs the administrator refuses to start without the suspend command or the account", async () => {
  const env = { FT_ACCOUNTS: JSON.stringify(packAccounts()) };
  assert.equal(await quiet(() => runPack({ target: "http://127.0.0.1:1", confirm: true, "allow-publish-form": true }, env)), 2);
  const noAdmin = packAccounts(); delete noAdmin.system_admin;
  assert.equal(await quiet(() => runPack({ target: "http://127.0.0.1:1", confirm: true, "allow-publish-form": true }, { FT_ACCOUNTS: JSON.stringify(noAdmin), FT_SUSPEND_ADMIN_CMD: "true" })), 2);
});

test("the administrator is suspended and checked at the end, also when a step throws; one still reachable is exit 1", async () => {
  for (const [label, suspends, throws, expected] of [["suspended and a step threw", true, true, 1], ["suspended and nothing failed", true, false, 0], ["still active", false, false, 1]]) {
    const s = await stubApi();
    try {
      const env = { FT_ACCOUNTS: JSON.stringify(packAccounts()), FT_SUSPEND_ADMIN_CMD: "suspend-the-admin", FT_API_URL: s.url };
      const ran = [];
      const deps = {
        runScript: async (n) => { ran.push(n); if (throws && n === "dynamic-fields") throw new Error("boom"); return { code: 0, doc: { result: "pass" } }; },
        spawn: (cmd) => { ran.push(`cmd:${cmd}`); if (suspends) s.state.suspended = true; return { status: 0 }; },
        sleep: async () => {}, now: () => Date.now(),
      };
      const code = await quiet(() => runPack({ target: s.url.replace("/v1", ""), confirm: true, "allow-publish-form": true, "out-dir": mkdtempSync(pjoin(tmpdir(), "pack-")) }, env, deps));
      assert.ok(ran.includes("cmd:suspend-the-admin"), `${label}: the suspend command ran although dynamic-fields threw`);
      assert.ok(s.calls.filter((c) => c === "POST /v1/auth/login").length >= 5, `${label}: the verification login happened`);
      assert.equal(code, expected, `${label}: exit code`);
    } finally { s.close(); }
  }
});

test("a run without --allow-publish-form never logs the administrator in nor needs the command", async () => {
  const s = await stubApi();
  try {
    const env = { FT_ACCOUNTS: JSON.stringify(packAccounts()), FT_API_URL: s.url };
    const ran = [];
    const code = await quiet(() => runPack({ target: s.url.replace("/v1", ""), confirm: true, "out-dir": mkdtempSync(pjoin(tmpdir(), "pack-")) }, env, { runScript: async (n) => { ran.push(n); return { code: 0, doc: { result: "pass" } }; }, spawn: () => { throw new Error("must not run"); } }));
    assert.equal(code, 0);
    assert.ok(ran.includes("dynamic-fields"), "read-only dynamic-fields still runs");
  } finally { s.close(); }
});

test("dynamic-fields without an administrator only reads the form and never claims the live part", async () => {
  const { run: dyn } = await import("../scripts/dynamic-fields.mjs");
  const s = await stubApi();
  try {
    const dir = mkdtempSync(pjoin(tmpdir(), "dyn-"));
    process.env.ACCEPTANCE_RESULTS_DIR = dir;
    const { code, doc } = await quiet(() => dyn(["--dry-run"], { DYN_API_URL: s.url, DYN_TOKENS: JSON.stringify({ reporter: "tok-reporter" }) }));
    assert.equal(code, 0);
    assert.equal(doc.metrics.server_read_only, true);
    assert.equal(doc.metrics.server_checked_live, false);
    assert.equal(doc.metrics.server_current_readable, true);
    assert.notEqual(doc.result, "pass");
    assert.ok(!s.calls.some((c) => c.startsWith("POST /v1/forms") || c === "POST /v1/materials"), "nothing was published or posted");
  } finally { s.close(); }
});
