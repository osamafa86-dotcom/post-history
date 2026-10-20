import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parseTarget, accountsFromEnv, remoteSeed } from "../lib/target.mjs";
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
  assert.deepEqual(accountsFromEnv({}).missing, ["reporter", "reporter_b", "supervisor_b", "system_admin"]);
  const ok = { reporter: { email: "a@x.test", password: "p" }, reporter_b: { email: "b@x.test", password: "p" } };
  assert.deepEqual(accountsFromEnv({ FT_ACCOUNTS: JSON.stringify(ok) }).missing, ["supervisor_b", "system_admin"]);
  assert.throws(() => accountsFromEnv({ FT_ACCOUNTS: JSON.stringify({ reporter: { email: "a@x.test" } }) }), /needs email and password/);
  assert.throws(() => accountsFromEnv({ FT_ACCOUNTS: "{" }), /not valid JSON/);
});

test("the pack runs nothing without --confirm or without the accounts, and skips dynamic-fields unless allowed", async () => {
  assert.ok(!plan({}).includes("dynamic-fields"));
  assert.ok(plan({ "allow-publish-form": true }).includes("dynamic-fields"));
  assert.equal(await quiet(() => runPack({ target: "https://h.test" }, {})), 2, "no --confirm");
  assert.equal(await quiet(() => runPack({ target: "https://h.test", confirm: true }, {})), 2, "no accounts");
  assert.equal(await quiet(() => runPack({ target: "http://h.test", confirm: true }, {})), 2, "plain http");
});

// a stub of the public API: just enough for the seed
async function stubApi() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push(`${req.method} ${req.url}`);
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/v1/auth/login") { const e = JSON.parse(body).email; return send(200, { access_token: `tok-${e.split("@")[0]}` }); }
      if (req.url === "/v1/forms/current") return send(200, { version: 3 });
      if (req.url === "/v1/materials") return send(201, { id: `m-${JSON.parse(body).governorate}` });
      if (req.url.endsWith("/transitions")) return send(200, {});
      if (req.url === "/v1/notifications") return send(200, { items: [{ id: "n-1" }] });
      if (req.url === "/v1/uploads") return send(201, { id: "u-1", upload_token: "ut" });
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, calls, close: () => { server.close(); server.closeAllConnections(); } };
}

test("remoteSeed makes the fixtures through the API only and keeps the other office's tokens out of the role map", async () => {
  const s = await stubApi();
  try {
    const roles = ["reporter", "reporter_b", "supervisor_b", "system_admin", "producer"];
    const accounts = Object.fromEntries(roles.map((r) => [r, { email: `${r}@x.test`, password: "pw" }]));
    const seed = await remoteSeed({ apiUrl: s.url, accounts });
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
    assert.equal(env.REVOKE_ADMIN_TOKEN, "tok-system_admin");
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
